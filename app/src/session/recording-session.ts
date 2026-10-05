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
//
// The take (story 3.4 onwards, spine AD-9, AD-14, AD-15): the take lifecycle module
// (take-lifecycle.ts) owns the take in progress and the recording state machine, from the start
// of a take (with or without a count-in) through its chunks, its length limits and its failure
// stops to its save; the store composes it as it composes recovery, handing it the snapshot, the
// input and the transition queue. `record()` and the save of `stop('user')` run through the
// queue, so an ended track is handled only between them; an ended track's handling first lets the
// lifecycle stop and save a take on that input (`mic-lost`), then applies the idle rule for the
// mic, posting a `stopped-saved` notice instead of `switched` when the take was saved, and no
// notice of its own when the take posted one (a too-short or failed-save notice stays). This store
// reads and writes the `countIn` pref (the same epic 2 decision as the mic prefs), and resolves
// the take's length limits (`MAX_TAKE_MS`, `WARN_LEAD_MS`; in dev builds
// `?maxTakeMs=<n>&warnLeadMs=<n>` override them).
//
// Handover (story 3.10, US-8.5, spine AD-6): `releaseForHandover()` runs when this tab gives the
// instance lock to another tab. A recording (or stopping) take is stopped and saved through the
// stop pipeline with `stopReason: 'instance-lost'` (no navigation; when the save fails the take
// stays `recording` for recovery), a count-in is cancelled, and the input is released. From then
// on the store is handed over: it opens no input and starts no take.
//
// Recovery (story 3.11, US-3.2, spine AD-15): the recovery module (recording-recovery.ts) scans
// for unfinished takes once the instance lock is held (`scanForRecovery`), never touching this
// tab's own take; the offered takes are the snapshot's `recovered`, rebuilt by
// `openRecovered` or deleted by `discardRecovered`. While a take counts in, records or saves,
// a `beforeunload` guard asks before the page is left.
//
// Busy (story 5.2): `isBusy()` is the one answer to "may the page go now?": a take counting in,
// starting, recording or stopping, a failed stop's after-work (the re-offer), or a recovered
// take being rebuilt. The `beforeunload` guard and app-reload.ts both read it. After a handover
// the guard disarms once the handover's save has finished or its deadline
// (`HANDOVER_WAIT_MS`) has passed: the take is then the other tab's to recover.

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
import { encodePcm, encodeWavBlob, WAV_MIME } from '../audio/encode';
import { devEncodePcm } from '../dev/hooks/recovery';
import { readDevLimits } from '../dev/hooks/recording';
import { AppError, isAppError, type AppErrorCode } from '../model/errors';
import { MAX_TAKE_MS, WARN_LEAD_MS, type TakeLimits } from '../model/take-limits';
import type { AnalysisSettings, StopReason, Take } from '../model/types';
import { audioStore, type RawWriter } from '../storage/audio-store';
import { db, type TakePatch } from '../storage/db';
import { loadPrefs, updatePrefs } from '../storage/prefs';
import type { InputTransition, OpenedInput } from './input-derivation';
import { createInputQualityWatch } from './input-quality-watch';
import { createLevelWatch } from './level-watch';
import { createRecordingRecovery, type RecoveryDeps } from './recording-recovery';
import type { CountInPrefs, MicNotice, MicState, RecordingSnapshot } from './recording-types';
import { createTakeLifecycle } from './take-lifecycle';
import { createTunerWatch, type TunerDisplay } from './tuner-watch';

export { TUNER_POLL_MS } from '../audio/tuner';
export type { TunerDisplay } from './tuner-watch';
export type { RecoveredTake } from './recording-recovery';
export { takeTitle } from './take-lifecycle';

/** The count-in tempo range, BPM (EXPERIENCE.md Count-in controls). */
export const COUNT_IN_BPM_MIN = 40;
export const COUNT_IN_BPM_MAX = 240;
const DEFAULT_COUNT_IN: CountInPrefs = { on: false, bpm: 100 };
/**
 * How long a handover waits for this store's release (`releaseForHandover`), ms: the instance
 * lock cuts it off then (instance-lock.ts re-exports it), and the unload guard disarms.
 */
export const HANDOVER_WAIT_MS = 3000;

/**
 * A typed tempo as stored: rounded to a whole BPM and clamped to 40–240; `fallback` when it is
 * not a number at all.
 */
function clampBpm(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(COUNT_IN_BPM_MAX, Math.max(COUNT_IN_BPM_MIN, Math.round(value)));
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
  /**
   * Starts a take: while live with no take in progress (and no input transition running), sets
   * `starting`, creates the take and starts the capture, then `recording`. A no-op otherwise.
   * Never rejects: a failure stops the capture, creates no take (unless storage already did)
   * and shows the error card with its code; a `storage-full` instead shows the storage-full
   * banner and keeps the mic live.
   */
  record(): Promise<void>;
  /**
   * Stops the take while `recording`: sets `stopping`, saves it, patches it `recorded` with
   * `stopReason`, then navigates to its Tab (not after a handover). A too-short take is deleted
   * instead, with a `too-short` notice and no navigation; a save that fails posts a
   * `save-failed` notice, keeps the mic live and offers the take for recovery. While `starting`
   * the Stop is held and runs once the take records. During a count-in, cancels it: the clicks
   * are cancelled, the capture aborted, no take is created and the state returns to `idle`. A
   * no-op otherwise. Never rejects.
   */
  stop(reason: Extract<StopReason, 'user'>): Promise<void>;
  /** Audio-clock time the take has recorded so far, in ms; 0 with no capture running. */
  readElapsedMs(): number;
  /**
   * The count-in's beat number as shown, counting down: 4 on beat 1, 3, 2, then 1 on beat 4
   * until the capture opens. Null when no count-in runs. Read on demand; never notifies.
   */
  readCountInBeat(): number | null;
  /**
   * Changes and saves the count-in pref (`countIn` in prefs). A tempo is clamped to 40–240 BPM
   * and rounded; a non-number keeps the current one. A no-op unless `idle`.
   */
  setCountIn(patch: Partial<CountInPrefs>): void;
  /**
   * Gives the mic and any take up for another tab (the instance lock's handover): cancels a
   * count-in; stops a recording or stopping take and saves it as `instance-lost` (no
   * navigation); then closes the input (`mic` back to `setup`). Afterwards the store opens no
   * input and starts no take. Resolves when done (the same promise on a repeat call); never
   * rejects.
   */
  releaseForHandover(): Promise<void>;
  /**
   * The recovery scan (once the instance lock is held): removes orphan files and too-short
   * unfinished takes, and offers the other unfinished takes in `recovered`. A no-op after a
   * handover; never rejects.
   */
  scanForRecovery(): Promise<void>;
  /** Open on a recovered take: rebuilds its audio, saves it `recovered`, opens its Tab. */
  openRecovered(id: string): Promise<void>;
  /**
   * Discard on a recovered take: deletes it and its files; `deleted` runs after the delete,
   * before its entry leaves `recovered`.
   */
  discardRecovered(id: string, deleted?: () => void): Promise<void>;
  /**
   * Whether leaving or reloading the page now would lose work: a take counting in, starting,
   * recording or stopping, a failed stop's re-offer still running, or a recovered take being
   * rebuilt. The `beforeunload` guard and app-reload.ts both ask this.
   */
  isBusy(): boolean;
}

/** The shell functions the store drives; injected so tests can fake audio/ and storage/. */
export interface RecordingDeps {
  requestMic: (deviceId?: string) => Promise<MediaStream>;
  openInput: (stream: MediaStream, onEnded: (error: AppError) => void) => OpenedInput;
  listMics: () => Promise<MicDevice[]>;
  onDeviceChange: (listener: () => void) => () => void;
  updatePrefs: (patch: {
    micGranted?: boolean;
    micDeviceId?: string | null;
    countIn?: CountInPrefs;
  }) => unknown;
  loadPrefs: () => {
    micGranted: boolean;
    micDeviceId?: string | null;
    countIn?: CountInPrefs;
    analysisDefaults: AnalysisSettings;
  };
  micPermission: () => Promise<MicPermission>;
  createTake: (take: Take) => Promise<unknown>;
  patchTake: (id: string, patch: TakePatch, writer: 'recording-session') => Promise<unknown>;
  openRawWriter: (takeId: string) => Promise<RawWriter>;
  writeCompressed: (takeId: string, blob: Blob) => Promise<void>;
  /** Deletes a take's record and its raw and compressed files (a too-short take). */
  deleteTake: (id: string, writer: 'recording-session') => Promise<unknown>;
  /** Opens the take's Tab screen (`#/tab/<id>`). */
  navigate: (takeId: string) => void;
  /** The wall clock, ms since the epoch (`Date.now`). */
  now: () => number;
  /** A new take id (`crypto.randomUUID`). */
  newId: () => string;
  /** The length limits; `MAX_TAKE_MS` and `WARN_LEAD_MS` when absent (dev overrides only). */
  limits?: TakeLimits;
  /** Recovery's storage and encoding; absent, the scan finds nothing (tests of other parts). */
  recovery?: RecoveryDeps;
  /**
   * Adds the `beforeunload` handler (the guard while a take runs); returns its removal. Absent,
   * no guard is set.
   */
  addUnloadGuard?: (handler: (event: BeforeUnloadEvent) => void) => () => void;
}

/** Recovery deps that find nothing (a store created without `recovery`). */
const NO_RECOVERY: RecoveryDeps = {
  listTakes: () => Promise.resolve([]),
  getTake: () => Promise.resolve(null),
  listRaw: () => Promise.resolve([]),
  listCompressed: () => Promise.resolve([]),
  rawSampleCount: () => Promise.resolve(0),
  readRaw: () => Promise.reject(new AppError('audio-missing', 'No recovery storage')),
  readCompressed: () => Promise.resolve(null),
  deleteRaw: () => Promise.resolve(),
  deleteAudio: () => Promise.resolve(),
  encodePcm: () => Promise.reject(new AppError('storage-failed', 'No encoder')),
  encodeWav: () => new Blob([], { type: WAV_MIME }),
};

/** The `beforeunload` guard: asks before the page is left. */
function guardUnload(event: BeforeUnloadEvent) {
  event.preventDefault();
  // Older browsers ask only when `returnValue` is set.
  event.returnValue = true;
}

/** The stored count-in pref, or the default when prefs are unreadable or lack it. */
function loadCountIn(deps: Pick<RecordingDeps, 'loadPrefs'>): CountInPrefs {
  try {
    const stored = deps.loadPrefs().countIn;
    if (stored && typeof stored.on === 'boolean' && typeof stored.bpm === 'number') {
      return { on: stored.on, bpm: clampBpm(stored.bpm, DEFAULT_COUNT_IN.bpm) };
    }
  } catch {
    // Unreadable prefs: the defaults.
  }
  return { ...DEFAULT_COUNT_IN };
}

const asAppError = (err: unknown) =>
  isAppError(err)
    ? err
    : new AppError('mic-failed', 'Opening the microphone failed', { cause: err });

export function createRecordingSession(deps: RecordingDeps): RecordingSession {
  const maxTakeMs = deps.limits?.capMs ?? MAX_TAKE_MS;
  const warnLeadMs = Math.min(deps.limits?.leadMs ?? WARN_LEAD_MS, maxTakeMs);
  // The watches publish through `patch`, which reads `snapshot` only when called (never here).
  const levels = createLevelWatch(patch);
  const quality = createInputQualityWatch(patch);
  const tuning = createTunerWatch(patch);
  const idle: InputTransition = { live: false, input: null, devices: [] };
  let snapshot: RecordingSnapshot = {
    mic: 'setup',
    devices: [],
    activeDeviceId: null,
    recording: 'idle',
    activeTakeId: null,
    countIn: loadCountIn(deps),
    nearLimit: false,
    savedSeq: 0,
    storageFull: false,
    recovered: [],
    handoverTake: null,
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
  /** The handover in progress or done (`releaseForHandover`); null before one. */
  let handover: Promise<void> | null = null;

  /** The take lifecycle (take-lifecycle.ts): the take in progress and the recording state. */
  const take = createTakeLifecycle(
    deps,
    {
      snapshot: () => snapshot,
      input: () => input,
      handedOver: () => handover !== null,
      patch,
      enqueue,
      nextNoticeSeq: () => ++noticeSeq,
      failInput(err) {
        const opened = input;
        input = null;
        if (opened) release(opened);
        micFailed(isAppError(err) ? err.code : 'storage-failed');
      },
      reoffer: (id) => recovery.reoffer(id),
      busyChanged: () => syncUnloadGuard(),
    },
    { capMs: maxTakeMs, leadMs: warnLeadMs },
  );

  /** Removes the `beforeunload` guard; set only while busy. */
  let removeUnloadGuard: (() => void) | null = null;
  /**
   * A handover's save has finished or its deadline has passed: the guard stays off (the tab no
   * longer runs the app; a take still being saved is the other tab's to recover).
   */
  let handoverSettled = false;

  function notify(next: RecordingSnapshot) {
    snapshot = next;
    syncUnloadGuard();
    for (const l of listeners) l();
  }

  /** See `RecordingSession.isBusy`. */
  function isBusy(): boolean {
    return take.state() !== 'idle' || take.settling() || snapshot.recovered.some((t) => t.opening);
  }

  /**
   * The guard is on while the store is busy (`isBusy`; a recovered take's rebuild is a real-time
   * encode a reload would lose), until a handover has settled.
   */
  function syncUnloadGuard() {
    const on = isBusy() && !handoverSettled;
    if (on && !removeUnloadGuard && deps.addUnloadGuard) {
      removeUnloadGuard = deps.addUnloadGuard(guardUnload);
    } else if (!on && removeUnloadGuard) {
      removeUnloadGuard();
      removeUnloadGuard = null;
    }
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
      recording: take.state(),
      activeTakeId: take.publishedTakeId(),
      countIn: snapshot.countIn,
      nearLimit: take.nearLimit(),
      savedSeq: snapshot.savedSeq,
      storageFull: snapshot.storageFull,
      ...(snapshot.storageFullSaved !== undefined
        ? { storageFullSaved: snapshot.storageFullSaved }
        : {}),
      recovered: snapshot.recovered,
      handoverTake: snapshot.handoverTake,
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
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        // Started synchronously (not deferred), so a transition's first notify lands within the
        // call; a synchronous throw still takes the rejection path and advances the queue.
        let started: Promise<T>;
        try {
          started = task();
        } catch (err) {
          started = Promise.reject(err);
        }
        started.then(
          (value) => {
            advance();
            resolve(value);
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
      // A count-in on this input ends now, not after the wait for its capture start.
      take.inputEnding(opened);
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
   * An input transition failed: the error card with `code`. After a handover the store shows no
   * card (the tab no longer runs the app): the mic stays `setup`.
   */
  function micFailed(code: AppErrorCode) {
    set(handover ? { mic: 'setup' } : { mic: 'error', errorCode: code });
  }

  /** `holds` for an input just opened: after a handover (`releaseForHandover`) none is kept. */
  function keeps(opened: OpenedInput): boolean {
    if (handover && input === opened) input = null;
    return holds(opened);
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
    if (handover) return Promise.resolve();
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
      micFailed(asAppError(err).code);
      return;
    }
    if (!keeps(live.opened)) return;
    savePrefs({ micGranted: true });
    set({ mic: 'live', devices: live.devices, activeDeviceId: live.activeDeviceId });
  }

  function selectMic(deviceId: string): Promise<void> {
    if (
      handover ||
      snapshot.mic !== 'live' ||
      running ||
      take.state() !== 'idle' ||
      deviceId === snapshot.activeDeviceId
    ) {
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
      micFailed(asAppError(err).code);
      return;
    }
    if (!keeps(live.opened)) return;
    savePrefs({ micDeviceId: deviceId });
    set({ mic: 'live', devices: live.devices, activeDeviceId: live.activeDeviceId });
  }

  /**
   * A track ended on its own (queued: runs after the transition in progress). When the input
   * is no longer the store's, it is only closed. A take recording on it is first stopped and
   * saved as `mic-lost` (the stop pipeline, before the input is released, with no navigation;
   * too short it is deleted). Then, when its device is no longer listed and another remains (an
   * unplug), open the default input and post a `switched` notice (`stopped-saved` when a take
   * was saved; none when the take posted its own, too short or not saved, so that one stays);
   * else (a revoke, the only device gone, or a device that cannot be resolved) close the input
   * and show the lost card.
   */
  async function ended(endedInput: OpenedInput) {
    if (!holds(endedInput)) return;
    // Already inside the queue: the take's stop pipeline runs here, not re-enqueued.
    const outcome = await take.inputEnded(endedInput);
    const endedId = endedDeviceId(endedInput);
    input = null;
    release(endedInput);
    ++listSeq;
    const devices = await listDevices();
    const unplugged = endedId !== null && !devices.some((d) => d.deviceId === endedId);
    if (!unplugged || devices.length === 0) {
      micFailed('mic-lost');
      return;
    }
    let live;
    try {
      live = await goLive(await deps.requestMic());
    } catch (err) {
      input = null;
      micFailed(asAppError(err).code);
      return;
    }
    if (!keeps(live.opened)) return;
    const now = activeDevice(live.opened, live.devices);
    // A too-short or failed-save notice from the take is not replaced: it says more.
    const tookNotice = outcome === 'short' || outcome === 'failed';
    set({
      mic: 'live',
      devices: live.devices,
      activeDeviceId: live.activeDeviceId,
      ...(tookNotice
        ? {}
        : {
            notice:
              outcome === 'saved'
                ? { kind: 'stopped-saved', seq: ++noticeSeq }
                : {
                    kind: 'switched',
                    label: now?.label || live.opened.label || '',
                    seq: ++noticeSeq,
                  },
          }),
    });
  }

  function record(): Promise<void> {
    if (handover || snapshot.mic !== 'live' || running || take.state() !== 'idle' || !input) {
      return Promise.resolve();
    }
    return enqueue(() => take.start()).catch(() => {});
  }

  function setCountIn(change: Partial<CountInPrefs>) {
    if (take.state() !== 'idle') return;
    const current = snapshot.countIn;
    const next: CountInPrefs = {
      on: change.on ?? current.on,
      bpm: change.bpm === undefined ? current.bpm : clampBpm(change.bpm, current.bpm),
    };
    if (next.on === current.on && next.bpm === current.bpm) return;
    try {
      deps.updatePrefs({ countIn: next });
    } catch {
      // The control still works this session; only remembering it is lost.
    }
    patch({ countIn: next });
  }

  function settleHandover() {
    handoverSettled = true;
    syncUnloadGuard();
  }

  function releaseForHandover(): Promise<void> {
    if (handover) return handover;
    // A count-in is cancelled; a recording take is marked stopping now, so the cap or a full
    // disk does not queue a save of its own first.
    take.beginHandover();
    // Idle: nothing to wait for (an allow waiting on a permission prompt must not hold it up).
    // Its outcome is published for the lost tab's notice once it settles (story 5.3).
    const saving =
      take.state() === 'idle'
        ? Promise.resolve()
        : enqueue(() => take.finishForHandover()).then(
            (outcome) => {
              if (outcome === 'saved' || outcome === 'failed') patch({ handoverTake: outcome });
            },
            () => patch({ handoverTake: 'failed' }),
          );
    // The guard disarms when the save finishes, or at the deadline the lock waits for it.
    const deadline = setTimeout(settleHandover, HANDOVER_WAIT_MS);
    handover = saving.then(() => {
      clearTimeout(deadline);
      settleHandover();
      const opened = input;
      input = null;
      if (opened) release(opened);
      set({ mic: 'setup' });
    });
    return handover;
  }

  const recovery = createRecordingRecovery(deps.recovery ?? NO_RECOVERY, {
    activeTakeId: () => take.activeTakeId(),
    isRecording: () => take.state() !== 'idle',
    handedOver: () => handover !== null,
    publish: (recovered) => patch({ recovered }),
    writeCompressed: (id, blob) => deps.writeCompressed(id, blob),
    patchTake: (id, fields, writer) => deps.patchTake(id, fields, writer),
    deleteTake: (id, writer) => deps.deleteTake(id, writer),
    navigate: (id) => deps.navigate(id),
  });

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
    record,
    stop: (reason) => take.stop(reason),
    readElapsedMs: () => take.readElapsedMs(),
    readCountInBeat: () => take.readCountInBeat(),
    setCountIn,
    releaseForHandover,
    scanForRecovery: () => recovery.scan(),
    openRecovered: (id) => recovery.open(id),
    discardRecovered: (id, deleted) => recovery.discard(id, deleted),
    isBusy,
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
  createTake: (take) => db.createTake(take),
  patchTake: (id, patch, writer) => db.patchTake(id, patch, writer),
  openRawWriter: (takeId) => audioStore.openRawWriter(takeId),
  writeCompressed: (takeId, blob) => audioStore.writeCompressed(takeId, blob),
  deleteTake: (id, writer) => db.deleteTake(id, writer),
  recovery: {
    listTakes: () => db.listTakes(),
    getTake: (id) => db.getTake(id),
    listRaw: () => audioStore.listRaw(),
    listCompressed: () => audioStore.listCompressed(),
    rawSampleCount: (id) => audioStore.rawSampleCount(id),
    readRaw: (id) => audioStore.readRaw(id),
    readCompressed: (id) => audioStore.readCompressed(id),
    deleteRaw: (id) => audioStore.deleteRaw(id),
    deleteAudio: (id) => audioStore.deleteAudio(id),
    // Dev builds only: the re-encode failure hook (dev/hooks/recovery.ts) tree-shakes out.
    encodePcm: import.meta.env.DEV ? devEncodePcm(encodePcm) : encodePcm,
    encodeWav: encodeWavBlob,
  },
  addUnloadGuard: (handler) => {
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  },
  // The `tab` route's hash (ui/router.ts routeToHash); session/ may not import ui/.
  navigate: (takeId) => {
    window.location.hash = `#/tab/${encodeURIComponent(takeId)}`;
  },
  now: () => Date.now(),
  newId: () => crypto.randomUUID(),
  // Dev builds only: production builds replace the condition with `false`, so the override and
  // its query parameter names tree-shake out (the `TakeLimits` fields are named apart from them,
  // so the dist check for the parameter names stays meaningful).
  ...(import.meta.env.DEV ? { limits: readDevLimits(window.location.search) } : {}),
});
