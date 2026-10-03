// The recorder (spine AD-2, AD-9): the capture graph built in a live input's own AudioContext.
// The input's source feeds
//   - the recorder worklet (recorder-worklet.ts), which posts 1 s mono Float32 chunks at the
//     context's rate, and
//   - a gain gate into a MediaStreamAudioDestinationNode, whose stream feeds MediaRecorder
//     (Opus, 96 kbps).
// Start and stop are scheduled on the audio clock: the start a short lookahead ahead, or at a
// given time (the count-in's beat five), the stop a lookahead ahead; the worklet and the gate
// switch at exactly those frames. MediaRecorder cannot be scheduled on the audio clock, so
// it is started and stopped by timers aimed at the same times; the compressed copy is offset
// from the raw chunks only by that timer jitter (and the encoder's own start latency), a few ms.

import workletUrl from './recorder-worklet.ts?worker&url';
import { AppError } from '../model/errors';

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
   * Stops at the audio clock's next lookahead time. Every chunk, the final partial one
   * included, is delivered to `onChunk` before this resolves with the compressed parts.
   * Rejects with `AppError` `mic-failed` when the worklet's last chunk does not arrive in time
   * or MediaRecorder failed: the copy is incomplete, so the take must not be saved.
   */
  stop(): Promise<{ parts: Blob[] }>;
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
 * The latency mark set when the main thread receives the worklet's `started` message (posted
 * from the render quantum that copies the first frame), so it trails the actual start by the
 * port's delivery time (story 3.5, Done when 1: Space to capture start within 100 ms, read
 * against `record-keydown`). Set in every build; nothing in the app reads it.
 */
export const CAPTURE_START_MARK = 'record-capture-start';

function markCaptureStart(): void {
  try {
    performance.mark(CAPTURE_START_MARK);
  } catch {
    // No User Timing (never in the supported Chrome): the mark is only a measurement.
  }
}

/** How long `startCapture` waits for a suspended context to resume. */
const RESUME_TIMEOUT_MS = 1000;

/** Resolves after `ms`, or with the promise if it settles first; never rejects. */
function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms))),
  ]).finally(() => clearTimeout(timer));
}

/** The ms from now until audio-clock `time` (s), at least 0. */
const msUntil = (ctx: BaseAudioContext, time: number) =>
  Math.max(0, (time - ctx.currentTime) * 1000);

/**
 * Starts capturing `source` (a node of `ctx`). `onChunk` receives each 1 s chunk in order (the
 * last one shorter). The capture opens at audio-clock time `startAt` (s) when given (a count-in's
 * beat five), else a short lookahead from now; a `startAt` already too close or past opens it
 * after that lookahead instead (`Capture.startTime` says when). Rejects with `AppError`
 * `mic-failed` when the context cannot run or the graph cannot be built.
 */
export async function startCapture(
  ctx: AudioContext,
  source: AudioNode,
  onChunk: (samples: Float32Array) => void,
  startAt?: number,
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
    const quietly = (fn: () => void) => {
      try {
        fn();
      } catch {
        // Not connected, or the context is closed.
      }
    };
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

  if (ctx.state !== 'running') await within(ctx.resume(), RESUME_TIMEOUT_MS);
  // A suspended context's clock is frozen: nothing would ever be captured.
  if ((ctx.state as AudioContextState) !== 'running') {
    throw new AppError('mic-failed', `The audio context is ${ctx.state}`);
  }

  let startTime: number;
  try {
    await loadRecorderWorklet(ctx);
    worklet = new AudioWorkletNode(ctx, 'tabcreator-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    worklet.port.onmessage = (event: MessageEvent<{ type: string; samples?: Float32Array }>) => {
      const { type, samples } = event.data;
      if (type === 'chunk' && samples) onChunk(samples);
      else if (type === 'started') markCaptureStart();
      else if (type === 'stopped') resolveStopped();
    };
    gate = ctx.createGain();
    gate.gain.value = 0;
    destination = ctx.createMediaStreamDestination();
    destination.channelCount = 1;
    source.connect(worklet);
    source.connect(gate);
    gate.connect(destination);
    const media = new MediaRecorder(destination.stream, {
      mimeType: RECORDING_MIME,
      audioBitsPerSecond: RECORDING_BITS_PER_SECOND,
    });
    recorder = media;
    media.ondataavailable = (event) => {
      if (event.data.size > 0) parts.push(event.data);
    };
    media.onerror = () => {
      mediaError = true;
    };
    startTime = Math.max(startAt ?? -Infinity, ctx.currentTime + LOOKAHEAD_S);
    gate.gain.setValueAtTime(1, startTime);
    worklet.port.postMessage({ type: 'start', frame: Math.round(startTime * ctx.sampleRate) });
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

  async function finish(at: number): Promise<{ parts: Blob[] }> {
    gain.gain.setValueAtTime(0, at);
    node.port.postMessage({ type: 'stop', frame: Math.round(at * ctx.sampleRate) });
    // Stopped when the gate closes, so the compressed copy ends with the raw chunks.
    const mediaDone = new Promise<void>((resolve) => {
      setTimeout(
        () => {
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
        },
        msUntil(ctx, at),
      );
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
    elapsedMs() {
      const now = stopTime === null ? ctx.currentTime : Math.min(ctx.currentTime, stopTime);
      return Math.max(0, (now - startTime) * 1000);
    },
    stop() {
      if (!stopping) {
        stopTime = Math.max(ctx.currentTime + LOOKAHEAD_S, startTime);
        stopping = finish(stopTime);
      }
      return stopping;
    },
    abort() {
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
