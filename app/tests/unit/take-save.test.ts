import { describe, expect, it, vi } from 'vitest';
import { CLIP_LEVEL } from '../../src/model/level-warnings';
import {
  countClipped,
  createClipCounter,
  MIN_TAKE_MS,
  saveTake,
  type SaveTarget,
} from '../../src/session/take-save';

// The take save step shared by recording and recovery: the minimum, the clip counter and the
// save (compressed copy, then the `recorded` patch).

describe('MIN_TAKE_MS', () => {
  it('is 0.5 s (spine AD-9)', () => {
    expect(MIN_TAKE_MS).toBe(500);
  });
});

/** CLIP_LEVEL as the smallest Float32 at or above it (a Float32Array rounds to nearest). */
const AT_CLIP = Math.min(1, CLIP_LEVEL + 1e-6);

describe('countClipped', () => {
  it('counts samples at or above CLIP_LEVEL in either direction', () => {
    const below = Math.max(0, CLIP_LEVEL - 1e-4);
    expect(countClipped(new Float32Array([0, below, -below]))).toBe(0);
    expect(countClipped(new Float32Array([AT_CLIP, 0.1, -1, 1]))).toBe(3);
  });

  it('one sample at CLIP_LEVEL in a second of raw clips', () => {
    const samples = new Float32Array(48_000).fill(0.1);
    samples[100] = -AT_CLIP;
    expect(countClipped(samples)).toBe(1);
  });
});

describe('createClipCounter', () => {
  it('is not clipped until a count or a clipped sample arrives', () => {
    const clips = createClipCounter();
    expect(clips.clipped).toBe(false);
    clips.add(0);
    clips.addSamples(new Float32Array([0.1, -0.2]));
    expect(clips.clipped).toBe(false);
    clips.add(2);
    expect(clips.clipped).toBe(true);
  });

  it('counts samples itself', () => {
    const clips = createClipCounter();
    clips.addSamples(new Float32Array([0, -1]));
    expect(clips.clipped).toBe(true);
  });
});

describe('saveTake', () => {
  function target(log: string[]): SaveTarget {
    return {
      writeCompressed: vi.fn(async (id: string, blob: Blob) => {
        log.push(`writeCompressed ${id} ${blob.type}`);
      }),
      patchTake: vi.fn(async (id: string) => {
        log.push(`patchTake ${id}`);
      }),
    };
  }

  it('writes the compressed copy, runs afterWrite, then patches the take recorded', async () => {
    const log: string[] = [];
    const t = target(log);
    await saveTake(t, 'a', {
      blob: new Blob(['x'], { type: 'audio/wav' }),
      audioMime: 'audio/wav',
      durationMs: 1234,
      stopReason: 'user',
      clipped: true,
      afterWrite: async () => {
        log.push('afterWrite');
      },
    });
    expect(log).toEqual(['writeCompressed a audio/wav', 'afterWrite', 'patchTake a']);
    expect(t.patchTake).toHaveBeenCalledWith(
      'a',
      {
        status: 'recorded',
        durationMs: 1234,
        audioMime: 'audio/wav',
        stopReason: 'user',
        clipped: true,
      },
      'recording-session',
    );
  });

  it('with no blob, keeps the saved copy: only the patch is written', async () => {
    const log: string[] = [];
    await saveTake(target(log), 'b', {
      blob: null,
      audioMime: 'audio/ogg',
      durationMs: 900,
      stopReason: 'recovered',
      clipped: false,
    });
    expect(log).toEqual(['patchTake b']);
  });

  it('a failed write rejects before the patch', async () => {
    const log: string[] = [];
    const t = target(log);
    vi.mocked(t.writeCompressed).mockRejectedValueOnce(new Error('disk'));
    await expect(
      saveTake(t, 'c', {
        blob: new Blob(['x']),
        audioMime: 'audio/webm',
        durationMs: 900,
        stopReason: 'user',
        clipped: false,
      }),
    ).rejects.toThrow('disk');
    expect(t.patchTake).not.toHaveBeenCalled();
  });
});
