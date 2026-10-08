// The recorder (spine AD-2, AD-9): the capture graph built in a live input's own AudioContext.
// The input's source feeds
//   - the recorder worklet (recorder-worklet.ts), which posts 1 s mono Float32 chunks at the
//     context's rate, and
//   - a gain gate into a MediaStreamAudioDestinationNode, whose stream feeds MediaRecorder
//     (Opus, 96 kbps).
// Start and stop are scheduled on the audio clock: the start a short lookahead ahead, or at a
// given time (the count-in's beat five), the stop a lookahead ahead; the worklet and the gate
// switch at exactly those frames. A capture given a length cap also schedules its stop at the
// start, at `startTime + maxMs` on the audio clock, so no main-thread timer can extend it.
// MediaRecorder cannot be scheduled on the audio clock, so it is started and stopped by timers
// aimed at the same times (and stopped as soon as the worklet reports it has stopped); the
// compressed copy is offset from the raw chunks only by that jitter (and the encoder's own
// start latency), a few ms.

import workletUrl from './recorder-worklet.ts?worker&url';
import { AppError } from '../model/errors';
import { CAPTURE_START_MARK, CAPTURE_STOP_MARK } from '../model/latency-marks';
import { CLIP_LEVEL } from '../model/level-warnings';
import { quietlySync as quietly } from '../model/quietly';
import { resumeWithin, within } from './context-resume';

/** The compressed copy's MIME type (spine AD-9); `model/audio-format.ts` lists it. */
export const RECORDING_MIME = 'audio/webm;codecs=opus';
/** The compressed copy's bitrate (spine AD-9). */
export const RECORDING_BITS_PER_SECOND = 96_000;
/** How far ahead of the audio clock start and stop are scheduled, in seconds. */
const LOOKAHEAD_S = 0.05;
/** How long `stop` waits for the worklet's last chunk before giving up on it. */
const STOP_TIMEOUT_MS = 3000;
/** MediaRecorder's timeslice: it hands over data every second rather than all at the end. */
const TIMESLICE_MS = 1000;

/** A running capture. */
export interface Capture {
  /** The context's sample rate: the rate of every chunk. */
  readonly sampleRate: number;
  /** The audio-clock time (s) the capture opens at: the first captured frame's time. */
  readonly startTime: number;
  /** Audio-clock time captured so far, in ms (0 before the start time; frozen once stopping). */
  elapsedMs(): number;
  /**
   * Stops at the audio clock's next lookahead time, or at the cap when that comes first (or has
   * passed). Every chunk, the final partial one included, is delivered to `onChunk` before this
   * resolves with the compressed parts.
   * Rejects with `AppError` `mic-failed` when the worklet's last chunk does not arrive in time
   * or MediaRecorder failed: the copy is incomplete, so the take must not be saved.
   */
  stop(): Promise<{ parts: Blob[] }>;
  /**
   * Resolves once the capture has stopped by itself at its cap (`startTime + maxMs`), every
   * chunk delivered; call `stop` then for the compressed parts. Never resolves without a cap,
   * or when `stop` or `abort` came first.
   */
  readonly capped: Promise<void>;
  /** Stops the worklet and MediaRecorder and tears the graph down without waiting. */
  abort(): void;
}

/** Loads the worklet module into `ctx` once; a failed load is retried on the next call. */
const loaded = new WeakMap<BaseAudioContext, Promise<void>>();
export function loadRecorderWorklet(ctx: BaseAudioContext): Promise<void> {
  let promise = loaded.get(ctx);
  if (!promise) {
    promise = ctx.audioWorklet.addModule(workletUrl);
    loaded.set(ctx, promise);
    promise.catch(() => {
      if (loaded.get(ctx) === promise) loaded.delete(ctx);
    });
  }
  return promise;
}

/**
 * The latency mark (`CAPTURE_START_MARK`) set when the main thread receives the worklet's
 * `started` message (posted from the render quantum that copies the first frame), so it trails
 * the actual start by the port's delivery time (story 3.5, Done when 1: Space to capture start
 * within 100 ms, read against `record-keydown`). Set in every build; nothing in the app reads it.
 */
export { CAPTURE_START_MARK, CAPTURE_STOP_MARK };

function markCaptureStart(): void {
  try {
    performance.mark(CAPTURE_START_MARK);
  } catch {
    // No User Timing (never in the supported Chrome): the mark is only a measurement.
  }
}

/**
 * Sets `CAPTURE_STOP_MARK` when the main thread receives the worklet's `stopped` message (posted
 * from the render quantum that passes the stop frame), so it includes the stop's scheduling
 * lookahead and trails the actual stop by the port's delivery time (CAP-25 states sweep: Space to
 * capture stop, read against the second `record-keydown`).
 */
function markCaptureStop(): void {
  try {
    performance.mark(CAPTURE_STOP_MARK);
  } catch {
    // No User Timing: the mark is only a measurement.
  }
}

/** How long `startCapture` waits for a suspended context to resume. */
const RESUME_TIMEOUT_MS = 1000;

/**
 * The compressed copy's graph: `input` into a mono MediaStreamAudioDestinationNode whose stream
 * feeds a MediaRecorder (`RECORDING_MIME`, `RECORDING_BITS_PER_SECOND`), not yet started. Each
 * non-empty data chunk is pushed onto `parts`. When MediaRecorder cannot be built, the
 * destination's tracks are stopped and the error is thrown. Shared by the live capture and
 * recovery's re-encode (encode.ts).
 */
export function createCompressedOutput(
  ctx: AudioContext,
  input: AudioNode,
  parts: Blob[],
): { destination: MediaStreamAudioDestinationNode; recorder: MediaRecorder } {
  const destination = ctx.createMediaStreamDestination();
  destination.channelCount = 1;
  input.connect(destination);
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(destination.stream, {
      mimeType: RECORDING_MIME,
      audioBitsPerSecond: RECORDING_BITS_PER_SECOND,
    });
  } catch (err) {
    for (const track of destination.stream.getTracks()) track.stop();
    throw err;
  }
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) parts.push(event.data);
  };
  return { destination, recorder };
}

/** The ms from now until audio-clock `time` (s), at least 0. */
const msUntil = (ctx: BaseAudioContext, time: number) =>
  Math.max(0, (time - ctx.currentTime) * 1000);

/**
 * Starts capturing `source` (a node of `ctx`). `onChunk` receives each 1 s chunk in order (the
 * last one shorter), with how many of its samples clipped (|x| ≥ `CLIP_LEVEL`). The capture
 * opens at audio-clock time `startAt` (s) when given (a count-in's beat five), else a short
 * lookahead from now; a `startAt` already too close or past opens it after that lookahead
 * instead (`Capture.startTime` says when). With `maxMs`, the stop is scheduled at once at
 * `startTime + maxMs` on the audio clock (`Capture.capped`). Rejects with `AppError`
 * `mic-failed` when the context cannot run or the graph cannot be built.
 */
export async function startCapture(
  ctx: AudioContext,
  source: AudioNode,
  onChunk: (samples: Float32Array, clipped: number) => void,
  startAt?: number,
  maxMs?: number,
): Promise<Capture> {
  let worklet: AudioWorkletNode | undefined;
  let gate: GainNode | undefined;
  let destination: MediaStreamAudioDestinationNode | undefined;
  let recorder: MediaRecorder | undefined;
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  let mediaError = false;
  const parts: Blob[] = [];
  let resolveStopped: () => void = () => {};
  const stopped = new Promise<void>((resolve) => (resolveStopped = resolve));

  /**
   * Stops the worklet (at once), disconnects what was connected and ends the destination's
   * tracks; a node never connected (or a closed context) is skipped.
   */
  const teardown = () => {
    clearTimeout(startTimer);
    if (worklet) {
      const node = worklet;
      node.port.onmessage = null;
      quietly(() =>
        node.port.postMessage({
          type: 'stop',
          frame: Math.round(ctx.currentTime * ctx.sampleRate),
        }),
      );
    }
    const nodes = [worklet, gate].filter((n): n is AudioWorkletNode | GainNode => !!n);
    for (const n of nodes) quietly(() => source.disconnect(n));
    if (gate) quietly(() => gate!.disconnect());
    for (const track of destination?.stream.getTracks() ?? []) track.stop();
  };

  // A suspended context's clock is frozen: nothing would ever be captured.
  if (!(await resumeWithin(ctx, RESUME_TIMEOUT_MS))) {
    throw new AppError('mic-failed', `The audio context is ${ctx.state}`);
  }

  let startTime: number;
  let capTime: number | null = null;
  try {
    await loadRecorderWorklet(ctx);
    worklet = new AudioWorkletNode(ctx, 'tabcreator-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    worklet.port.onmessage = (
      event: MessageEvent<{ type: string; samples?: Float32Array; clipped?: number }>,
    ) => {
      const { type, samples, clipped } = event.data;
      if (type === 'chunk' && samples) onChunk(samples, clipped ?? 0);
      else if (type === 'started') markCaptureStart();
      else if (type === 'stopped') {
        markCaptureStop();
        resolveStopped();
      }
    };
    gate = ctx.createGain();
    gate.gain.value = 0;
    source.connect(worklet);
    source.connect(gate);
    const output = createCompressedOutput(ctx, gate, parts);
    destination = output.destination;
    const media = output.recorder;
    recorder = media;
    media.onerror = () => {
      mediaError = true;
    };
    startTime = Math.max(startAt ?? -Infinity, ctx.currentTime + LOOKAHEAD_S);
    gate.gain.setValueAtTime(1, startTime);
    worklet.port.postMessage({
      type: 'start',
      frame: Math.round(startTime * ctx.sampleRate),
      clipLevel: CLIP_LEVEL,
    });
    if (maxMs !== undefined) {
      // The cap, on the audio clock: an earlier stop's frame replaces it.
      capTime = startTime + maxMs / 1000;
      gate.gain.setValueAtTime(0, capTime);
      worklet.port.postMessage({ type: 'stop', frame: Math.round(capTime * ctx.sampleRate) });
    }
    // Started when the gate opens, so the compressed copy begins with the raw chunks.
    startTimer = setTimeout(
      () => {
        try {
          if (media.state === 'inactive') media.start(TIMESLICE_MS);
        } catch {
          mediaError = true;
        }
      },
      msUntil(ctx, startTime),
    );
  } catch (err) {
    teardown();
    throw new AppError('mic-failed', 'Starting the recorder failed', { cause: err });
  }

  const media = recorder;
  const node = worklet;
  const gain = gate;
  let stopTime: number | null = null;
  let stopping: Promise<{ parts: Blob[] }> | null = null;
  let aborted = false;

  /** Stops MediaRecorder (once); resolves when it has stopped. */
  let mediaStopped: Promise<void> | null = null;
  const stopMedia = () =>
    (mediaStopped ??= new Promise<void>((resolve) => {
      clearTimeout(startTimer);
      if (media.state === 'inactive') {
        resolve();
        return;
      }
      media.addEventListener('stop', () => resolve(), { once: true });
      try {
        media.stop();
      } catch {
        mediaError = true;
        resolve();
      }
    }));

  // The worklet has passed its stop frame (the cap's, or an earlier stop's): the gate is
  // closed, so the compressed copy ends here too.
  let resolveCapped: () => void = () => {};
  const capped = new Promise<void>((resolve) => (resolveCapped = resolve));
  void stopped.then(() => {
    if (aborted) return;
    void stopMedia();
    if (!stopping && capTime !== null) resolveCapped();
  });

  async function finish(at: number): Promise<{ parts: Blob[] }> {
    gain.gain.setValueAtTime(0, at);
    node.port.postMessage({ type: 'stop', frame: Math.round(at * ctx.sampleRate) });
    // Stopped when the gate closes, so the compressed copy ends with the raw chunks.
    const mediaDone = new Promise<void>((resolve) => {
      setTimeout(() => void stopMedia().then(resolve), msUntil(ctx, at));
    });
    const done = await within(
      Promise.all([stopped, mediaDone]),
      msUntil(ctx, at) + STOP_TIMEOUT_MS,
    );
    teardown();
    if (!done) throw new AppError('mic-failed', 'The recorder did not stop in time');
    if (mediaError) throw new AppError('mic-failed', 'The compressed recording failed');
    return { parts };
  }

  return {
    sampleRate: ctx.sampleRate,
    startTime,
    capped,
    elapsedMs() {
      const end = Math.min(stopTime ?? Infinity, capTime ?? Infinity);
      return Math.max(0, (Math.min(ctx.currentTime, end) - startTime) * 1000);
    },
    stop() {
      if (!stopping) {
        stopTime = Math.min(
          capTime ?? Infinity,
          Math.max(ctx.currentTime + LOOKAHEAD_S, startTime),
        );
        stopping = finish(stopTime);
      }
      return stopping;
    },
    abort() {
      aborted = true;
      stopTime ??= ctx.currentTime;
      try {
        if (media.state !== 'inactive') media.stop();
      } catch {
        // The stream is already gone.
      }
      teardown();
    },
  };
}
