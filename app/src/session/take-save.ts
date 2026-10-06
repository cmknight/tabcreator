// The take save step shared by recording and recovery (spine AD-9, AD-14, AD-15): the shortest
// take kept, the clip counter and the save itself (the compressed copy written, then the take
// patched `recorded`). take-lifecycle.ts's `finishTake` and recording-recovery.ts's `rebuild`
// both save through `saveTake`.

import { CLIP_LEVEL } from '../model/level-warnings';
import type { StopReason } from '../model/types';
import type { TakePatch } from '../storage/db';

/**
 * The shortest take kept, ms (spine AD-9): a shorter take is deleted at stop, and a shorter
 * unfinished take is deleted by the recovery scan.
 */
export const MIN_TAKE_MS = 500;

/**
 * Whether a take of `durationMs` is under `MIN_TAKE_MS`, compared in whole (rounded) ms: the one
 * test recording (at stop) and recovery (at the scan) both apply, so a take gets the same verdict
 * on both paths (499.6 ms rounds to 500 and is kept).
 */
export function isTooShort(durationMs: number): boolean {
  return !(Math.round(durationMs) >= MIN_TAKE_MS);
}

/** How many of `samples` clipped (|x| ≥ `CLIP_LEVEL`). */
export function countClipped(samples: Float32Array): number {
  let count = 0;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]!) >= CLIP_LEVEL) count++;
  }
  return count;
}

/** A take's clipped samples, counted as its audio arrives; saved as `clipped`. */
export interface ClipCounter {
  /** Adds a count already made (the capture's worklet counts each chunk against `CLIP_LEVEL`). */
  add(clipped: number): void;
  /** Counts `samples` here (`countClipped`). */
  addSamples(samples: Float32Array): void;
  /** Any sample clipped so far. */
  readonly clipped: boolean;
}

export function createClipCounter(): ClipCounter {
  let count = 0;
  return {
    add(clipped) {
      count += clipped;
    },
    addSamples(samples) {
      count += countClipped(samples);
    },
    get clipped() {
      return count > 0;
    },
  };
}

/** The storage calls a save makes. */
export interface SaveTarget {
  writeCompressed: (id: string, blob: Blob) => Promise<void>;
  patchTake: (id: string, patch: TakePatch, writer: 'recording-session') => Promise<unknown>;
}

/** What a save writes. */
export interface TakeSave {
  /** The compressed copy to write; null when one is already saved (it is kept). */
  blob: Blob | null;
  /** The saved copy's MIME type, as patched. */
  audioMime: string;
  durationMs: number;
  stopReason: StopReason;
  clipped: boolean;
  /** Runs after the compressed copy is written, before the patch (closing the raw writer). */
  afterWrite?: () => Promise<void>;
}

/**
 * Saves take `id`: writes the compressed copy (unless `blob` is null), runs `afterWrite`, then
 * patches the take `recorded` with its length, MIME type, stop reason and `clipped`. Rejects as
 * the first failing step does.
 */
export async function saveTake(target: SaveTarget, id: string, save: TakeSave): Promise<void> {
  if (save.blob) await target.writeCompressed(id, save.blob);
  await save.afterWrite?.();
  await target.patchTake(
    id,
    {
      status: 'recorded',
      durationMs: save.durationMs,
      audioMime: save.audioMime,
      stopReason: save.stopReason,
      clipped: save.clipped,
    },
    'recording-session',
  );
}

/**
 * Asks for persistent storage (storage/persistence.ts `requestPersistOnce`) after a take is
 * saved, by recording or recovery. Fire and forget: never throws into the save's outcome.
 */
export function requestPersist(deps: { requestPersist?: () => void }): void {
  try {
    deps.requestPersist?.();
  } catch {
    // Fire and forget: the take is saved either way.
  }
}
