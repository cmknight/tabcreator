import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodePcm } from '../../src/audio/encode';
import { isAppError } from '../../src/model/errors';

// encode.ts rejects only with AppError (spine AD-10): the `storage-failed` code with the
// failure's original message.

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('encodePcm', () => {
  it('rejects nothing to encode with AppError storage-failed, keeping its message', async () => {
    const err: unknown = await encodePcm(new Float32Array(0), 48_000).catch((e: unknown) => e);
    expect(isAppError(err)).toBe(true);
    expect(err).toMatchObject({ code: 'storage-failed', message: 'Nothing to encode' });
  });

  it('a failure to build the audio graph rejects as storage-failed with its cause', async () => {
    const cause = new Error('AudioContext construction failed');
    vi.stubGlobal(
      'AudioContext',
      vi.fn(function AudioContext() {
        throw cause;
      }),
    );
    const err: unknown = await encodePcm(new Float32Array(10), 48_000).catch((e: unknown) => e);
    expect(isAppError(err)).toBe(true);
    expect(err).toMatchObject({ code: 'storage-failed', message: cause.message });
    expect((err as Error).cause).toBe(cause);
  });
});
