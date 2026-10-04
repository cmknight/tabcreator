// Decoding a take's compressed audio to PCM (ticket 12; spine AD-15): analysis's
// source when the raw file is gone. It decodes at the take's recorded rate (`take.sampleRate`),
// not at the file's native rate: the `OfflineAudioContext` is created at the take's rate, so
// `decodeAudioData` resamples the file to it (and not to a realtime context's device rate),
// keeping the PCM on the same grid as the raw file. Every channel is
// averaged to mono. Rejects only with an `AppError` (spine AD-10): `audio-missing`, with the
// cause attached, when the file cannot be decoded.

import { AppError } from '../model/errors';

export interface DecodedAudio {
  /** Mono samples, −1..1. */
  pcm: Float32Array;
  /** The decoded buffer's sample rate as reported (the actual rate, AD-15): the take's rate. */
  sampleRate: number;
}

/**
 * Decodes `blob` (any format `model/audio-format.ts` lists) to mono PCM resampled to
 * `sampleRate`, the take's recorded rate (not the file's native rate). Rejects with `audio-missing` when it cannot be decoded (a corrupt or
 * unsupported file, or a rate the browser refuses).
 */
export async function decodeTakeAudio(blob: Blob, sampleRate: number): Promise<DecodedAudio> {
  let buffer: AudioBuffer;
  try {
    const bytes = await blob.arrayBuffer();
    // The context only decodes; its length is irrelevant but must be at least one frame.
    const ctx = new OfflineAudioContext(1, 1, sampleRate);
    buffer = await ctx.decodeAudioData(bytes);
  } catch (err) {
    const detail = err instanceof Error && err.message ? `: ${err.message}` : '';
    throw new AppError('audio-missing', `The take's audio could not be decoded${detail}`, {
      cause: err,
    });
  }
  return { pcm: toMono(buffer), sampleRate: buffer.sampleRate };
}

/** The buffer's channels averaged into one. */
function toMono(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  if (channels === 1) return buffer.getChannelData(0).slice();
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] = (mono[i] ?? 0) + (data[i] ?? 0);
  }
  for (let i = 0; i < mono.length; i++) mono[i] = (mono[i] ?? 0) / channels;
  return mono;
}
