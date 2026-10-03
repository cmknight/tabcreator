// Recording store (spine AD-3). It owns the mic: the setup → live path, the open input (kept
// across screens, so leaving Record does not close the mic), the input device list (refreshed on
// `devicechange` while live), the chosen device (`micDeviceId`) and the fallback to the default
// input when the active one is unplugged. Read it with useSyncExternalStore.
//
// Every input transition (allow, switch, the handling of an ended track) runs one at a time
// through one queue (`enqueue`), so only the running transition changes `input`. A switch that
// arrives while any transition runs is ignored; an ended track is never dropped, its handling
// queued after the transition in progress, and judged by the ended input's own device. A
// transition that opened an input the store no longer holds closes it before returning.
//
// What the live input yields is derived by three modules it composes through one contract
// (input-derivation.ts): the level warning (level-watch.ts), the input quality warning
// (input-quality-watch.ts) and the Tuner's reading and ticks (tuner-watch.ts). Each mic
// transition asks them once for their fields, so it notifies once; the reads (`readLevels`,
// `readTuner`, inside the UI's animation frame or poll) notify only when a published field
// changes, never per frame.
//
// Decision (epic 2, 2026-10-02): this store writes `micGranted` and `micDeviceId` through
// storage/prefs.ts, although AD-3 names settings-session as the prefs store.

import type { LevelsDbfs } from '../audio/level-meter';
import {
  activeDevice,
  listMics,
  micPermission,
  onDeviceChange,
  openInput,
  requestMic,
  type MicDevice,
  type MicPermission,
} from '../audio/mic';
import { AppError, isAppError, type AppErrorCode } from '../model/errors';
import { loadPrefs, updatePrefs } from '../storage/prefs';
import type { InputTransition, OpenedInput } from './input-derivation';
import { createInputQualityWatch, type InputQualityFields } from './input-quality-watch';
import { createLevelWatch, type LevelFields } from './level-watch';
import { createTunerWatch, type TunerDisplay, type TunerFields } from './tuner-watch';

export type { MicDevice } from '../audio/mic';
export type { TunerReading } from '../audio/tuner';
export { TUNER_POLL_MS } from '../audio/tuner';
export type { TunerDisplay } from './tuner-watch';

export type MicState = 'setup' | 'requesting' | 'live' | 'error';

/** A one-off fact for the shell to show; `seq` grows with each new notice. */
export interface MicNotice {
  kind: 'switched';
  /** The label of the input now in use; "" when the browser gives none. */
  label: string;
  seq: number;
}

/** The mic fields, plus the fields each input derivation owns (see input-derivation.ts). */
export interface RecordingSnapshot extends LevelFields, InputQualityFields, TunerFields {
  mic: MicState;
  /** Set in `error`; kept while a Try again is `requesting`, so the error card stays in place. */
  errorCode?: AppErrorCode;
  /** The selectable audio inputs; only filled while `live`. */
  devices: readonly MicDevice[];
  /** The listed device the live input runs on (or is switching to); null when not live. */
  activeDeviceId: string | null;
  /** The latest notice; kept until the next one replaces it. */
  notice?: MicNotice;
}

export interface RecordingSession {
  subscribe(listener: () => void): () => void;
  getSnapshot(): RecordingSnapshot;
  /**
   * Requests the mic (the Allow microphone or Try again click), on the saved device when there
   * is one, else (or when it is gone) the default. A no-op while requesting or live.
   */
  allowMic(): Promise<void>;
  /**
   * On entering a mic screen: from `setup` only, requests the mic without a click when the mic
   * was granted before (`micGranted`) and the browser still reports the permission `granted`.
   * Otherwise does nothing, so the setup card asks first. Never retries from `error`.
   */
  resume(): Promise<void>;
  /**
   * While live, switches to the listed device `deviceId`: closes the current input, opens that
   * device exactly and saves it as `micDeviceId`. A no-op when not live, while any input
   * transition (an allow, a switch or an ended track's handling) runs, or for the device already
   * active. A failure shows its error card.
   */
  selectMic(deviceId: string): Promise<void>;
  /**
   * Peak and RMS in dBFS of the live input's current frame, and advances the level warning to
   * `now` (a monotonic clock, ms). Silence (`-Infinity`) when the mic is not live. Notifies
   * subscribers only when the warning changes.
   */
  readLevels(now: number): LevelsDbfs;
  /**
   * The Tuner's reading for the live input's current frame at `now` (a monotonic clock, ms):
   * detects the pitch at the analyser's sample rate and advances the tuner machine. Null when
   * the mic is not live. After a gap of more than 500 ms between reads the machine starts
   * afresh; ticked strings are kept. Notifies subscribers only when a string first ticks.
   */
  readTuner(now: number): TunerDisplay | null;
  /** The live input's analyser, for the meter and tuner slices; null when not live. */
  getAnalyser(): AnalyserNode | null;
  /** Hides the input quality warning until the page reloads, whatever input is chosen. */
  dismissInputQuality(): void;
}

/** The shell functions the store drives; injected so tests can fake audio/ and storage/. */
export interface RecordingDeps {
  requestMic: (deviceId?: string) => Promise<MediaStream>;
  openInput: (stream: MediaStream, onEnded: (error: AppError) => void) => OpenedInput;
  listMics: () => Promise<MicDevice[]>;
  onDeviceChange: (listener: () => void) => () => void;
  updatePrefs: (patch: { micGranted?: boolean; micDeviceId?: string | null }) => unknown;
  loadPrefs: () => { micGranted: boolean; micDeviceId?: string | null };
  micPermission: () => Promise<MicPermission>;
}

const asAppError = (err: unknown) =>
  isAppError(err)
    ? err
    : new AppError('mic-failed', 'Opening the microphone failed', { cause: err });

export function createRecordingSession(deps: RecordingDeps): RecordingSession {
  // The watches publish through `patch`, which reads `snapshot` only when called (never here).
  const levels = createLevelWatch(patch);
  const quality = createInputQualityWatch(patch);
  const tuning = createTunerWatch(patch);
  const idle: InputTransition = { live: false, input: null, devices: [] };
  let snapshot: RecordingSnapshot = {
    mic: 'setup',
    devices: [],
    activeDeviceId: null,
    ...levels.transition(idle),
    ...quality.transition(idle),
    ...tuning.transition(idle),
  };
  let input: OpenedInput | null = null;
  /** The inputs already closed, so none is closed twice. */
  const closed = new WeakSet<OpenedInput>();
  /** Each opened input's listed device id as resolved when it went live (null: no match). */
  const resolvedIds = new WeakMap<OpenedInput, string | null>();
  /** The transitions waiting to run, in order; the running one has been taken off. */
  const queue: (() => void)[] = [];
  /** An input transition is running. */
  let running = false;
  /** Bumped on every device list request, so an older answer never replaces a newer one. */
  let listSeq = 0;
  let noticeSeq = 0;
  let stopDeviceChange: (() => void) | null = null;
  const listeners = new Set<() => void>();

  function notify(next: RecordingSnapshot) {
    snapshot = next;
    for (const l of listeners) l();
  }

  /** A derivation's read publishes its fields; notifies only when one of them changes. */
  function patch(fields: Partial<RecordingSnapshot>) {
    const keys = Object.keys(fields) as (keyof RecordingSnapshot)[];
    if (keys.every((k) => Object.is(fields[k], snapshot[k]))) return;
    notify({ ...snapshot, ...fields });
  }

  /** The open input while live; the derivations read nothing otherwise. */
  const liveInput = () => (snapshot.mic === 'live' ? input : null);

  /** A mic transition: builds the mic fields, then asks each derivation once for its own. */
  function set(next: {
    mic: MicState;
    errorCode?: AppErrorCode;
    devices?: readonly MicDevice[];
    activeDeviceId?: string | null;
    notice?: MicNotice;
  }) {
    const live = next.mic === 'live';
    const notice = next.notice ?? snapshot.notice;
    const devices = live ? (next.devices ?? snapshot.devices) : [];
    const t: InputTransition = { live, input: live ? input : null, devices };
    notify({
      mic: next.mic,
      ...(next.errorCode ? { errorCode: next.errorCode } : {}),
      devices,
      activeDeviceId: !live
        ? null
        : 'activeDeviceId' in next
          ? (next.activeDeviceId ?? null)
          : snapshot.activeDeviceId,
      ...(notice ? { notice } : {}),
      ...levels.transition(t),
      ...quality.transition(t),
      ...tuning.transition(t),
    });
    if (live && !stopDeviceChange) stopDeviceChange = deps.onDeviceChange(refreshDevices);
    if (!live && stopDeviceChange) {
      stopDeviceChange();
      stopDeviceChange = null;
    }
  }

  /**
   * Runs `task` after every transition already queued; at once (synchronously up to its first
   * await) when none runs. Settles as `task` does, once the next transition has started (or
   * the queue is idle), so a caller that awaits it sees the queue as it now is.
   */
  function enqueue(task: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      queue.push(() => {
        // Started synchronously (not deferred), so a transition's first notify lands within the
        // call; a synchronous throw still takes the rejection path and advances the queue.
        let started: Promise<void>;
        try {
          started = task();
        } catch (err) {
          started = Promise.reject(err);
        }
        started.then(
          () => {
            advance();
            resolve();
          },
          (err: unknown) => {
            advance();
            reject(err);
          },
        );
      });
      if (!running) advance();
    });
  }

  /** Starts the next queued transition, or marks the queue idle. */
  function advance() {
    const next = queue.shift();
    running = next !== undefined;
    next?.();
  }

  /** Closes `opened` (stops its tracks, closes its context) unless it is already closed. */
  function release(opened: OpenedInput) {
    if (closed.has(opened)) return;
    closed.add(opened);
    opened.close();
  }

  const readLevels = (now: number): LevelsDbfs => levels.read(liveInput(), now);

  const readTuner = (now: number): TunerDisplay | null => tuning.read(liveInput(), now);

  async function listDevices(): Promise<MicDevice[]> {
    try {
      return await deps.listMics();
    } catch {
      return [];
    }
  }

  /** The listed id of `opened`'s device, or its own id when it is not listed. */
  const activeId = (opened: OpenedInput, devices: readonly MicDevice[]) =>
    activeDevice(opened, devices)?.deviceId ?? opened.deviceId;

  /**
   * Re-reads the device list while live (a `devicechange`), keeping the active id resolved and
   * the quality warning current (a relabelled input).
   */
  async function refreshDevices() {
    const seq = ++listSeq;
    const devices = await listDevices();
    if (seq !== listSeq || snapshot.mic !== 'live') return;
    const settled = input && !running ? input : null;
    const activeDeviceId = settled ? activeId(settled, devices) : snapshot.activeDeviceId;
    // Keep the ended-track judgement current: a device listed only now resolves the input.
    const resolved = settled ? activeDevice(settled, devices)?.deviceId : undefined;
    if (settled && resolved) resolvedIds.set(settled, resolved);
    notify({
      ...snapshot,
      devices,
      activeDeviceId,
      ...quality.devicesChanged({ input: settled, devices }),
    });
  }

  /** Opens `stream` as the live input, then lists the devices. Throws `AppError`. */
  async function goLive(stream: MediaStream): Promise<{
    opened: OpenedInput;
    devices: MicDevice[];
    activeDeviceId: string | null;
  }> {
    const opened = deps.openInput(stream, () => {
      // The queue has already advanced past a failed handling; nothing is left to do with it.
      enqueue(() => ended(opened)).catch(() => {});
    });
    closed.delete(opened);
    input = opened;
    ++listSeq;
    const devices = await listDevices();
    resolvedIds.set(opened, activeDevice(opened, devices)?.deviceId ?? null);
    return { opened, devices, activeDeviceId: activeId(opened, devices) };
  }

  /**
   * Whether `opened` is still the store's input; when not, closes it. Transitions run one at a
   * time, so this is a guard: only the running one changes `input`. A function, so TypeScript
   * does not narrow `input` across the awaits.
   */
  function holds(opened: OpenedInput): boolean {
    if (input === opened) return true;
    release(opened);
    return false;
  }

  /**
   * The device an ended input ran on: its listed id as resolved when it went live, else its
   * track's id when that is a real one (not Chrome's `default` or `communications` alias), else
   * null (unresolved).
   */
  function endedDeviceId(opened: OpenedInput): string | null {
    const resolved = resolvedIds.get(opened);
    if (resolved) return resolved;
    const own = opened.deviceId;
    return own && own !== 'default' && own !== 'communications' ? own : null;
  }

  function savePrefs(patch: { micGranted?: boolean; micDeviceId?: string | null }) {
    try {
      deps.updatePrefs(patch);
    } catch {
      // The mic works; a prefs write failure only loses the remembered hint.
    }
  }

  /** Requests the saved device, or the default when there is none or it is gone. */
  async function requestPreferred(): Promise<MediaStream> {
    let saved: string | null = null;
    try {
      saved = deps.loadPrefs().micDeviceId ?? null;
    } catch {
      // Unreadable prefs: use the default input.
    }
    if (!saved) return deps.requestMic();
    try {
      return await deps.requestMic(saved);
    } catch (err) {
      if (!isAppError(err) || err.code !== 'mic-no-device') throw err;
    }
    savePrefs({ micDeviceId: null });
    return deps.requestMic();
  }

  function allowMic(): Promise<void> {
    if (snapshot.mic === 'requesting' || snapshot.mic === 'live') return Promise.resolve();
    return enqueue(allow);
  }

  async function allow() {
    // Re-checked: a transition queued ahead of this one may have gone live.
    if (snapshot.mic === 'requesting' || snapshot.mic === 'live') return;
    set(
      snapshot.errorCode
        ? { mic: 'requesting', errorCode: snapshot.errorCode }
        : { mic: 'requesting' },
    );
    let live;
    try {
      live = await goLive(await requestPreferred());
    } catch (err) {
      input = null;
      set({ mic: 'error', errorCode: asAppError(err).code });
      return;
    }
    if (!holds(live.opened)) return;
    savePrefs({ micGranted: true });
    set({ mic: 'live', devices: live.devices, activeDeviceId: live.activeDeviceId });
  }

  function selectMic(deviceId: string): Promise<void> {
    if (snapshot.mic !== 'live' || running || deviceId === snapshot.activeDeviceId) {
      return Promise.resolve();
    }
    return enqueue(() => switchTo(deviceId));
  }

  async function switchTo(deviceId: string) {
    // Close (stop the tracks) before asking for the new device; the select shows the choice.
    const old = input;
    input = null;
    if (old) release(old);
    set({ mic: 'live', activeDeviceId: deviceId });
    let live;
    try {
      live = await goLive(await deps.requestMic(deviceId));
    } catch (err) {
      input = null;
      set({ mic: 'error', errorCode: asAppError(err).code });
      return;
    }
    if (!holds(live.opened)) return;
    savePrefs({ micDeviceId: deviceId });
    set({ mic: 'live', devices: live.devices, activeDeviceId: live.activeDeviceId });
  }

  /**
   * A track ended on its own (queued: runs after the transition in progress). When the input
   * is no longer the store's, it is only closed. Otherwise, when its device is no longer listed
   * and another remains (an unplug), open the default input and post a `switched` notice; else
   * (a revoke, the only device gone, or a device that cannot be resolved) close the input and
   * show the lost card.
   */
  async function ended(endedInput: OpenedInput) {
    if (!holds(endedInput)) return;
    const endedId = endedDeviceId(endedInput);
    input = null;
    release(endedInput);
    ++listSeq;
    const devices = await listDevices();
    const unplugged = endedId !== null && !devices.some((d) => d.deviceId === endedId);
    if (!unplugged || devices.length === 0) {
      set({ mic: 'error', errorCode: 'mic-lost' });
      return;
    }
    let live;
    try {
      live = await goLive(await deps.requestMic());
    } catch (err) {
      input = null;
      set({ mic: 'error', errorCode: asAppError(err).code });
      return;
    }
    if (!holds(live.opened)) return;
    const now = activeDevice(live.opened, live.devices);
    set({
      mic: 'live',
      devices: live.devices,
      activeDeviceId: live.activeDeviceId,
      notice: {
        kind: 'switched',
        label: now?.label || live.opened.label || '',
        seq: ++noticeSeq,
      },
    });
  }

  let resuming = false;

  async function resume() {
    if (snapshot.mic !== 'setup' || resuming) return;
    resuming = true;
    try {
      let granted = false;
      try {
        granted = deps.loadPrefs().micGranted;
      } catch {
        // Unreadable prefs: treat as a first visit.
      }
      if (!granted) return;
      if ((await deps.micPermission()) !== 'granted') return;
      if (snapshot.mic !== 'setup') return;
      await allowMic();
    } finally {
      resuming = false;
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    allowMic,
    resume,
    selectMic,
    readLevels,
    readTuner,
    getAnalyser: () => input?.analyser ?? null,
    dismissInputQuality: () => quality.dismiss(),
  };
}

export const recordingSession: RecordingSession = createRecordingSession({
  requestMic,
  openInput,
  listMics,
  onDeviceChange,
  updatePrefs,
  loadPrefs,
  micPermission,
});
