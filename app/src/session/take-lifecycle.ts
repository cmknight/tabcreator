// The take lifecycle (story 3.4 onwards, spine AD-9, AD-14, AD-15): a module of the recording
// store, which composes it the way it composes recovery. It owns the take in progress
// (`ActiveTake`) and the recording state, from the start of a take (with or without a count-in)
// through its chunks, its length limits and its failure stops to its save (`finishTake`). The
// store keeps the mic, the transition queue and the snapshot, and hands them in as the host.
//
// The recording state is an explicit machine: idle → count-in → starting → recording → stopping
// → idle, plus falls back to idle (a cancelled count-in, a failed start, an abandoned take).
// Every change goes through `transition`, which refuses one not in `RECORDING_TRANSITIONS` and
// leaves the state as it was (dev and test builds throw instead). A change to the state it is
// already in is allowed (it re-publishes).
//
// Recording (story 3.4): `start()` creates the take at the click and starts the live input's
// capture; raw chunks are appended through the raw writer in order, those that arrive before the
// take and writer exist held and appended first. `stop('user')` stops the capture, saves the
// compressed copy, closes the raw writer, patches the take `recorded`, then navigates to its Tab.
//
// Count-in (story 3.6, US-3.3): with the `countIn` pref on, `start()` enters `count-in`: it reads
// the click's audio-clock time, schedules four clicks on the input's clock (audio/metronome.ts,
// speakers only) and starts the capture to open exactly on beat five. The take is created only
// when the audio clock reaches that time, with `countInBpm`; chunks before it resolves are held
// as above. During the count-in `stop()` cancels it (clicks cancelled, capture aborted, no take).
//
// Length cap and short takes (story 3.7, CAP-5, CAP-25): a take is capped at `capMs`. Its
// capture's stop is scheduled when the capture starts, on the audio clock at exactly `startTime +
// capMs`, so no timer can extend it; when that stop completes the take is saved with
// `stopReason: 'max-length'` (it stays `recording`, so Stop works, until then). When its
// audio-clock time reaches `capMs − leadMs` the snapshot's `nearLimit` turns on (one notify; a
// wall-clock timer that re-reads the audio clock). A take stopped under `MIN_TAKE_MS` is deleted
// (record and files) with a `too-short` notice and no navigation. Each saved take bumps
// `savedSeq`, so the shell can announce it.
//
// Failure stops (story 3.9, CAP-25, CAP-26): when the track of the input a take records ends,
// the store's queued handling first runs the stop pipeline here with `stopReason: 'mic-lost'` (no
// navigation; `inputEnded`). When a raw append rejects with `storage-full`, nothing more is
// appended and the take is saved with `stopReason: 'storage-full'`, the snapshot's `storageFull`
// on (the Record banner) until the next take starts; when that save fails too, the take stays
// `recording` with its raw chunks for recovery, with no error card. A handover saves the take as
// `instance-lost` (`beginHandover`, `finishForHandover`). A failed record or stop has the host
// close the input and show the error card (`failInput`).
//
// Clipping (US-1.3, spine AD-14): the capture reports each chunk's clipped samples (|x| at or
// above the meter's Too loud threshold); the take's clip counter (take-save.ts) keeps the total,
// and every saved take's stop patch carries `clipped`. The save itself is take-save.ts's
// `saveTake`, the step recovery shares.

import { activeDevice, type Capture } from '../audio/mic';
import { COUNT_IN_BEATS, countInSchedule } from '../audio/metronome';
import { RECORDING_MIME } from '../audio/recorder';
import { AppError, isAppError } from '../model/errors';
import type { AnalysisSettings, StopReason, Take } from '../model/types';
import type { RawWriter } from '../storage/audio-store';
import type { TakePatch } from '../storage/db';
import { DEFAULT_PREFS } from '../storage/prefs';
import type { OpenedInput } from './input-derivation';
import type { RecordingSnapshot } from './recording-session';
import { type ClipCounter, createClipCounter, MIN_TAKE_MS, saveTake } from './take-save';

/**
 * Where a take is: none, counting in (no take yet), being created, capturing, or being saved.
 */
export type RecordingState = 'idle' | 'count-in' | 'starting' | 'recording' | 'stopping';

/**
 * The recording state's transitions: from each state, the states it may move to. The forward
 * path is idle → count-in → starting → recording → stopping → idle; a count-in, a start or an
 * abandoned take may also fall back to idle.
 */
export const RECORDING_TRANSITIONS: Readonly<Record<RecordingState, readonly RecordingState[]>> = {
  idle: ['count-in', 'starting'],
  'count-in': ['starting', 'idle'],
  starting: ['recording', 'idle'],
  recording: ['stopping', 'idle'],
  stopping: ['idle'],
};

/** Whether the recording state may move from `from` to `to` (staying put is always allowed). */
export function canTransition(from: RecordingState, to: RecordingState): boolean {
  return from === to || RECORDING_TRANSITIONS[from].includes(to);
}

/** The recording state machine: starts `idle`; `to` refuses a transition not in the table. */
export interface RecordingMachine {
  readonly state: RecordingState;
  /** Moves to `next` and returns true; returns false, the state unchanged, when not allowed. */
  to(next: RecordingState): boolean;
}

/**
 * Moves `machine` to `next` (the lifecycle's only way to change state). A transition not in the
 * table is a bug: dev and test builds throw an Error naming both states; production refuses it
 * silently (returns false, the state unchanged).
 */
export function enterState(machine: RecordingMachine, next: RecordingState): boolean {
  const from = machine.state;
  if (machine.to(next)) return true;
  if (import.meta.env.DEV) {
    throw new Error(`Refused recording state transition: ${from} → ${next}`);
  }
  return false;
}

export function createRecordingMachine(): RecordingMachine {
  let state: RecordingState = 'idle';
  return {
    get state() {
      return state;
    },
    to(next) {
      if (!canTransition(state, next)) return false;
      state = next;
      return true;
    },
  };
}

/** A take's length limits, ms: the cap and the warning's lead before it. */
export interface TakeLimits {
  /** The cap (`MAX_TAKE_MS`). */
  capMs: number;
  /** The warning's lead before the cap (`WARN_LEAD_MS`). */
  leadMs: number;
}

/** How long past the expected capture start the audio clock may lag before it counts as stopped. */
const CLOCK_STALL_MS = 2000;

/** The dev-only clock hook (story 3.6): the last count-in's times on the audio clock, in s. */
interface RecordingClock {
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

/** The shell functions the lifecycle drives (a subset of the store's deps). */
export interface TakeLifecycleDeps {
  loadPrefs: () => { analysisDefaults: AnalysisSettings };
  createTake: (take: Take) => Promise<unknown>;
  patchTake: (id: string, patch: TakePatch, writer: 'recording-session') => Promise<unknown>;
  openRawWriter: (takeId: string) => Promise<RawWriter>;
  writeCompressed: (takeId: string, blob: Blob) => Promise<void>;
  /** Deletes a take's record and its raw and compressed files (a too-short take). */
  deleteTake: (id: string, writer: 'recording-session') => Promise<unknown>;
  /** Opens the take's Tab screen. */
  navigate: (takeId: string) => void;
  /** The wall clock, ms since the epoch. */
  now: () => number;
  /** A new take id. */
  newId: () => string;
}

/** What the lifecycle needs from the recording store. */
export interface TakeLifecycleHost {
  /** The store's current snapshot. */
  snapshot(): RecordingSnapshot;
  /** The store's open input; null when there is none. */
  input(): OpenedInput | null;
  /** The store is handed over to another tab: no take starts. */
  handedOver(): boolean;
  /** Publishes fields; notifies only when one changes. */
  patch(fields: Partial<RecordingSnapshot>): void;
  /** Queues a task on the store's transition queue. */
  enqueue(task: () => Promise<void>): Promise<void>;
  /** The next notice sequence number. */
  nextNoticeSeq(): number;
  /** A record or stop failed: close the input and show the error card for `err`. */
  failInput(err: unknown): void;
}

export interface TakeLifecycle {
  /** The recording state. */
  state(): RecordingState;
  /** The published take id: none while idle or counting in (no take exists yet). */
  publishedTakeId(): string | null;
  /** The take in progress (counting in, starting, recording or stopping); null with none. */
  activeTakeId(): string | null;
  /** The published `nearLimit`: kept while the take records or stops, else off. */
  nearLimit(): boolean;
  /** Starts a take on the host's input (run inside the store's queue). Never rejects. */
  start(): Promise<void>;
  /**
   * Stop: cancels a count-in, or (while `recording`) marks `stopping` and queues the save. A
   * no-op otherwise. Never rejects.
   */
  stop(reason: Extract<StopReason, 'user'>): Promise<void>;
  /** The track of `opened` has ended: a count-in on it is cancelled at once. */
  inputEnding(opened: OpenedInput): void;
  /**
   * The ended track's handling (inside the queue): a take recording on `opened` is stopped and
   * saved as `mic-lost`; one not yet recording is abandoned. Resolves true when a take was saved.
   */
  inputEnded(opened: OpenedInput): Promise<boolean>;
  /** A handover starts: a count-in is cancelled and a recording take marked `stopping`. */
  beginHandover(): void;
  /** The handover's save (queued): a recording or stopping take is saved as `instance-lost`. */
  finishForHandover(): Promise<void>;
  /** Audio-clock time the take has recorded so far, in ms; 0 with no capture running. */
  readElapsedMs(): number;
  /** The count-in's beat as shown, counting down from 4; null when no count-in runs. */
  readCountInBeat(): number | null;
}

/** A take from `start()` until it is saved, fails or is abandoned. */
interface ActiveTake {
  id: string;
  /** The input it records; an ended track of this input stops and saves it (`mic-lost`). */
  input: OpenedInput;
  capture: Capture | null;
  writer: RawWriter | null;
  /** Chunks that arrived before the writer existed, in order. */
  held: Float32Array[];
  /** The raw appends, chained in order. */
  appends: Promise<void>;
  /** Samples appended to the raw file so far. */
  samples: number;
  /** Captured samples that clipped so far; saved as `clipped` at stop. */
  clips: ClipCounter;
  /** Set when the take is given up; later chunks are dropped. */
  abandoned: boolean;
  /** A raw append rejected with `storage-full`: nothing more is appended; it stops and saves. */
  storageFull: boolean;
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

export function createTakeLifecycle(
  deps: TakeLifecycleDeps,
  host: TakeLifecycleHost,
  limits: TakeLimits,
): TakeLifecycle {
  const maxTakeMs = limits.capMs;
  const warnLeadMs = limits.leadMs;
  const machine = createRecordingMachine();
  /** The take in progress (counting in, starting, recording or stopping). */
  let active: ActiveTake | null = null;
  /** The count-in in progress; set only while `count-in`. */
  let countIn: CountIn | null = null;

  const state = () => machine.state;

  const publishedTakeId = () => (machine.state === 'count-in' ? null : (active?.id ?? null));

  const nearLimit = () =>
    (machine.state === 'recording' || machine.state === 'stopping') && host.snapshot().nearLimit;

  /**
   * The one way the recording state changes: refused (state and snapshot unchanged; a throw in
   * dev and test builds, see `enterState`) when not in `RECORDING_TRANSITIONS`. Publishes the state and the active take id (notifying only on a
   * change), unless `publish` is false (the caller's own notify follows).
   */
  function transition(
    next: RecordingState,
    extra: Partial<RecordingSnapshot> = {},
    publish = true,
  ): boolean {
    if (!enterState(machine, next)) return false;
    if (publish) {
      host.patch({
        recording: machine.state,
        activeTakeId: publishedTakeId(),
        nearLimit: nearLimit(),
        ...extra,
      });
    }
    return true;
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
      if (active !== take || take.abandoned || machine.state !== 'recording') return;
      const elapsed = capture.elapsedMs();
      if (elapsed >= warnAt) {
        if (!host.snapshot().nearLimit) host.patch({ nearLimit: true });
        return;
      }
      take.limitTimer = setTimeout(tick, Math.max(1, Math.ceil(warnAt - elapsed)));
    };
    tick();
    void capture.capped.then(() => {
      // A Stop (or a failure) came first: that path saves (or keeps) the take.
      if (active !== take || take.abandoned || machine.state !== 'recording') return;
      stopWatchingLimits(take);
      transition('stopping');
      host.enqueue(() => finishTake('max-length').then(() => {})).catch(() => {});
    });
  }

  function stopWatchingLimits(take: ActiveTake) {
    clearTimeout(take.limitTimer);
    take.limitTimer = undefined;
  }

  /** A captured chunk: counted, then appended (or held until the writer exists). */
  function onChunk(take: ActiveTake, samples: Float32Array, clipped: number) {
    // A chunk after the take was saved, deleted or given up is dropped.
    if (take.abandoned || active !== take) return;
    take.clips.add(clipped);
    if (take.writer) appendRaw(take, take.writer, samples);
    else take.held.push(samples);
  }

  function appendRaw(take: ActiveTake, writer: RawWriter, samples: Float32Array) {
    take.appends = take.appends
      .then(async () => {
        // Once storage is full nothing more is written, so `durationMs` is what reached the file.
        if (take.storageFull) return;
        await writer.append(samples);
        // Counted once written, so `durationMs` never exceeds the raw file.
        take.samples += samples.length;
      })
      .catch((err: unknown) => {
        if (isAppError(err) && err.code === 'storage-full') onStorageFull(take);
        // Any other failure: the chain goes on with the next chunk (a residual of story 3.9).
      });
  }

  /**
   * The first `storage-full` append of `take`: no more appends, and the take stops and is saved
   * as `storage-full` (through the queue). A stop already under way (Stop, the cap, a mic loss)
   * saves it instead, reading the flag.
   */
  function onStorageFull(take: ActiveTake) {
    if (take.storageFull) return;
    take.storageFull = true;
    if (active !== take || take.abandoned || machine.state !== 'recording') return;
    stopWatchingLimits(take);
    transition('stopping');
    host.enqueue(() => finishTake('storage-full').then(() => {})).catch(() => {});
  }

  /** Gives the take up (its input is going away): drops the capture, closes the writer. */
  function abandon(take: ActiveTake) {
    take.abandoned = true;
    stopWatchingLimits(take);
    take.capture?.abort();
    const writer = take.writer;
    void take.appends.then(() => writer?.close()).catch(() => {});
    if (active === take) active = null;
    transition('idle');
  }

  /**
   * A record or stop failure: no take in progress, then the host closes the input and shows the
   * error card with the failure's code (the mic's error path, which publishes the state).
   */
  function failRecording(err: unknown) {
    if (active) stopWatchingLimits(active);
    if (countIn) {
      countIn.cancelClicks();
      clearTimeout(countIn.timer);
      countIn = null;
    }
    active = null;
    transition('idle', {}, false);
    host.failInput(err);
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
      micLabel: activeDevice(opened, host.snapshot().devices)?.label || opened.label,
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
    const opened = host.input();
    // Re-checked: a transition queued ahead of this one may have changed the input.
    if (
      host.handedOver() ||
      host.snapshot().mic !== 'live' ||
      machine.state !== 'idle' ||
      !opened
    ) {
      return;
    }
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
      clips: createClipCounter(),
      abandoned: false,
      storageFull: false,
      limitTimer: undefined,
    };
    active = take;
    const { on, bpm } = host.snapshot().countIn;
    if (on) {
      await countInThenStart(take, opened, bpm);
      return;
    }
    // A new take: the storage-full banner of an earlier one goes.
    transition('starting', { storageFull: false });
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
    transition('recording');
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
      transition('count-in', { storageFull: false });
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
    transition('starting');
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
    transition('idle');
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

  function stop(reason: Extract<StopReason, 'user'>): Promise<void> {
    if (machine.state === 'count-in') {
      cancelCountIn();
      return Promise.resolve();
    }
    if (machine.state !== 'recording') return Promise.resolve();
    if (active) stopWatchingLimits(active);
    transition('stopping');
    return host.enqueue(() => finishTake(reason).then(() => {})).catch(() => {});
  }

  /**
   * The stop pipeline: stops the capture (already stopped at the cap for `max-length`), then
   * saves the take, or deletes it when it is under `MIN_TAKE_MS`. A take whose raw appends hit
   * `storage-full` is saved as `storage-full` whatever `reason` asked. A `user` or `max-length`
   * save opens its Tab; a failure stop (`mic-lost`, `storage-full`, `instance-lost`) stays on
   * Record, and when its save fails the take is left `recording` for recovery with no error card
   * (the `storage-full` banner still shows). Settles as what became of the take.
   */
  async function finishTake(reason: StopReason): Promise<'saved' | 'short' | 'failed' | 'none'> {
    const take = active;
    if (!take || take.abandoned || !take.capture || !take.writer) return 'none';
    const { capture, writer } = take;
    stopWatchingLimits(take);
    let stopReason = reason;
    try {
      const { parts } = await capture.stop();
      await take.appends;
      if (take.storageFull) stopReason = 'storage-full';
      const durationMs = Math.round((take.samples / capture.sampleRate) * 1000);
      // A max-length stop is never short; any other stop under 0.5 s keeps nothing (AD-9).
      if (stopReason !== 'max-length' && durationMs < MIN_TAKE_MS) {
        try {
          await writer.close();
          await deps.deleteTake(take.id, 'recording-session');
        } catch {
          // The `recording` record (and its raw file) left behind is the recovery scan's to
          // remove (story 3.11); the take is discarded all the same.
        }
        active = null;
        // A short take that hit storage-full still raises the banner: the disk is full.
        transition('idle', {
          notice: { kind: 'too-short', seq: host.nextNoticeSeq() },
          ...(take.storageFull ? { storageFull: true } : {}),
        });
        return 'short';
      }
      await saveTake(deps, take.id, {
        blob: new Blob(parts, { type: RECORDING_MIME }),
        audioMime: RECORDING_MIME,
        durationMs,
        stopReason,
        clipped: take.clips.clipped,
        afterWrite: () => writer.close(),
      });
    } catch (err) {
      take.abandoned = true;
      capture.abort();
      // The raw file keeps what was written; recovery (story 3.11) rebuilds the take.
      void take.appends.then(() => writer.close()).catch(() => {});
      if (take.storageFull || stopReason === 'mic-lost' || stopReason === 'instance-lost') {
        // A failure stop: the mic is handled by its own path (kept live, or the idle rule).
        active = null;
        transition('idle', take.storageFull ? { storageFull: true } : {});
        return 'failed';
      }
      failRecording(err);
      return 'failed';
    }
    active = null;
    const full = stopReason === 'storage-full';
    transition('idle', {
      savedSeq: host.snapshot().savedSeq + 1,
      ...(full ? { storageFull: true } : {}),
    });
    if (stopReason === 'user' || stopReason === 'max-length') deps.navigate(take.id);
    return 'saved';
  }

  function inputEnding(opened: OpenedInput) {
    if (countIn?.take.input === opened) cancelCountIn();
  }

  async function inputEnded(opened: OpenedInput): Promise<boolean> {
    const take = active;
    if (take?.input !== opened) return false;
    if (machine.state === 'recording' || machine.state === 'stopping') {
      // Already inside the queue: the pipeline runs here, not re-enqueued.
      stopWatchingLimits(take);
      transition('stopping');
      return (await finishTake('mic-lost')) === 'saved';
    }
    abandon(take);
    return false;
  }

  function beginHandover() {
    if (machine.state === 'count-in') cancelCountIn();
    // Marked stopping now, so the cap or a full disk does not queue a save of its own first.
    if (machine.state === 'recording' && active) {
      stopWatchingLimits(active);
      transition('stopping');
    }
  }

  async function finishForHandover() {
    // Queued after a take being created (`starting`) or saved by a Stop: the first now records,
    // the second has gone.
    if (active && (machine.state === 'recording' || machine.state === 'stopping')) {
      stopWatchingLimits(active);
      transition('stopping');
      await finishTake('instance-lost');
    }
  }

  return {
    state,
    publishedTakeId,
    activeTakeId: () => active?.id ?? null,
    nearLimit,
    start: startTake,
    stop,
    inputEnding,
    inputEnded,
    beginHandover,
    finishForHandover,
    readElapsedMs: () => active?.capture?.elapsedMs() ?? 0,
    readCountInBeat,
  };
}
