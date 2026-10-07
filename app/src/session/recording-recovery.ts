// Recovery of unfinished takes (story 3.11, US-3.2, spine AD-9, AD-14, AD-15): a module of the
// recording store, which composes it and publishes its list in the snapshot (`recovered`).
//
// `scan()` runs once the instance lock is held (instance-lock.ts's `onHeld`, after the handover
// window): it removes, best-effort and silently, raw and compressed files whose take does not
// exist, the files of an analysed take whose audio was deleted (`audioMime` null: a Library
// "Delete audio only" whose best-effort file removal failed, story 6.2), and unfinished takes
// (`status === 'recording'`) with under `MIN_TAKE_MS` of raw audio; every other unfinished take
// is offered, oldest first. This tab's own take is never touched.
//
// `open(id)` rebuilds an offered take: compressed audio already saved is kept (never
// overwritten), else the raw file is re-encoded (falling back to WAV); then the take is patched
// `recorded` with `stopReason: 'recovered'` and its Tab opened. The raw file stays for analysis.
// The minimum (`isTooShort`), the clip count and the save step are shared with recording
// (take-save.ts). `discard(id)` re-reads the take and deletes it with its files only while it is
// still unfinished; a take saved meanwhile only loses its banner.
//
// Never a saved take (story 5.2): the scan skips this tab's take as seen before and after the
// take list is read, and re-reads each take just before offering it, so a take saved in between
// is never offered. `reoffer(id)` is the scan for one take, run when this tab's own save of it
// failed: it is offered again in the same session (or, too short, deleted).
//
// A handover cancels Open (story 5.3): the rebuild re-checks `handedOver()` after each await and
// re-reads the take just before its save, so after a handover it writes nothing and never
// navigates; the take stays `recording` for the new holder's scan.
//
// Metadata from the kept copy (DS2, story "Recovered take metadata from its compressed copy"):
// when the take keeps a compressed copy (saved before Open, or meanwhile), its `durationMs` is the
// decoded copy's length, which can exceed the raw file after raw append failures or an early
// storage-full; clipping counts the raw samples plus the decoded copy past them. A copy that does
// not decode keeps the raw-based values. The banner's `durationMs` stays the raw length.
//
// Never a restore's audio (story "Streaming restore and restore races"): while a restore runs
// (`isRestoreRunning`, storage/restore-state.ts) the scan deletes no file. The guard covers every
// file written after the signal was raised (restore raises it before its first write); a deletion
// already past its check when the signal rises removes only a file listed before then.

import { quietly } from '../model/quietly';
import type { Take } from '../model/types';
import type { CompressedFile } from '../storage/audio-store';
import type { TakePatch } from '../storage/db';
import { createClipCounter, isTooShort, requestPersist, saveTake } from './take-save';

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
  /** Decodes a compressed copy to mono PCM (audio/decode.ts `decodeTakeAudio`). */
  decode: (blob: Blob, sampleRate: number) => Promise<{ pcm: Float32Array }>;
  /**
   * A restore is running (storage/restore-state.ts): its audio is written before its records,
   * so the scan deletes no file meanwhile.
   */
  isRestoreRunning: () => boolean;
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
  /** Asks the browser to keep storage after a take is saved; fire and forget. Optional. */
  requestPersist?: () => void;
}

export interface RecordingRecovery {
  /** The start-up scan. A call while one runs returns that one; never rejects. */
  scan(): Promise<void>;
  /** Rebuilds the offered take `id` and opens its Tab. Never rejects. */
  open(id: string): Promise<void>;
  /**
   * Deletes the offered take `id` (record and files), once a re-read shows it still unfinished;
   * otherwise only its banner goes. `deleted` runs once the delete has committed (or was found
   * not needed), just before the banner's entry goes (the UI moves focus there). Never rejects.
   */
  discard(id: string, deleted?: () => void): Promise<void>;
  /**
   * The scan for take `id` alone (this tab's save of it failed): offered again when it is still
   * unfinished and long enough, deleted when too short. A no-op after a handover, or while it is
   * offered already. Never rejects.
   */
  reoffer(id: string): Promise<void>;
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

  /** An analysed take whose audio was deleted (re-read just before the delete, not this tab's). */
  async function audioDeleted(id: string): Promise<boolean> {
    if (id === host.activeTakeId()) return false;
    const take = await deps.getTake(id);
    return take?.status === 'analyzed' && take.audioMime === null;
  }

  /**
   * An unfinished take, not this tab's (`own`): offered with its raw length, or deleted (after a
   * re-read) when too short; null when it is not offered.
   */
  async function consider(take: Take, own: ReadonlySet<string>): Promise<RecoveredTake | null> {
    if (take.status !== 'recording' || own.has(take.id) || take.id === host.activeTakeId()) {
      return null;
    }
    let samples: number;
    try {
      samples = await deps.rawSampleCount(take.id);
    } catch {
      // Unreadable now: left for the next start.
      return null;
    }
    const ms = take.sampleRate > 0 ? (samples / take.sampleRate) * 1000 : 0;
    // A compressed copy already saved holds the whole take (its raw appends may have failed):
    // it is offered, never deleted for a short raw file.
    if (isTooShort(ms) && !(await deps.readCompressed(take.id).catch(() => null))) {
      await quietly(async () => {
        // Re-read: only a take still unfinished is deleted.
        const now = await deps.getTake(take.id);
        if (now?.status === 'recording') await host.deleteTake(take.id, 'recording-session');
      });
      return null;
    }
    return { id: take.id, createdAt: take.createdAt, durationMs: Math.round(ms), opening: false };
  }

  /**
   * The takes of `found` still unfinished when re-read just now, and not this tab's: a take saved
   * since the list was read is never offered.
   */
  async function stillUnfinished(
    found: readonly RecoveredTake[],
    own: ReadonlySet<string>,
  ): Promise<RecoveredTake[]> {
    const kept: RecoveredTake[] = [];
    for (const t of found) {
      const now = await deps.getTake(t.id).catch(() => null);
      if (now?.status === 'recording') kept.push(t);
    }
    const active = host.activeTakeId();
    return kept.filter((t) => t.id !== active && !own.has(t.id));
  }

  /** This tab's take id, when there is one, added to `own`. */
  function noteOwn(own: Set<string>) {
    const id = host.activeTakeId();
    if (id !== null) own.add(id);
  }

  async function runScan(): Promise<void> {
    if (host.handedOver()) return;
    // This tab's take as seen before and after the list is read: one saved in between shows as
    // `recording` in the list, but is never offered.
    const own = new Set<string>();
    noteOwn(own);
    const takes = await deps.listTakes();
    noteOwn(own);
    const known = new Set(takes.map((t) => t.id));

    // Analysed takes whose audio was deleted: any file left of theirs goes too.
    const noAudio = new Set(
      takes.filter((t) => t.status === 'analyzed' && t.audioMime === null).map((t) => t.id),
    );
    // While a restore runs (checked after listing and again just before each deletion), its
    // audio may be written before its records: no file is deleted; the next scan removes real
    // orphans.
    const raws = await deps.listRaw().catch(() => [] as string[]);
    for (const id of raws) {
      if ((known.has(id) && !noAudio.has(id)) || deps.isRestoreRunning()) continue;
      await quietly(async () => {
        const gone = known.has(id) ? await audioDeleted(id) : await orphan(id);
        if (gone && !deps.isRestoreRunning()) await deps.deleteRaw(id);
      });
    }
    const compressed = await deps.listCompressed().catch(() => [] as CompressedFile[]);
    for (const id of new Set(compressed.map((f) => f.id))) {
      if ((known.has(id) && !noAudio.has(id)) || deps.isRestoreRunning()) continue;
      await quietly(async () => {
        const gone = known.has(id) ? await audioDeleted(id) : await orphan(id);
        if (gone && !deps.isRestoreRunning()) await deps.deleteAudio(id);
      });
    }

    const candidates: RecoveredTake[] = [];
    for (const take of takes) {
      const offer = await consider(take, own);
      if (offer) candidates.push(offer);
    }
    const found = await stillUnfinished(candidates, own);
    if (host.handedOver()) return;
    // An Open or Discard already under way keeps its entry as it is.
    const kept = offered.filter((t) => busy.has(t.id));
    publish([
      ...found.map((t) => kept.find((k) => k.id === t.id) ?? t),
      ...kept.filter((k) => !found.some((t) => t.id === k.id)),
    ]);
  }

  async function reoffer(id: string): Promise<void> {
    // A scan in flight may hold `id` as this tab's own and would publish over this offer: wait.
    if (scanning) await scanning;
    if (host.handedOver() || busy.has(id) || offered.some((t) => t.id === id)) return;
    try {
      const take = await deps.getTake(id);
      if (!take) return;
      const own = new Set<string>();
      const offer = await consider(take, own);
      if (!offer) return;
      const [found] = await stillUnfinished([offer], own);
      if (!found || host.handedOver() || offered.some((t) => t.id === id)) return;
      // Oldest first, as the scan offers them.
      publish([...offered, found].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
    } catch {
      // Unreadable now: the next start's scan offers it.
    }
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

  /**
   * Rebuilds take `id` and saves it `recorded`. Stops, writing nothing more and not navigating,
   * as soon as the store is handed over (story 5.3): checked after every await and just before
   * the save, so the take stays `recording` for the new holder's scan.
   */
  async function rebuild(id: string): Promise<void> {
    const take = await deps.getTake(id);
    if (host.handedOver()) return;
    if (!take || take.status !== 'recording') {
      drop(id);
      return;
    }
    const samples = await deps.readRaw(id);
    if (host.handedOver()) return;
    let audioMime: string;
    let blob: Blob | null = null;
    /** The compressed copy the take keeps, when one was already saved (not recovery's encode). */
    let kept: Blob | null = null;
    const existing = await deps.readCompressed(id);
    if (host.handedOver()) return;
    if (existing) {
      // Never overwritten, and no second format (writeCompressed deletes the others).
      audioMime = existing.type;
      kept = existing;
    } else {
      let encoded: Blob;
      try {
        encoded = await deps.encodePcm(samples, take.sampleRate);
      } catch {
        encoded = deps.encodeWav(samples, take.sampleRate);
      }
      if (host.handedOver()) return;
      // The encode runs in real time: check again that nothing was saved meanwhile.
      const meanwhile = await deps.readCompressed(id);
      if (host.handedOver()) return;
      if (meanwhile) {
        audioMime = meanwhile.type;
        kept = meanwhile;
      } else {
        blob = encoded;
        audioMime = encoded.type;
      }
    }
    // The take's audio is the compressed copy it keeps, which can be longer than the raw file after
    // raw append failures or an early storage-full (DS2): measure that copy when it decodes, else
    // the raw samples.
    let measured = samples;
    if (kept) {
      try {
        const decoded = await deps.decode(kept, take.sampleRate);
        if (decoded.pcm.length > 0) measured = decoded.pcm;
      } catch {
        // An undecodable copy keeps the raw-based values.
      }
      if (host.handedOver()) return;
    }
    const durationMs = Math.round((measured.length / take.sampleRate) * 1000);
    // Re-read just before the save: a take saved meanwhile (by this tab, or by a tab that held
    // the lock until now) is never patched over.
    const now = await deps.getTake(id);
    if (host.handedOver()) return;
    if (now?.status !== 'recording') {
      drop(id);
      return;
    }
    // Clipping counts the raw samples, plus only the part of the decoded copy past them: a lossy
    // decode can overshoot the original peaks slightly, so it is not re-counted where raw exists.
    const clips = createClipCounter();
    clips.addSamples(samples);
    if (measured.length > samples.length) clips.addSamples(measured.subarray(samples.length));
    await saveTake(host, id, {
      blob,
      audioMime,
      durationMs,
      stopReason: 'recovered',
      clipped: clips.clipped,
      // A steal during the write (the fence may come up to 3 s later): the take is not patched.
      afterWrite: async () => {
        if (host.handedOver()) throw new Error('Handed over during the recovery save');
      },
    });
    // A handover during the save: the fence rejected what came after it, and nothing navigates.
    if (host.handedOver()) return;
    requestPersist(host);
    drop(id);
    if (!host.isRecording()) host.navigate(id);
    return;
  }

  async function open(id: string): Promise<void> {
    if (busy.has(id) || !offered.some((t) => t.id === id)) return;
    busy.add(id);
    setOpening(id, true);
    try {
      // Stopped for a handover: the entry stays as it is (the store is handed over).
      await rebuild(id);
    } catch {
      // Handed over: nothing more is read or published.
      if (host.handedOver()) return;
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
      // Re-read: a take saved since it was offered (it is no longer unfinished) is never deleted.
      const now = await deps.getTake(id);
      if (now?.status === 'recording') await host.deleteTake(id, 'recording-session');
      try {
        deleted?.();
      } catch {
        // The banner goes all the same.
      }
      drop(id);
    } catch {
      // The banner stays; Discard can be tried again.
    } finally {
      busy.delete(id);
    }
  }

  return { scan, open, discard, reoffer };
}
