// Recovery of unfinished takes (story 3.11, US-3.2, spine AD-9, AD-14, AD-15): a module of the
// recording store, which composes it and publishes its list in the snapshot (`recovered`).
//
// `scan()` runs once the instance lock is held (instance-lock.ts's `onHeld`, after the handover
// window): it removes, best-effort and silently, raw and compressed files whose take does not
// exist and unfinished takes (`status === 'recording'`) with under `MIN_RECOVERED_MS` of raw audio;
// every other unfinished take is offered, oldest first. This tab's own take is never touched.
//
// `open(id)` rebuilds an offered take: compressed audio already saved is kept (never
// overwritten), else the raw file is re-encoded (falling back to WAV); then the take is patched
// `recorded` with `stopReason: 'recovered'` and its Tab opened. The raw file stays for analysis.
// `discard(id)` deletes the take and its files.

import { CLIP_LEVEL } from '../model/level-warnings';
import type { Take } from '../model/types';
import type { CompressedFile } from '../storage/audio-store';
import type { TakePatch } from '../storage/db';

/** The shortest unfinished take offered, ms (spine AD-9); a shorter one is deleted. */
const MIN_RECOVERED_MS = 500;

/** An unfinished take offered for recovery. */
export interface RecoveredTake {
  id: string;
  /** When it was created (ISO 8601), for the banner's time. */
  createdAt: string;
  /** The raw audio's length, ms. */
  durationMs: number;
  /** Open is rebuilding it: both actions are unavailable. */
  opening: boolean;
}

/** The shell functions recovery drives; injected so tests can fake storage/ and audio/. */
export interface RecoveryDeps {
  /** All takes, oldest first. */
  listTakes: () => Promise<Take[]>;
  getTake: (id: string) => Promise<Take | null>;
  /** Take ids with a raw file. */
  listRaw: () => Promise<string[]>;
  /** Compressed files with a known extension. */
  listCompressed: () => Promise<CompressedFile[]>;
  /** The raw file's sample count from its size; 0 with no raw file. */
  rawSampleCount: (id: string) => Promise<number>;
  readRaw: (id: string) => Promise<Float32Array>;
  readCompressed: (id: string) => Promise<Blob | null>;
  deleteRaw: (id: string) => Promise<void>;
  deleteAudio: (id: string) => Promise<void>;
  /** Re-encodes PCM as the recording format (audio/encode.ts `encodePcm`). */
  encodePcm: (samples: Float32Array, sampleRate: number) => Promise<Blob>;
  /** The WAV fallback, as a Blob of type `audio/wav`. */
  encodeWav: (samples: Float32Array, sampleRate: number) => Blob;
}

/** What recovery needs from the recording store besides its own deps. */
export interface RecoveryHost {
  /** The take this tab is recording (or creating, or saving); never offered or cleaned up. */
  activeTakeId(): string | null;
  /** This tab is counting in, recording or saving a take. */
  isRecording(): boolean;
  /** The store is handed over to another tab: nothing more is scanned. */
  handedOver(): boolean;
  /** Publishes the offered takes. */
  publish(recovered: readonly RecoveredTake[]): void;
  writeCompressed: (id: string, blob: Blob) => Promise<void>;
  patchTake: (id: string, patch: TakePatch, writer: 'recording-session') => Promise<unknown>;
  deleteTake: (id: string, writer: 'recording-session') => Promise<unknown>;
  navigate: (id: string) => void;
}

export interface RecordingRecovery {
  /** The start-up scan. A call while one runs returns that one; never rejects. */
  scan(): Promise<void>;
  /** Rebuilds the offered take `id` and opens its Tab. Never rejects. */
  open(id: string): Promise<void>;
  /**
   * Deletes the offered take `id` (record and files). `deleted` runs once the delete has
   * committed, just before the banner's entry goes (the UI moves focus there). Never rejects.
   */
  discard(id: string, deleted?: () => void): Promise<void>;
}

/** Runs `fn`, ignoring a failure (best-effort cleanup; the next start retries it). */
async function quietly(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    // Left for the next start's scan.
  }
}

/** Whether any of `samples` clipped (|x| ≥ `CLIP_LEVEL`). */
function anyClipped(samples: Float32Array): boolean {
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]!) >= CLIP_LEVEL) return true;
  }
  return false;
}

export function createRecordingRecovery(deps: RecoveryDeps, host: RecoveryHost): RecordingRecovery {
  let offered: readonly RecoveredTake[] = [];
  let scanning: Promise<void> | null = null;
  /** Takes being opened or discarded, so a second click does nothing. */
  const busy = new Set<string>();

  function publish(next: readonly RecoveredTake[]) {
    offered = next;
    host.publish(offered);
  }

  const drop = (id: string) => publish(offered.filter((t) => t.id !== id));

  const setOpening = (id: string, opening: boolean) =>
    publish(offered.map((t) => (t.id === id ? { ...t, opening } : t)));

  /** A file's take is missing (re-read just before the delete, and not this tab's own). */
  async function orphan(id: string): Promise<boolean> {
    if (id === host.activeTakeId()) return false;
    return (await deps.getTake(id)) === null;
  }

  async function runScan(): Promise<void> {
    if (host.handedOver()) return;
    const takes = await deps.listTakes();
    const known = new Set(takes.map((t) => t.id));

    const raws = await deps.listRaw().catch(() => [] as string[]);
    for (const id of raws) {
      if (known.has(id)) continue;
      await quietly(async () => {
        if (await orphan(id)) await deps.deleteRaw(id);
      });
    }
    const compressed = await deps.listCompressed().catch(() => [] as CompressedFile[]);
    for (const id of new Set(compressed.map((f) => f.id))) {
      if (known.has(id)) continue;
      await quietly(async () => {
        if (await orphan(id)) await deps.deleteAudio(id);
      });
    }

    const found: RecoveredTake[] = [];
    for (const take of takes) {
      if (take.status !== 'recording' || take.id === host.activeTakeId()) continue;
      let samples: number;
      try {
        samples = await deps.rawSampleCount(take.id);
      } catch {
        // Unreadable now: left for the next start.
        continue;
      }
      const seconds = take.sampleRate > 0 ? samples / take.sampleRate : 0;
      if (!(seconds * 1000 >= MIN_RECOVERED_MS)) {
        await quietly(async () => {
          // Re-read: only a take still unfinished is deleted.
          const now = await deps.getTake(take.id);
          if (now?.status === 'recording') await host.deleteTake(take.id, 'recording-session');
        });
        continue;
      }
      const durationMs = Math.round(seconds * 1000);
      found.push({ id: take.id, createdAt: take.createdAt, durationMs, opening: false });
    }
    if (host.handedOver()) return;
    // An Open or Discard already under way keeps its entry as it is.
    const kept = offered.filter((t) => busy.has(t.id));
    publish([
      ...found.map((t) => kept.find((k) => k.id === t.id) ?? t),
      ...kept.filter((k) => !found.some((t) => t.id === k.id)),
    ]);
  }

  function scan(): Promise<void> {
    scanning ??= runScan()
      .catch(() => {
        // The database could not be read: nothing is offered; the next start retries.
      })
      .finally(() => {
        scanning = null;
      });
    return scanning;
  }

  async function rebuild(id: string): Promise<void> {
    const take = await deps.getTake(id);
    if (!take || take.status !== 'recording') {
      drop(id);
      return;
    }
    const samples = await deps.readRaw(id);
    const durationMs = Math.round((samples.length / take.sampleRate) * 1000);
    let audioMime: string;
    const existing = await deps.readCompressed(id);
    if (existing) {
      // Never overwritten, and no second format (writeCompressed deletes the others).
      audioMime = existing.type;
    } else {
      let blob: Blob;
      try {
        blob = await deps.encodePcm(samples, take.sampleRate);
      } catch {
        blob = deps.encodeWav(samples, take.sampleRate);
      }
      // The encode runs in real time: check again that nothing was saved meanwhile.
      const meanwhile = await deps.readCompressed(id);
      if (meanwhile) {
        audioMime = meanwhile.type;
      } else {
        await host.writeCompressed(id, blob);
        audioMime = blob.type;
      }
    }
    await host.patchTake(
      id,
      {
        status: 'recorded',
        stopReason: 'recovered',
        durationMs,
        audioMime,
        clipped: anyClipped(samples),
      },
      'recording-session',
    );
    drop(id);
    if (!host.isRecording()) host.navigate(id);
  }

  async function open(id: string): Promise<void> {
    if (busy.has(id) || !offered.some((t) => t.id === id)) return;
    busy.add(id);
    setOpening(id, true);
    try {
      await rebuild(id);
    } catch {
      // The banner comes back with its actions, unless the take is no longer unfinished.
      const still = await deps.getTake(id).then(
        (take) => take?.status === 'recording',
        () => true,
      );
      if (still) setOpening(id, false);
      else drop(id);
    } finally {
      busy.delete(id);
    }
  }

  async function discard(id: string, deleted?: () => void): Promise<void> {
    if (busy.has(id) || !offered.some((t) => t.id === id)) return;
    busy.add(id);
    try {
      await host.deleteTake(id, 'recording-session');
      try {
        deleted?.();
      } catch {
        // The take is gone all the same.
      }
      drop(id);
    } catch {
      // The banner stays; Discard can be tried again.
    } finally {
      busy.delete(id);
    }
  }

  return { scan, open, discard };
}
