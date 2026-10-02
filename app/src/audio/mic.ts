// Microphone access and the live input (spine AD-2: the only getUserMedia / AudioContext /
// AnalyserNode owner). Processing is always off, so the engine hears the raw instrument.

import { AppError } from '../model/errors';

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

/** Opens the mic. Rejects with `AppError` `mic-failed` (story 2.5 maps the specific causes). */
export async function requestMic(deviceId?: string): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(micConstraints(deviceId));
  } catch (err) {
    throw new AppError('mic-failed', 'getUserMedia rejected', { cause: err });
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

/** Wraps `stream` in an AudioContext with one analyser. Throws `AppError` `mic-failed`. */
export function openInput(stream: MediaStream): MicInput {
  let ctx: AudioContext | undefined;
  try {
    ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = ANALYSER_FFT_SIZE;
    ctx.createMediaStreamSource(stream).connect(analyser);
    // Opened from the Allow click, so the context may start; resuming is best-effort.
    void ctx.resume().catch(() => {});
    const frame = new Float32Array(analyser.fftSize);
    const context = ctx;
    return {
      analyser,
      readRms() {
        analyser.getFloatTimeDomainData(frame);
        let sum = 0;
        for (const v of frame) sum += v * v;
        return Math.sqrt(sum / frame.length);
      },
      close() {
        stopTracks(stream);
        void context.close().catch(() => {});
      },
    };
  } catch (err) {
    stopTracks(stream);
    void ctx?.close().catch(() => {});
    throw new AppError('mic-failed', 'Opening the audio input failed', { cause: err });
  }
}
