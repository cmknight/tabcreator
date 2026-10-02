// Microphone access and the live input (spine AD-2: the only getUserMedia / AudioContext /
// AnalyserNode owner). Processing is always off, so the engine hears the raw instrument.

import { AppError, type AppErrorCode } from '../model/errors';

/** Analyser window shared by the meter and the tuner. */
export const ANALYSER_FFT_SIZE = 4096;

/** The exact constraints for a mic request; `deviceId` is pinned only when one is given. */
export function micConstraints(deviceId?: string): MediaStreamConstraints {
  return {
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  };
}

/** The `getUserMedia` rejection names with a specific code (AD-10); any other name is `mic-failed`. */
const MIC_ERROR_CODES: Readonly<Record<string, AppErrorCode>> = {
  NotAllowedError: 'mic-denied',
  SecurityError: 'mic-denied',
  NotFoundError: 'mic-no-device',
  OverconstrainedError: 'mic-no-device',
  NotReadableError: 'mic-in-use',
  AbortError: 'mic-in-use',
};

/** The AD-10 code for a `getUserMedia` rejection, by the error's `name`. */
export function micErrorCode(err: unknown): AppErrorCode {
  const name =
    typeof err === 'object' && err !== null && 'name' in err && typeof err.name === 'string'
      ? err.name
      : '';
  const code = Object.hasOwn(MIC_ERROR_CODES, name) ? MIC_ERROR_CODES[name] : undefined;
  return code ?? 'mic-failed';
}

/**
 * Opens the mic. Rejects with `AppError` `mic-denied`, `mic-no-device`, `mic-in-use` or
 * `mic-failed`, mapped from the rejection's name by `micErrorCode`.
 */
export async function requestMic(deviceId?: string): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(micConstraints(deviceId));
  } catch (err) {
    throw new AppError(micErrorCode(err), 'getUserMedia rejected', { cause: err });
  }
}

export type MicPermission = 'granted' | 'prompt' | 'denied' | 'unknown';

/**
 * The browser's microphone permission state, without prompting. `unknown` when the
 * Permissions API is missing, rejects or reports a state it does not define.
 */
export async function micPermission(): Promise<MicPermission> {
  try {
    const { state } = await navigator.permissions.query({ name: 'microphone' });
    return state === 'granted' || state === 'prompt' || state === 'denied' ? state : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** One open mic stream with its single shared analyser. */
export interface MicInput {
  readonly analyser: AnalyserNode;
  /** Linear RMS (0..1) of the analyser's current time-domain frame. */
  readRms(): number;
  /** Stops the stream's tracks and closes the AudioContext. */
  close(): void;
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/**
 * Wraps `stream` in an AudioContext with one analyser. Throws `AppError` `mic-failed`.
 * `onEnded` is called once, with `AppError` `mic-lost`, when a track of the stream ends on its
 * own (access revoked, device gone); never after `close()`.
 */
export function openInput(stream: MediaStream, onEnded?: (error: AppError) => void): MicInput {
  let ctx: AudioContext | undefined;
  const tracks = stream.getTracks();
  let closed = false;
  const handleEnded = () => {
    if (closed) return;
    closed = true;
    for (const track of tracks) track.removeEventListener('ended', handleEnded);
    onEnded?.(new AppError('mic-lost', 'The microphone track ended'));
  };
  const detach = () => {
    closed = true;
    for (const track of tracks) track.removeEventListener('ended', handleEnded);
  };
  try {
    ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = ANALYSER_FFT_SIZE;
    ctx.createMediaStreamSource(stream).connect(analyser);
    // Opened from the Allow click, so the context may start; resuming is best-effort.
    void ctx.resume().catch(() => {});
    const frame = new Float32Array(analyser.fftSize);
    const context = ctx;
    for (const track of tracks) track.addEventListener('ended', handleEnded);
    // A track that ended before the listener was attached fires no event.
    if (tracks.some((track) => track.readyState === 'ended')) queueMicrotask(handleEnded);
    return {
      analyser,
      readRms() {
        analyser.getFloatTimeDomainData(frame);
        let sum = 0;
        for (const v of frame) sum += v * v;
        return Math.sqrt(sum / frame.length);
      },
      close() {
        detach();
        stopTracks(stream);
        void context.close().catch(() => {});
      },
    };
  } catch (err) {
    detach();
    stopTracks(stream);
    void ctx?.close().catch(() => {});
    throw new AppError('mic-failed', 'Opening the audio input failed', { cause: err });
  }
}
