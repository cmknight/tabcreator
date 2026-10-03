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
// Recording (story 3.4, spine AD-9, AD-14, AD-15): `record()` creates the take at the click
// and starts the live input's capture; raw chunks are appended through the raw writer in order,
// those that arrive before the take and writer exist held and appended first. `stop('user')`
// stops the capture, saves the compressed copy, closes the raw writer, patches the take
// `recorded`, then navigates to its Tab. Both run through the transition queue, so an ended
// track is handled only between them; one that ends mid-take leaves the take `recording` with
// its raw chunks for recovery.
//
// Count-in (story 3.6, US-3.3, spine AD-9): with the `countIn` pref on, `record()` enters
// `count-in`: it reads the click's audio-clock time, schedules four clicks on the input's clock
// (audio/metronome.ts, speakers only) and starts the capture to open exactly on beat five. The
// take is created only when the audio clock reaches that time, with `countInBpm`; chunks before
// it resolves are held as above. During the count-in `stop()` cancels it (clicks cancelled,
// capture aborted, no take). This store also reads and writes the `countIn` pref (the same
// epic 2 decision as the mic prefs).
//
// Length cap and short takes (story 3.7, CAP-5, CAP-25, spine AD-9): a take is capped at
// `MAX_TAKE_MS`. Its capture's stop is scheduled when the capture starts, on the audio clock at
// exactly `startTime + MAX_TAKE_MS`, so no timer can extend it; when that stop completes the
// store saves the take with `stopReason: 'max-length'` (it stays `recording`, so Stop works,
// until then). When its audio-clock time reaches `MAX_TAKE_MS − WARN_LEAD_MS` the snapshot's
// `nearLimit` turns on (one notify; a wall-clock timer that re-reads the audio clock). A take
// stopped under `MIN_TAKE_MS` is deleted (record and files)
// with a `too-short` notice and no navigation. Each saved take bumps `savedSeq`, so the shell
// can announce it. In dev builds `?maxTakeMs=<n>&warnLeadMs=<n>` override the two limits.
//
// Clipping (US-1.3, spine AD-14): the capture reports each chunk's clipped samples (|x| at or
// above the meter's Too loud threshold); the take's total is kept in memory as `clipCount`, and
// every saved take's stop patch carries `clipped: clipCount > 0`.

import type { LevelsDbfs } from '../audio/level-meter';
import {
  activeDevice,
  type Capture,
  listMics,
  micPermission,
  onDeviceChange,
  openInput,
  requestMic,
  type MicDevice,
  type MicPermission,
} from '../audio/mic';
import { COUNT_IN_BEATS, countInSchedule } from '../audio/metronome';
import { RECORDING_MIME } from '../audio/recorder';
import { AppError, isAppError, type AppErrorCode } from '../model/errors';
import type { AnalysisSettings, StopReason, Take } from '../model/types';
import { audioStore, type RawWriter } from '../storage/audio-store';
import { db, type TakePatch } from '../storage/db';
import { DEFAULT_PREFS, loadPrefs, updatePrefs } from '../storage/prefs';
import type { InputTransition, OpenedInput } from './input-derivation';
import { createInputQualityWatch, type InputQualityFields } from './input-quality-watch';
import { createLevelWatch, type LevelFields } from './level-watch';
import { createTunerWatch, type TunerDisplay, type TunerFields } from './tuner-watch';

export type { MicDevice } from '../audio/mic';
export type { TunerReading } from '../audio/tuner';
export { TUNER_POLL_MS } from '../audio/tuner';
export type { TunerDisplay } from './tuner-watch';

export type MicState = 'setup' | 'requesting' | 'live' | 'error';

/**
 * Where a take is: none, counting in (no take yet), being created, capturing, or being saved.
 */
export type RecordingState = 'idle' | 'count-in' | 'starting' | 'recording' | 'stopping';

/** The count-in pref: on or off, and its tempo. */
export interface CountInPrefs {
  on: boolean;
  bpm: number;
}

/** The count-in tempo range, BPM (EXPERIENCE.md Count-in controls). */
export const COUNT_IN_BPM_MIN = 40;
export const COUNT_IN_BPM_MAX = 240;
const DEFAULT_COUNT_IN: CountInPrefs = { on: false, bpm: 100 };
/** How long past the expected capture start the audio clock may lag before it counts as stopped. */
const CLOCK_STALL_MS = 2000;
/** The longest take, ms (CAP-5): it stops itself here. */
export const MAX_TAKE_MS = 300_000;
/** How long before the cap the "30 seconds left" warning shows, ms. */
export const WARN_LEAD_MS = 30_000;
/** The shortest take kept, ms (spine AD-9): a shorter one is deleted at stop. */
export const MIN_TAKE_MS = 500;
/** The shortest cap the dev override accepts, ms, so a max-length take is never too short. */
const DEV_MIN_CAP_MS = 1000;

/** A take's length limits, ms: the cap and the warning's lead before it. */
export interface TakeLimits {
  /** The cap (`MAX_TAKE_MS`). */
  capMs: number;
  /** The warning's lead before the cap (`WARN_LEAD_MS`). */
  leadMs: number;
}

/**
 * A typed tempo as stored: rounded to a whole BPM and clamped to 40–240; `fallback` when it is
 * not a number at all.
 */
export function clampBpm(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(COUNT_IN_BPM_MAX, Math.max(COUNT_IN_BPM_MIN, Math.round(value)));
}

/** The dev-only clock hook (story 3.6): the last count-in's times on the audio clock, in s. */
export interface RecordingClock {
  /** The click's audio-clock time (`t0`). */
  clickTime: number;
  /** When the capture opens (beat five). */
  captureStart: number;
}

declare global {
  interface Window {
    /** Dev builds only (absent from dist): set when a count-in's capture is scheduled. */
    __recordingClock?: RecordingClock;
  }
}

/** A one-off fact for the shell to show; `seq` grows with each new notice. */
export type MicNotice =
  | {
      /** The active input was unplugged and the default one is now in use. */
      kind: 'switched';
      /** The label of the input now in use; "" when the browser gives none. */
      label: string;
      seq: number;
    }
  | {
      /** A take stopped under `MIN_TAKE_MS` was deleted. */
      kind: 'too-short';
      seq: number;
    };

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
  /** The take's state; carried through mic transitions. */
  recording: RecordingState;
  /** The id of the take being recorded (or created, or saved); null while `idle` or counting in. */
  activeTakeId: string | null;
  /** The count-in pref, as the Record screen's controls show it. */
  countIn: CountInPrefs;
  /** The take in progress has reached its warning time (`maxTakeMs − warnLeadMs`). */
  nearLimit: boolean;
  /** How many takes this store has saved (`recorded`); grows by one with each. */
  savedSeq: number;
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
   * and shows the error card with its code.
   */
  record(): Promise<void>;
  /**
   * Stops the take while `recording`: sets `stopping`, saves it, patches it `recorded` with
   * `stopReason`, then navigates to its Tab. A take under `MIN_TAKE_MS` is deleted instead,
   * with a `too-short` notice and no navigation. During a count-in, cancels it: the clicks are
   * cancelled, the capture aborted, no take is created and the state returns to `idle`. A no-op
   * otherwise. Never rejects.
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
}

/** A take from `record()` until it is saved, fails or is abandoned. */
interface ActiveTake {
  id: string;
  /** The input it records; an ended track of this input abandons it. */
  input: OpenedInput;
  capture: Capture | null;
  writer: RawWriter | null;
  /** Chunks that arrived before the writer existed, in order. */
  held: Float32Array[];
  /** The raw appends, chained in order. */
  appends: Promise<void>;
  /** Samples appended to the raw file so far. */
  samples: number;
  /** Captured samples that clipped (|x| ≥ `CLIP_LEVEL`) so far; saved as `clipped` at stop. */
  clipCount: number;
  /** Set when the take is given up; later chunks are dropped. */
  abandoned: boolean;
  /** The warning's watch while recording. */
  limitTimer: ReturnType<typeof setTimeout> | undefined;
}

/** A count-in in progress: its take (not yet created), beats and cancel. */
interface CountIn {
  take: ActiveTake;
  /** The beats' audio-clock times, s. */
  beats: readonly number[];
  cancelled: boolean;
  /** Cancels the scheduled clicks. */
  cancelClicks: () => void;
  /** Ends the wait for the capture start early (a cancel). */
  wake: () => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** Runs `fn`, turning a synchronous throw into a rejection. */
function attempt<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return fn();
  } catch (err) {
    return Promise.reject(err);
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `Take YYYY-MM-DD HH:mm` in local time. */
export function takeTitle(date: Date): string {
  return (
    `Take ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
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
  /** The take in progress (counting in, starting, recording or stopping). */
  let active: ActiveTake | null = null;
  let recording: RecordingState = 'idle';
  /** The count-in in progress; set only while `count-in`. */
  let countIn: CountIn | null = null;

  /** The published take id: none while idle or counting in (no take exists yet). */
  const takeId = () => (recording === 'count-in' ? null : (active?.id ?? null));

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
      recording,
      activeTakeId: takeId(),
      countIn: snapshot.countIn,
      nearLimit: nearLimit(),
      savedSeq: snapshot.savedSeq,
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
      // A count-in on this input ends now, not after the wait for its capture start.
      if (countIn?.take.input === opened) cancelCountIn();
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
    if (
      snapshot.mic !== 'live' ||
      running ||
      recording !== 'idle' ||
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
    // Mid-take mic loss is story 3.9's; for now the take stays `recording` for recovery.
    if (active?.input === endedInput) abandon(active);
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

  /** The published `nearLimit`: kept while the take records or stops, else off. */
  const nearLimit = () =>
    (recording === 'recording' || recording === 'stopping') && snapshot.nearLimit;

  /** Publishes the recording state and the active take id; notifies only on a change. */
  function setRecording(next: RecordingState, extra: Partial<RecordingSnapshot> = {}) {
    recording = next;
    patch({ recording, activeTakeId: takeId(), nearLimit: nearLimit(), ...extra });
  }

  /**
   * While the take records: turns `nearLimit` on when its audio-clock time reaches
   * `maxTakeMs − warnLeadMs` (a timer aimed at that time that re-reads the audio clock, so it
   * never acts early), and saves it as `max-length` when its capture stops itself at the cap.
   */
  function watchLimits(take: ActiveTake) {
    const capture = take.capture;
    if (!capture) return;
    const warnAt = maxTakeMs - warnLeadMs;
    const tick = () => {
      take.limitTimer = undefined;
      if (active !== take || take.abandoned || recording !== 'recording') return;
      const elapsed = capture.elapsedMs();
      if (elapsed >= warnAt) {
        if (!snapshot.nearLimit) patch({ nearLimit: true });
        return;
      }
      take.limitTimer = setTimeout(tick, Math.max(1, Math.ceil(warnAt - elapsed)));
    };
    tick();
    void capture.capped.then(() => {
      // A Stop (or a failure) came first: that path saves (or keeps) the take.
      if (active !== take || take.abandoned || recording !== 'recording') return;
      stopWatchingLimits(take);
      setRecording('stopping');
      enqueue(() => finishTake('max-length')).catch(() => {});
    });
  }

  function stopWatchingLimits(take: ActiveTake) {
    clearTimeout(take.limitTimer);
    take.limitTimer = undefined;
  }

  /** A captured chunk: counted, then appended (or held until the writer exists). */
  function onChunk(take: ActiveTake, samples: Float32Array, clipped: number) {
    if (take.abandoned) return;
    take.clipCount += clipped;
    if (take.writer) appendRaw(take, take.writer, samples);
    else take.held.push(samples);
  }

  function appendRaw(take: ActiveTake, writer: RawWriter, samples: Float32Array) {
    take.appends = take.appends
      .then(() => writer.append(samples))
      // Counted once written, so `durationMs` never exceeds the raw file.
      .then(() => {
        take.samples += samples.length;
      })
      .catch(() => {
        // Failure stops are a later story; the chain goes on with the next chunk.
      });
  }

  /** Gives the take up (its input is going away): drops the capture, closes the writer. */
  function abandon(take: ActiveTake) {
    take.abandoned = true;
    stopWatchingLimits(take);
    take.capture?.abort();
    const writer = take.writer;
    void take.appends.then(() => writer?.close()).catch(() => {});
    if (active === take) active = null;
    setRecording('idle');
  }

  /**
   * A record or stop failure: no take in progress, the input closed, and the error card with
   * the failure's code (the mic's error path).
   */
  function failRecording(err: unknown) {
    if (active) stopWatchingLimits(active);
    if (countIn) {
      countIn.cancelClicks();
      clearTimeout(countIn.timer);
      countIn = null;
    }
    active = null;
    recording = 'idle';
    const opened = input;
    input = null;
    if (opened) release(opened);
    set({
      mic: 'error',
      errorCode: isAppError(err) ? err.code : 'storage-failed',
    });
  }

  function record(): Promise<void> {
    if (snapshot.mic !== 'live' || running || recording !== 'idle' || !input) {
      return Promise.resolve();
    }
    return enqueue(startTake).catch(() => {});
  }

  /**
   * The new take's record (spine AD-14: settings copied from prefs, never linked); `countInBpm`
   * only when it was recorded with a count-in.
   */
  function newTake(id: string, opened: OpenedInput, countInBpm: number | null): Take {
    let settings: AnalysisSettings;
    try {
      settings = { ...deps.loadPrefs().analysisDefaults };
    } catch {
      settings = { ...DEFAULT_PREFS.analysisDefaults };
    }
    const created = new Date(deps.now());
    const createdAt = created.toISOString();
    return {
      id,
      title: takeTitle(created),
      createdAt,
      status: 'recording',
      durationMs: 0,
      sampleRate: opened.analyser.context.sampleRate,
      tuning: 'EADGBE',
      micLabel: activeDevice(opened, snapshot.devices)?.label || opened.label,
      audioMime: null,
      trimStartMs: 0,
      trimEndMs: null,
      ...(countInBpm !== null ? { countInBpm } : {}),
      settings,
      analysisVersion: null,
      updatedAt: createdAt,
    };
  }

  async function startTake() {
    const opened = input;
    // Re-checked: a transition queued ahead of this one may have changed the input.
    if (snapshot.mic !== 'live' || recording !== 'idle' || !opened) return;
    // Cleared for every take, so it never describes an earlier count-in.
    if (import.meta.env.DEV) delete window.__recordingClock;
    const take: ActiveTake = {
      id: deps.newId(),
      input: opened,
      capture: null,
      writer: null,
      held: [],
      appends: Promise.resolve(),
      samples: 0,
      clipCount: 0,
      abandoned: false,
      limitTimer: undefined,
    };
    active = take;
    const { on, bpm } = snapshot.countIn;
    if (on) {
      await countInThenStart(take, opened, bpm);
      return;
    }
    setRecording('starting');
    let captured: PromiseSettledResult<Capture>;
    let opening: PromiseSettledResult<RawWriter>;
    try {
      const record = newTake(take.id, opened, null);
      // Both at once: the take is created at the click, and the capture's early chunks are held.
      [captured, opening] = await Promise.allSettled([
        attempt(() =>
          opened.capture(
            (samples, clipped) => onChunk(take, samples, clipped),
            undefined,
            maxTakeMs,
          ),
        ),
        attempt(() => deps.createTake(record).then(() => deps.openRawWriter(take.id))),
      ]);
    } catch (err) {
      take.abandoned = true;
      failRecording(err);
      return;
    }
    if (captured.status === 'rejected' || opening.status === 'rejected') {
      take.abandoned = true;
      if (captured.status === 'fulfilled') captured.value.abort();
      if (opening.status === 'fulfilled') void opening.value.close().catch(() => {});
      failRecording(
        captured.status === 'rejected'
          ? captured.reason
          : (opening as PromiseRejectedResult).reason,
      );
      return;
    }
    take.capture = captured.value;
    begin(take, opening.value);
  }

  /** The take is created and its writer open: append the held chunks, then `recording`. */
  function begin(take: ActiveTake, writer: RawWriter) {
    take.writer = writer;
    for (const samples of take.held.splice(0)) appendRaw(take, writer, samples);
    setRecording('recording');
    watchLimits(take);
  }

  /**
   * The count-in, then the take (spine AD-9): the clicks and the capture are scheduled from the
   * click's audio-clock time; the take is created when the clock reaches the capture start.
   */
  async function countInThenStart(take: ActiveTake, opened: OpenedInput, bpm: number) {
    const ci: CountIn = {
      take,
      beats: [],
      cancelled: false,
      cancelClicks: () => {},
      wake: () => {},
      timer: undefined,
    };
    let clickTime: number;
    let captureStart: number;
    let capturing: Promise<Capture>;
    try {
      clickTime = opened.clock();
      const schedule = countInSchedule(clickTime, bpm);
      ci.beats = schedule.beats;
      captureStart = schedule.captureStart;
      countIn = ci;
      setRecording('count-in');
      ci.cancelClicks = opened.clicks(schedule.beats);
      capturing = opened.capture(
        (samples, clipped) => onChunk(take, samples, clipped),
        schedule.captureStart,
        maxTakeMs,
      );
    } catch (err) {
      take.abandoned = true;
      failRecording(err);
      return;
    }
    let capture: Capture;
    try {
      capture = await capturing;
    } catch (err) {
      take.abandoned = true;
      if (!ci.cancelled) failRecording(err);
      return;
    }
    if (ci.cancelled) {
      capture.abort();
      return;
    }
    // Opened later than beat five (a slow setup): the bar grid would be off, so no take.
    if (capture.startTime > captureStart + 0.001) {
      take.abandoned = true;
      capture.abort();
      failRecording(new AppError('mic-failed', 'The capture opened after the count-in'));
      return;
    }
    take.capture = capture;
    if (import.meta.env.DEV) {
      window.__recordingClock = { clickTime, captureStart: capture.startTime };
    }
    const reached = await untilClock(ci, capture.startTime);
    // A cancel has already aborted the capture and gone idle.
    if (ci.cancelled) return;
    if (!reached) {
      // The audio clock stopped (a suspended context): the count-in can never finish.
      take.abandoned = true;
      capture.abort();
      failRecording(new AppError('mic-failed', 'The audio clock stopped during the count-in'));
      return;
    }
    countIn = null;
    setRecording('starting');
    let writer: RawWriter;
    try {
      await deps.createTake(newTake(take.id, opened, bpm));
      writer = await deps.openRawWriter(take.id);
    } catch (err) {
      take.abandoned = true;
      capture.abort();
      failRecording(err);
      return;
    }
    begin(take, writer);
  }

  /**
   * Resolves true once `ci`'s input's audio clock reaches `time` (s), or at once on a cancel.
   * The timer is aimed at the time and re-checks the clock, so it never resolves early. Resolves
   * false when the wall clock passes the expected wait plus `CLOCK_STALL_MS` first (the audio
   * clock has stopped).
   */
  function untilClock(ci: CountIn, time: number): Promise<boolean> {
    const deadline =
      deps.now() + Math.max(0, (time - ci.take.input.clock()) * 1000) + CLOCK_STALL_MS;
    return new Promise((resolve) => {
      const done = (reached: boolean) => {
        clearTimeout(ci.timer);
        ci.timer = undefined;
        resolve(reached);
      };
      ci.wake = () => done(true);
      const tick = () => {
        if (ci.cancelled) return done(true);
        const ms = (time - ci.take.input.clock()) * 1000;
        if (ms <= 0) return done(true);
        const left = deadline - deps.now();
        if (left <= 0) return done(false);
        ci.timer = setTimeout(tick, Math.max(1, Math.ceil(Math.min(ms, left))));
      };
      tick();
    });
  }

  /** Cancels the count-in in progress: no clicks, no capture, no take; `idle`. */
  function cancelCountIn() {
    const ci = countIn;
    if (!ci) return;
    ci.cancelled = true;
    countIn = null;
    ci.cancelClicks();
    ci.take.abandoned = true;
    ci.take.capture?.abort();
    if (active === ci.take) active = null;
    setRecording('idle');
    ci.wake();
  }

  function readCountInBeat(): number | null {
    const ci = countIn;
    if (!ci || ci.beats.length === 0) return null;
    const now = ci.take.input.clock();
    let beat = 0;
    for (let k = 1; k < ci.beats.length; k++) if (now >= ci.beats[k]!) beat = k;
    return COUNT_IN_BEATS - beat;
  }

  function setCountIn(change: Partial<CountInPrefs>) {
    if (recording !== 'idle') return;
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

  function stop(reason: Extract<StopReason, 'user'>): Promise<void> {
    if (recording === 'count-in') {
      cancelCountIn();
      return Promise.resolve();
    }
    if (recording !== 'recording') return Promise.resolve();
    if (active) stopWatchingLimits(active);
    setRecording('stopping');
    return enqueue(() => finishTake(reason)).catch(() => {});
  }

  /**
   * The stop pipeline: stops the capture (already stopped at the cap for `max-length`), then
   * saves the take and opens its Tab, or deletes it when it is under `MIN_TAKE_MS`.
   */
  async function finishTake(reason: StopReason) {
    const take = active;
    if (!take || take.abandoned || !take.capture || !take.writer) return;
    const { capture, writer } = take;
    stopWatchingLimits(take);
    try {
      const { parts } = await capture.stop();
      await take.appends;
      const durationMs = Math.round((take.samples / capture.sampleRate) * 1000);
      // A max-length stop is never short; any other stop under 0.5 s keeps nothing (AD-9).
      if (reason !== 'max-length' && durationMs < MIN_TAKE_MS) {
        try {
          await writer.close();
          await deps.deleteTake(take.id, 'recording-session');
        } catch {
          // The `recording` record (and its raw file) left behind is the recovery scan's to
          // remove (story 3.11); the take is discarded all the same.
        }
        active = null;
        setRecording('idle', { notice: { kind: 'too-short', seq: ++noticeSeq } });
        return;
      }
      await deps.writeCompressed(take.id, new Blob(parts, { type: RECORDING_MIME }));
      await writer.close();
      await deps.patchTake(
        take.id,
        {
          status: 'recorded',
          durationMs,
          audioMime: RECORDING_MIME,
          stopReason: reason,
          clipped: take.clipCount > 0,
        },
        'recording-session',
      );
    } catch (err) {
      take.abandoned = true;
      capture.abort();
      // The raw file keeps what was written; recovery (a later story) rebuilds the take.
      void take.appends.then(() => writer.close()).catch(() => {});
      failRecording(err);
      return;
    }
    active = null;
    setRecording('idle', { savedSeq: snapshot.savedSeq + 1 });
    deps.navigate(take.id);
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
    record,
    stop,
    readElapsedMs: () => active?.capture?.elapsedMs() ?? 0,
    readCountInBeat,
    setCountIn,
  };
}

/**
 * Dev builds only: the length limits from `?maxTakeMs=<n>&warnLeadMs=<n>` in `search`, each a
 * positive whole number of ms; a missing or invalid one keeps its constant. The cap is at least
 * `DEV_MIN_CAP_MS` and the lead at most the cap. Read once, when the store is created.
 */
export function readDevLimits(search: string): TakeLimits {
  const params = new URLSearchParams(search);
  const read = (name: string, fallback: number) => {
    const value = Number(params.get(name) ?? NaN);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  };
  const capMs = Math.max(DEV_MIN_CAP_MS, read('maxTakeMs', MAX_TAKE_MS));
  return { capMs, leadMs: Math.min(capMs, read('warnLeadMs', WARN_LEAD_MS)) };
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
