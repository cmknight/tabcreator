import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeTakeAudio } from '../../src/audio/decode';
import { isAppError } from '../../src/model/errors';

// audio/decode.ts (ticket 12, AD-15) against a stubbed OfflineAudioContext: the context is made
// at the take's rate, channels are averaged to mono, the buffer's own rate is returned, and a
// failed decode rejects with audio-missing, its cause kept.

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A minimal AudioBuffer over `channels`, at `sampleRate`. */
function fakeBuffer(channels: number[][], sampleRate: number): AudioBuffer {
  const data = channels.map((c) => Float32Array.from(c));
  return {
    numberOfChannels: data.length,
    length: data[0]?.length ?? 0,
    sampleRate,
    getChannelData: (i: number) => data[i]!,
  } as unknown as AudioBuffer;
}

/** Stubs OfflineAudioContext; `decode` answers decodeAudioData. Returns the constructor mock. */
function stubContext(decode: (bytes: ArrayBuffer) => Promise<AudioBuffer>) {
  const ctor = vi.fn(function OfflineAudioContext(
    this: Record<string, unknown>,
    ...args: [channels: number, length: number, rate: number]
  ) {
    expect(args).toHaveLength(3);
    this.decodeAudioData = decode;
  });
  vi.stubGlobal('OfflineAudioContext', ctor);
  return ctor;
}

const blob = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });

describe('decodeTakeAudio', () => {
  it('decodes on an OfflineAudioContext at the take rate and passes the file bytes', async () => {
    let seen: ArrayBuffer | null = null;
    const ctor = stubContext(async (bytes) => {
      seen = bytes;
      return fakeBuffer([[0.1, 0.2]], 48_000);
    });
    await decodeTakeAudio(blob(), 48_000);
    expect(ctor).toHaveBeenCalledTimes(1);
    const [channels, length, rate] = ctor.mock.calls[0]!;
    expect(channels).toBe(1);
    expect(length).toBeGreaterThanOrEqual(1);
    expect(rate).toBe(48_000);
    expect(new Uint8Array(seen!)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('a mono buffer comes back as its own samples', async () => {
    stubContext(async () => fakeBuffer([[0.5, -0.25, 0]], 48_000));
    const { pcm } = await decodeTakeAudio(blob(), 48_000);
    expect(Array.from(pcm)).toEqual([0.5, -0.25, 0]);
  });

  it('a stereo buffer is averaged to mono', async () => {
    stubContext(async () =>
      fakeBuffer(
        [
          [1, 0.5, -1],
          [0, -0.5, -1],
        ],
        48_000,
      ),
    );
    const { pcm } = await decodeTakeAudio(blob(), 48_000);
    expect(Array.from(pcm)).toEqual([0.5, 0, -1]);
  });

  it("returns the decoded buffer's own sample rate", async () => {
    stubContext(async () => fakeBuffer([[0]], 44_100));
    const { sampleRate } = await decodeTakeAudio(blob(), 48_000);
    expect(sampleRate).toBe(44_100);
  });

  it('an undecodable file rejects with audio-missing, keeping the cause', async () => {
    const cause = new DOMException('Unable to decode audio data', 'EncodingError');
    stubContext(() => Promise.reject(cause));
    const err: unknown = await decodeTakeAudio(blob(), 48_000).catch((e: unknown) => e);
    expect(isAppError(err)).toBe(true);
    expect(err).toMatchObject({ code: 'audio-missing' });
    expect((err as Error).cause).toBe(cause);
  });

  it('a context the browser refuses (e.g. its rate) rejects with audio-missing', async () => {
    const cause = new DOMException('rate out of range', 'NotSupportedError');
    vi.stubGlobal(
      'OfflineAudioContext',
      vi.fn(function OfflineAudioContext() {
        throw cause;
      }),
    );
    const err: unknown = await decodeTakeAudio(blob(), 1).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'audio-missing' });
    expect((err as Error).cause).toBe(cause);
  });
});
