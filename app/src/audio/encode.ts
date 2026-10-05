// Re-encoding raw PCM (story 3.11, spine AD-2, AD-9): recovery rebuilds an unfinished take's
// compressed copy from its raw file. `encodePcm` plays the samples through an AudioContext at
// their own rate into a MediaStreamDestination recorded by MediaRecorder (Opus, 96 kbps, as a
// live take), so it runs in real time. `encodeWav` is recovery's fallback when that fails: a
// pure 16-bit PCM WAV encoder. `encodePcm` rejects only with an `AppError` (spine AD-10):
// `storage-failed` for its own failures, any other `AppError` passed through as it is.

import { AppError, isAppError } from '../model/errors';
import { resumeWithin } from './context-resume';
import { createCompressedOutput, RECORDING_MIME } from './recorder';

/** The WAV fallback's MIME type; `model/audio-format.ts` lists it. */
export const WAV_MIME = 'audio/wav';
/** How long past the audio's own length the encode may run before it counts as failed, ms. */
const ENCODE_SLACK_MS = 10_000;
/** How long the context may take to start, ms. */
const RESUME_TIMEOUT_MS = 2000;
/** MediaRecorder's timeslice, ms: data is handed over every second rather than all at the end. */
const TIMESLICE_MS = 1000;
/** How far ahead of the audio clock playback starts, s, so the recorder is running first. */
const LEAD_S = 0.1;
/** How long the recorder keeps running after playback ends, ms. */
const TAIL_MS = 250;

/** An encode failure as the `storage-failed` AppError, keeping its message and cause. */
function encodeFailed(message: string, cause?: unknown): AppError {
  return new AppError('storage-failed', message, cause === undefined ? undefined : { cause });
}

/** `err` as an AppError: itself when it is one, else `storage-failed` with its message. */
function asEncodeError(err: unknown): AppError {
  if (isAppError(err)) return err;
  return encodeFailed(err instanceof Error ? err.message : 'The encode failed', err);
}

/**
 * Encodes mono `samples` at `sampleRate` as `RECORDING_MIME` (96 kbps) through MediaRecorder,
 * in real time. Resolves with a Blob of that type; rejects with an `AppError`: `storage-failed` when
 * there is nothing to encode, the context does not run, the recorder fails or yields nothing, or
 * the encode overruns the audio's length (any other failure too); an `AppError` thrown inside is
 * passed through with its own code.
 */
export async function encodePcm(samples: Float32Array, sampleRate: number): Promise<Blob> {
  try {
    return await encode(samples, sampleRate);
  } catch (err) {
    throw asEncodeError(err);
  }
}

async function encode(samples: Float32Array, sampleRate: number): Promise<Blob> {
  if (samples.length === 0) throw encodeFailed('Nothing to encode');
  const ctx = new AudioContext({ sampleRate });
  let source: AudioBufferSourceNode | undefined;
  let destination: MediaStreamAudioDestinationNode | undefined;
  let media: MediaRecorder | undefined;
  let tailTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!(await resumeWithin(ctx, RESUME_TIMEOUT_MS))) {
      throw encodeFailed(`The audio context is ${ctx.state}`);
    }
    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const node = ctx.createBufferSource();
    source = node;
    node.buffer = buffer;
    const parts: Blob[] = [];
    const output = createCompressedOutput(ctx, node, parts);
    destination = output.destination;
    const recorder = output.recorder;
    media = recorder;
    const lengthMs = (samples.length / sampleRate) * 1000;
    await new Promise<void>((resolve, reject) => {
      let failed = false;
      const timer = setTimeout(() => {
        failed = true;
        reject(encodeFailed('The encode did not finish in time'));
      }, lengthMs + ENCODE_SLACK_MS);
      recorder.onerror = () => {
        failed = true;
        clearTimeout(timer);
        reject(encodeFailed('MediaRecorder failed'));
      };
      recorder.onstop = () => {
        clearTimeout(timer);
        if (!failed) resolve();
      };
      // The recorder stops once the whole buffer has played, plus a moment for the encoder's
      // pipeline to take the tail.
      node.onended = () => {
        tailTimer = setTimeout(() => {
          if (recorder.state !== 'inactive') recorder.stop();
        }, TAIL_MS);
      };
      try {
        recorder.start(TIMESLICE_MS);
        node.start(ctx.currentTime + LEAD_S);
      } catch (err) {
        clearTimeout(timer);
        failed = true;
        reject(asEncodeError(err));
      }
    });
    if (parts.length === 0) throw encodeFailed('MediaRecorder produced no data');
    return new Blob(parts, { type: RECORDING_MIME });
  } finally {
    // Torn down on success and failure alike: nothing keeps running after the encode settles.
    clearTimeout(tailTimer);
    if (source) source.onended = null;
    try {
      if (media && media.state !== 'inactive') media.stop();
    } catch {
      // Already stopped.
    }
    try {
      source?.stop();
    } catch {
      // Never started, or already stopped.
    }
    for (const track of destination?.stream.getTracks() ?? []) track.stop();
    ctx.close().catch(() => {});
  }
}

/** `encodeWav` as a Blob of type `WAV_MIME`, ready for `writeCompressed`. */
export function encodeWavBlob(samples: Float32Array, sampleRate: number): Blob {
  return new Blob([encodeWav(samples, sampleRate)], { type: WAV_MIME });
}

/**
 * Mono `samples` (−1..1, clamped) at `sampleRate` as a 16-bit PCM WAV file: the 44-byte RIFF
 * header, then little-endian samples.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i] || 0));
    view.setInt16(44 + i * 2, x < 0 ? Math.round(x * 0x8000) : Math.round(x * 0x7fff), true);
  }
  return bytes;
}
