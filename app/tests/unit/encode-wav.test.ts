import { describe, expect, it } from 'vitest';
import { encodeWav, encodeWavBlob } from '../../src/audio/encode';
import { extensionFor } from '../../src/model/audio-format';

// Story 3.11: recovery's WAV fallback, a pure 16-bit PCM encoder.

const text = (bytes: Uint8Array, at: number, n: number) =>
  String.fromCharCode(...bytes.subarray(at, at + n));

describe('encodeWav', () => {
  it('writes a 44-byte mono 16-bit PCM RIFF header at the given rate', () => {
    const bytes = encodeWav(new Float32Array(3), 44_100);
    const view = new DataView(bytes.buffer);
    expect(bytes.length).toBe(44 + 6);
    expect(text(bytes, 0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + 6);
    expect(text(bytes, 8, 4)).toBe('WAVE');
    expect(text(bytes, 12, 4)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(44_100);
    expect(view.getUint32(28, true)).toBe(88_200);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(bytes, 36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(6);
  });

  it('writes the samples little-endian, scaled and clamped to 16 bits', () => {
    const bytes = encodeWav(new Float32Array([0, 1, -1, 0.5, -0.5, 2, -3, NaN]), 48_000);
    const view = new DataView(bytes.buffer);
    const read = Array.from({ length: 8 }, (_, i) => view.getInt16(44 + i * 2, true));
    expect(read).toEqual([0, 32767, -32768, 16384, -16384, 32767, -32768, 0]);
  });

  it('encodes no samples as a header only', () => {
    const bytes = encodeWav(new Float32Array(0), 48_000);
    expect(bytes.length).toBe(44);
    expect(new DataView(bytes.buffer).getUint32(40, true)).toBe(0);
  });

  it('encodeWavBlob: the bytes as an audio/wav Blob that maps to the .wav path', async () => {
    const blob = encodeWavBlob(new Float32Array([0.5]), 48_000);
    expect(blob.type).toBe('audio/wav');
    expect(extensionFor(blob.type)).toBe('wav');
    expect(blob.size).toBe(46);
  });
});
