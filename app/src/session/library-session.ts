// Library store (spine AD-3, AD-5; story "Library list (tracer)", US-7.1): the take list the
// Library screen shows. Read it with useSyncExternalStore. Built from one read of every take,
// every tab and every compressed file size, then kept live by storage events while it has
// listeners. It reads only storage (AD-3). Story 6.2 adds its writes, as the `library-session`
// writer (AD-14): rename, delete a take, delete a take's audio. Story 6.5 adds the backup (one
// at a time, its progress in the snapshot). Story 6.6 adds restore (read and check a backup file,
// then import the takes not already present: audio first, then the records, the audio removed
// again if the import fails); a backup and a restore never run at the same time. Story 6.3
// (search) builds on this snapshot. Story 6.7 (storage states) adds `storage` (persisted, usage,
// storage-full, read from storage/persistence.ts) and the one-time `persistNotice`. Story
// "Storage-full status that clears when space is freed" (epic 7): `deleteAudio` reports the
// freed space to persistence.ts (`beginFreeing`), and both deletes read the usage again once
// their files are removed. Story "Restore validation and missing audio" (epic 7): a restore that
// imported takes asks for persistent storage (`requestPersist`, fire and forget). Story
// "Streaming restore and restore races" (epic 7): a restore holds storage's restore signal
// (`beginRestore`, storage/restore-state.ts) so the recovery scan deletes no file meanwhile; it
// writes a take's audio only while the take has no record (re-read just before the write),
// streamed from the picked file; the file written for a take the import skipped goes again (that
// file only); and a rollback that could not remove
// every file it wrote rejects with `RestoreLeftFilesError`, so the screen never says "nothing was
// changed" when files were left behind. Story "Library robustness during backup and restore"
// (7.17): rename and both deletes refuse (`LibraryBusyError`, code `library-busy`, with its reason)
// while a backup or restore runs, before any optimistic change, and a backup or restore waits for
// the writes already in flight to settle before it starts; a backup that finishes while no
// Library screen is subscribed is kept as `pendingDownload` (memory only) for the next visit.
// "Off-screen" means no subscriber at all: the Library screen is this session's only subscriber,
// so a new subscriber elsewhere would have to change how that is decided.

import { extensionFor } from '../model/audio-format';
import { libraryRow, pickSize, sortRows, withTitle, type LibraryRow } from '../model/library';
import { AppError, isAppError, type AppErrorCode } from '../model/errors';
import { devWarn } from '../model/log';
import { renamedTitle } from '../model/title';
import type { Tab, Take, TakeWriter } from '../model/types';
import { audioStore, removeTakeFiles, type CompressedFile } from '../storage/audio-store';
import { createBackup, type BackupResult } from '../storage/backup';
import { db, type ImportRecord } from '../storage/db';
import {
  isStorageFull,
  persistence,
  beginFreeing,
  subscribeStorageFull,
} from '../storage/persistence';
import { loadPrefs, updatePrefs } from '../storage/prefs';
import { readBackup, type ValidBackup } from '../storage/restore';
import { beginRestore, isRestoreRunning } from '../storage/restore-state';
import { devHoldBackup } from '../dev/hooks/backup';
import { registerFlush } from './flush';
import { requestPersist } from './take-save';
import {
  subscribe as subscribeStorage,
  type StorageEvent,
  type StorageListener,
} from '../storage/events';

export type { LibraryRow, LibraryStatus } from '../model/library';

export interface LibrarySnapshot {
  /** A full read is running (the first one, a restore's, or one after the screen came back). */
  loading: boolean;
  /** Every take, newest first; kept while a later full read runs. */
  rows: LibraryRow[];
  /** The last full read failed (its AppError code); cleared by the next successful one. */
  error: AppErrorCode | null;
  /** A backup is running, with its progress (0..1); null when none is. */
  backup: { progress: number } | null;
  /** A restore is reading a backup file or importing it. */
  restoring: boolean;
  /** Storage status (story 6.7). */
  storage: LibraryStorage;
  /**
   * A backup that finished while no Library screen was subscribed, for the screen to offer
   * ("Your backup is ready"); null when there is none. A newer backup replaces or clears it.
   */
  pendingDownload: PendingDownload | null;
  /**
   * The one-time storage notice shows this visit: storage is not persisted, the library has a
   * take not still recording, and `prefs.persistNoticeShown` was false. Once true it stays so until the screen leaves.
   */
  persistNotice: boolean;
}

/** A backup kept for the screen to offer: its result and when it finished (ISO 8601). */
export interface PendingDownload {
  result: BackupResult;
  finishedAt: string;
}

export interface LibraryStorage {
  /** Whether storage is persisted; null until read. */
  protected: boolean | null;
  /** The bytes this origin uses (`estimate().usage`); null when unknown. */
  usageBytes: number | null;
  /**
   * Storage is full (storage/persistence.ts's one status): set by a `storage-full` write or the
   * start-up re-check, cleared only once space is freed (a take or its audio deleted, or a
   * re-check finding room).
   */
  full: boolean;
}

export type { BackupResult } from '../storage/backup';

/** A backup file read and checked, with what restoring it would do now. */
export interface RestorePlan {
  backup: ValidBackup;
  /** Takes in the file not yet in the library. */
  toImport: number;
  /** Takes in the file already in the library (skipped). */
  toSkip: number;
}

/**
 * A restore failed and its rollback could not remove every audio file it wrote (for example after
 * the write fence, `instance-taken`): files were left behind, for the next start-up scan. Its
 * `code` is the failure's (the restore's, else `storage-failed`), the failure its `cause`.
 */
export class RestoreLeftFilesError extends AppError {
  constructor(failure: unknown) {
    super(
      isAppError(failure) ? failure.code : 'storage-failed',
      'Restore failed and its rollback left files behind',
      { cause: failure },
    );
    this.name = 'RestoreLeftFilesError';
  }
}

/** What a library write is waiting for. */
export type LibraryBusyReason = 'backup' | 'restore';

/**
 * A library write (rename, delete take, delete audio) refused because a backup or restore is
 * running (`library-busy`); nothing was changed. `reason` says which.
 */
export class LibraryBusyError extends AppError {
  constructor(readonly reason: LibraryBusyReason) {
    super('library-busy', `Library write refused: a ${reason} is running`);
    this.name = 'LibraryBusyError';
  }
}

/** A compressed file a restore wrote: `audio/{id}.{ext}`. */
interface RestoredFile {
  id: string;
  ext: string;
}

export interface RestoreResult {
  imported: number;
  /** Takes in the file that were already in the library. */
  skipped: number;
}

export interface LibrarySession {
  /**
   * Subscribes. The first listener starts listening to storage events and reads the whole
   * library; when the last one leaves, events are no longer followed, so the next first
   * listener reads it again.
   */
  subscribe(listener: () => void): () => void;
  getSnapshot(): LibrarySnapshot;
  /**
   * Renames a take: trimmed, at most `TITLE_MAX` code points; empty or unchanged writes nothing.
   * The row shows the new title at once; a failed write rejects (logged), and the row re-reads
   * the stored title unless a later rename is being written. While a backup or restore runs it
   * rejects with `LibraryBusyError` before showing anything.
   */
  rename(id: string, title: string): Promise<void>;
  /**
   * Deletes the take, its tab and every audio file (`db.deleteTake`; files best-effort, AD-15).
   * The row goes with the `take-deleted` event. A failure rejects (logged) and the row stays.
   * While a backup or restore runs it rejects with `LibraryBusyError`.
   */
  deleteTake(id: string): Promise<void>;
  /**
   * Deletes the take's audio, keeping its tab: `audioMime` set to null first, then every
   * compressed file and the raw file removed, best-effort (AD-15). The row shows "Audio deleted"
   * through the `take-put` event. Does nothing unless the take is analysed and still has
   * `audioMime`. A failed read or patch rejects (logged) and no file is removed. While a backup
   * or restore runs it rejects with `LibraryBusyError`.
   */
  deleteAudio(id: string): Promise<void>;
  /**
   * Backs up the library (storage/backup.ts): the zip Blob and its file name, for the screen to
   * download. One at a time: while one runs, another call does nothing and resolves to null.
   * `backup` in the snapshot shows its progress, and is null again once it ends. A failure
   * rejects (logged). One that finishes while no screen is subscribed resolves to null too: its
   * result is kept as `pendingDownload` instead (replacing any earlier one); one that finishes
   * with a screen subscribed clears `pendingDownload`.
   */
  backUp(): Promise<BackupResult | null>;
  /** The screen downloaded or dismissed `pending`: `pendingDownload` clears if it is still that. */
  clearPendingDownload(pending: PendingDownload): void;
  /**
   * Reads and checks a backup file (storage/restore.ts; nothing is written) and counts its takes
   * against the library. `restoring` is set meanwhile. Resolves to null when a backup or restore
   * is running. An invalid file rejects with `backup-invalid` (logged).
   */
  readBackup(file: Blob): Promise<RestorePlan | null>;
  /**
   * Imports a checked backup's takes not already present: their audio is written first (only
   * while the take has no record, re-read just before; an orphan file of the id is replaced),
   * then their records
   * (`importTakes`, which skips ids present by then); the file written for a take it skipped is
   * removed again (that file only). A failed write removes the audio written so far and writes no record. Existing
   * takes are never touched, their audio never overwritten or removed. `restoring` is set, and
   * storage's restore signal held, meanwhile. Resolves to null when a backup or restore is
   * running. A failure rejects (logged) with the write's AppError, or with a
   * `RestoreLeftFilesError` when the rollback could not remove every file it wrote.
   */
  restore(backup: ValidBackup): Promise<RestoreResult | null>;
  /**
   * The screen showed the storage notice: `prefs.persistNoticeShown` is set, so no later visit
   * shows it. A failed write is logged; the notice may then show again on a later visit.
   */
  markPersistNoticeShown(): void;
  /**
   * Whether a backup or restore is running (this session's, or any restore holding storage's
   * signal): an app reload would cut it short (story "Update available prompt").
   */
  isBusy(): boolean;
  /**
   * Resolves once the rename and delete writes in flight have settled (never rejects): the
   * app-wide flush (`session/flush.ts`) before a reload.
   */
  flush(): Promise<void>;
}

export interface LibraryDeps {
  listTakes(): Promise<Take[]>;
  listTabs(): Promise<Tab[]>;
  listCompressed(): Promise<CompressedFile[]>;
  getTake(id: string): Promise<Take | null>;
  getTab(takeId: string): Promise<Tab | null>;
  /** The take's compressed file size in bytes (the file matching `mime` first); null with none. */
  compressedSize(takeId: string, mime: string | null): Promise<number | null>;
  subscribeStorage(listener: StorageListener): () => void;
  patchTake(
    id: string,
    patch: Partial<Pick<Take, 'title' | 'audioMime'>>,
    writer: TakeWriter,
  ): Promise<unknown>;
  deleteTake(id: string, writer: TakeWriter): Promise<void>;
  /** Removes every compressed file of the take. */
  deleteAudio(takeId: string): Promise<void>;
  /** Removes the take's raw file. */
  deleteRaw(takeId: string): Promise<void>;
  /** Builds the backup zip, reporting progress (0..1). */
  createBackup(onProgress: (progress: number) => void): Promise<BackupResult>;
  /** Reads and checks a backup file (the backup worker's `read`). */
  readBackup(file: Blob): Promise<ValidBackup>;
  /**
   * Restore's audio write (audio-store `restoreCompressed`): its extension from `blob.type`,
   * replacing any file of the take; inflated to exactly `inflatedSize` bytes when not null.
   */
  restoreCompressed(takeId: string, blob: Blob, inflatedSize: number | null): Promise<void>;
  /** Removes the one file `audio/{takeId}.{ext}` (restore's cleanup). */
  removeCompressedFile(takeId: string, ext: string): Promise<void>;
  /** Writes whole records, skipping ids present; resolves to the ids written. */
  importTakes(records: readonly ImportRecord[]): Promise<string[]>;
  /** Raises storage's restore signal (storage/restore-state.ts); the returned call lowers it. */
  beginRestore(): () => void;
  /** Whether storage's restore signal is raised (by any restore). */
  isRestoreRunning(): boolean;
  /**
   * Asks the browser to keep storage (storage/persistence.ts `requestPersistOnce`), after a
   * restore imported takes. Fire and forget.
   */
  requestPersist(): void;
  /** Whether storage is persisted; false when unknown. Never rejects. */
  persisted(): Promise<boolean>;
  /** The bytes used; null when unknown. Never rejects. */
  estimateUsage(): Promise<number | null>;
  /** The storage-full status, and its change listener (returns the unsubscribe function). */
  isStorageFull(): boolean;
  subscribeStorageFull(listener: () => void): () => void;
  /**
   * Called as a delete of a take's audio begins; the returned call, made once the removals are
   * done (`removed`: every removal succeeded), clears the storage-full status when they did and
   * starts a room re-check (its promise; not awaited). Never rejects.
   */
  beginFreeing(): (removed: boolean) => Promise<void>;
  /** Whether the storage notice was shown on an earlier visit. */
  persistNoticeShown(): boolean;
  /** Remembers that the storage notice was shown. */
  markPersistNoticeShown(): void;
}

const WRITER = 'library-session';

const errorCode = (err: unknown): AppErrorCode => (isAppError(err) ? err.code : 'storage-failed');

export function createLibrarySession(deps: LibraryDeps): LibrarySession {
  let snapshot: LibrarySnapshot = {
    loading: true,
    rows: [],
    error: null,
    backup: null,
    restoring: false,
    pendingDownload: null,
    storage: { protected: null, usageBytes: null, full: false },
    persistNotice: false,
  };
  const listeners = new Set<() => void>();
  let unsubscribeStorage: (() => void) | null = null;
  /** Bumped by every full read and every detach; a read whose generation is stale is dropped. */
  let generation = 0;
  /** Takes changed while a full read runs; refreshed once it lands. */
  const changedDuringLoad = new Set<string>();
  /** Per take, the latest refresh's number: an older refresh landing later is dropped. */
  const refreshSeq = new Map<string, number>();
  let nextSeq = 1;
  /** Titles being written by `rename`, by take id: shown over what a read returns meanwhile. */
  const pendingTitles = new Map<string, string>();

  /** `row` with its pending rename's title, if one is being written. */
  function withPending(row: LibraryRow): LibraryRow {
    const title = pendingTitles.get(row.id);
    return title === undefined ? row : withTitle(row, title);
  }

  function publish(next: LibrarySnapshot) {
    snapshot = next;
    for (const l of [...listeners]) l();
  }

  async function loadAll() {
    const gen = ++generation;
    changedDuringLoad.clear();
    refreshSeq.clear();
    if (!snapshot.loading) publish({ ...snapshot, loading: true });
    let takes: Take[];
    let tabs: Tab[];
    let files: CompressedFile[];
    try {
      [takes, tabs, files] = await Promise.all([
        deps.listTakes(),
        deps.listTabs(),
        deps.listCompressed().catch((err: unknown) => {
          // Sizes are extra: the list still shows without them.
          devWarn('Library: listing audio sizes failed', err);
          return [] as CompressedFile[];
        }),
      ]);
    } catch (err) {
      if (gen !== generation) return;
      devWarn('Library: reading the takes failed', err);
      publish({ ...snapshot, loading: false, error: errorCode(err) });
      refreshChanged();
      return;
    }
    if (gen !== generation) return;
    const tabById = new Map(tabs.map((t) => [t.takeId, t]));
    const filesById = new Map<string, CompressedFile[]>();
    for (const f of files) filesById.set(f.id, [...(filesById.get(f.id) ?? []), f]);
    const rows = takes.map((take) =>
      withPending(
        libraryRow(
          take,
          tabById.get(take.id) ?? null,
          pickSize(filesById.get(take.id) ?? [], take.audioMime),
        ),
      ),
    );
    publish({ ...snapshot, loading: false, rows: sortRows(rows), error: null });
    checkNotice();
    refreshChanged();
  }

  function setStorage(patch: Partial<LibraryStorage>) {
    const next = { ...snapshot.storage, ...patch };
    const cur = snapshot.storage;
    if (
      next.protected === cur.protected &&
      next.usageBytes === cur.usageBytes &&
      next.full === cur.full
    ) {
      return;
    }
    publish({ ...snapshot, storage: next });
  }

  /**
   * Shows the storage notice this visit when storage is not persisted, the library has a take
   * not still recording (one Back up library can save) and no earlier visit showed it. Checked once the protection read and a full read landed.
   */
  function checkNotice() {
    if (snapshot.persistNotice || !unsubscribeStorage) return;
    // A take to back up (not one still recording), as Back up library needs.
    const backable = snapshot.rows.some((r) => r.status !== 'recording');
    if (snapshot.storage.protected !== false || snapshot.loading || !backable) return;
    let shown: boolean;
    try {
      shown = deps.persistNoticeShown();
    } catch {
      shown = false;
    }
    if (!shown) publish({ ...snapshot, persistNotice: true });
  }

  /** Bumped by every attach and detach: a storage read from an earlier visit is dropped. */
  let visit = 0;

  /** The latest usage read's number: an older read landing later is dropped. */
  let usageSeq = 0;
  async function readUsage() {
    const gen = visit;
    const seq = ++usageSeq;
    let usageBytes: number | null;
    try {
      usageBytes = await deps.estimateUsage();
    } catch {
      usageBytes = null;
    }
    if (gen !== visit || seq !== usageSeq) return;
    setStorage({ usageBytes });
  }

  async function readProtected() {
    const gen = visit;
    let isProtected: boolean;
    try {
      isProtected = await deps.persisted();
    } catch {
      isProtected = false;
    }
    if (gen !== visit) return;
    setStorage({ protected: isProtected });
    checkNotice();
  }

  /** Refreshes the takes whose events arrived while the full read ran (it landed or failed). */
  function refreshChanged() {
    const changed = [...changedDuringLoad];
    changedDuringLoad.clear();
    for (const id of changed) void refresh(id);
  }

  function removeRow(id: string) {
    if (!snapshot.rows.some((r) => r.id === id)) return;
    publish({ ...snapshot, rows: snapshot.rows.filter((r) => r.id !== id) });
  }

  /**
   * A successful refresh's result: its row put, replaced or removed. After a failed full read
   * the error is cleared and, since storage reads again, the whole library is read again (one
   * row alone would look like the whole library).
   */
  function applyRefresh(id: string, row: LibraryRow | null) {
    const rows = snapshot.rows.filter((r) => r.id !== id);
    if (row) rows.push(row);
    else if (rows.length === snapshot.rows.length && snapshot.error === null) return;
    const recovering = snapshot.error !== null;
    publish({ ...snapshot, rows: row ? sortRows(rows) : rows, error: null });
    checkNotice();
    if (recovering) void loadAll();
  }

  /** Re-reads one take, its tab and its size by id, then replaces, inserts or removes its row. */
  async function refresh(id: string) {
    const gen = generation;
    const seq = nextSeq++;
    refreshSeq.set(id, seq);
    const current = () => gen === generation && refreshSeq.get(id) === seq;
    let row: LibraryRow | null;
    try {
      const take = await deps.getTake(id);
      if (!take) {
        row = null;
      } else {
        const [tab, size] = await Promise.all([
          deps.getTab(id),
          take.status === 'recording' || take.audioMime === null
            ? Promise.resolve(null)
            : deps.compressedSize(id, take.audioMime).catch((err: unknown) => {
                devWarn('Library: reading an audio size failed', err);
                return null;
              }),
        ]);
        row = withPending(libraryRow(take, tab, size));
      }
    } catch (err) {
      // The row keeps what it showed; the next event or full read corrects it.
      if (current()) devWarn(`Library: refreshing take ${id} failed`, err);
      return;
    }
    if (!current()) return;
    applyRefresh(id, row);
  }

  const onStorage = (event: StorageEvent) => {
    void readUsage();
    if (event.type === 'library-restored') {
      void loadAll();
      return;
    }
    if (snapshot.loading) {
      // A full read is running and may have read before this write: refresh it after.
      changedDuringLoad.add(event.takeId);
      if (event.type === 'take-deleted') refreshSeq.set(event.takeId, nextSeq++);
      return;
    }
    if (event.type === 'take-deleted') {
      // Any refresh still running for it is stale now.
      refreshSeq.set(event.takeId, nextSeq++);
      removeRow(event.takeId);
      return;
    }
    void refresh(event.takeId);
  };

  const onStorageFull = () => setStorage({ full: deps.isStorageFull() });
  let unsubscribeFull: (() => void) | null = null;

  function attach() {
    unsubscribeStorage = deps.subscribeStorage(onStorage);
    unsubscribeFull = deps.subscribeStorageFull(onStorageFull);
    visit++;
    onStorageFull();
    void loadAll();
    void readProtected();
    void readUsage();
  }

  function detach() {
    unsubscribeStorage?.();
    unsubscribeStorage = null;
    unsubscribeFull?.();
    unsubscribeFull = null;
    // A later visit decides again (from prefs) whether the notice shows.
    if (snapshot.persistNotice) snapshot = { ...snapshot, persistNotice: false };
    visit++;
    generation++;
    changedDuringLoad.clear();
    refreshSeq.clear();
  }

  /** Shows `title` on the take's row, if it is listed. */
  function showTitle(id: string, title: string) {
    const row = snapshot.rows.find((r) => r.id === id);
    if (!row || row.title === title) return;
    publish({
      ...snapshot,
      rows: snapshot.rows.map((r) => (r.id === id ? withTitle(r, title) : r)),
    });
  }

  /**
   * Rejects with `LibraryBusyError` while a backup or restore runs (this session's, or any
   * restore holding storage's signal): no library write runs meanwhile, and nothing is queued.
   */
  function refuseWhileBusy() {
    if (backupRun !== 0) throw new LibraryBusyError('backup');
    if (restoreRunning || deps.isRestoreRunning()) throw new LibraryBusyError('restore');
  }

  async function rename(id: string, raw: string) {
    const shown = snapshot.rows.find((r) => r.id === id);
    if (!shown) return;
    const title = renamedTitle(raw, shown.title);
    if (title === null) return;
    // Before the title shows: a refused rename never shows and then reverts.
    refuseWhileBusy();
    pendingTitles.set(id, title);
    showTitle(id, title);
    try {
      await deps.patchTake(id, { title }, WRITER);
      if (pendingTitles.get(id) === title) pendingTitles.delete(id);
    } catch (err) {
      devWarn(`Library: renaming take ${id} failed`, err);
      if (pendingTitles.get(id) === title) {
        // The latest rename failed: the row shows the stored title, read again.
        pendingTitles.delete(id);
        void refresh(id);
      } // else a later rename decides what shows
      throw err;
    }
  }

  async function deleteTake(id: string) {
    refuseWhileBusy();
    try {
      // Resolves once its files are removed (and the storage-full status updated, db.ts).
      await deps.deleteTake(id, WRITER);
    } catch (err) {
      devWarn(`Library: deleting take ${id} failed`, err);
      throw err;
    }
    // The `take-deleted` event's read ran before the files went: read the usage again.
    void readUsage();
  }

  async function deleteAudio(id: string) {
    refuseWhileBusy();
    // A storage-full failure after this point is not cleared by this delete.
    const freed = deps.beginFreeing();
    try {
      // Only an analysed take (which keeps its tab) with audio may lose it.
      const take = await deps.getTake(id);
      if (!take || take.status !== 'analyzed' || take.audioMime === null) return;
      await deps.patchTake(id, { audioMime: null }, WRITER);
    } catch (err) {
      devWarn(`Library: deleting the audio of take ${id} failed`, err);
      throw err;
    }
    // Files go after the record; a failure leaves files for the start-up scan (AD-15).
    const removed = await removeTakeFiles(deps, id, (file, err) =>
      devWarn(`Library: removing the ${file} audio of take ${id} failed`, err),
    );
    // Space was freed: the storage-full status clears (when both removals succeeded) and is
    // re-checked without holding the delete; the usage is read again now the files are gone.
    void freed(removed);
    void readUsage();
  }

  /** The running backup's number (0: none); a progress report from an ended run is dropped. */
  let backupRun = 0;
  let lastBackupRun = 0;

  /** The rename and delete calls in flight (each removed once it settles). */
  const writes = new Set<Promise<unknown>>();

  /** Tracks a write until it settles, so a backup or restore can wait for it. */
  function tracked<T>(write: Promise<T>): Promise<T> {
    writes.add(write);
    const done = () => writes.delete(write);
    write.then(done, done);
    return write;
  }

  /**
   * Resolves once every write in flight has settled. Called after the backup or restore has set
   * its running flag, so no new write starts meanwhile (each is refused).
   */
  async function writesSettled() {
    while (writes.size > 0) await Promise.allSettled([...writes]);
  }

  async function backUp(): Promise<BackupResult | null> {
    if (backupRun !== 0 || restoreRunning) return null;
    const run = ++lastBackupRun;
    backupRun = run;
    publish({ ...snapshot, backup: { progress: 0 } });
    // A write that started before Back up finishes before the takes are listed.
    if (writes.size > 0) await writesSettled();
    let result: BackupResult;
    try {
      result = await deps.createBackup((progress) => {
        if (backupRun !== run || snapshot.backup?.progress === progress) return;
        publish({ ...snapshot, backup: { progress } });
      });
    } catch (err) {
      devWarn('Library: backing up failed', err);
      backupRun = 0;
      publish({ ...snapshot, backup: null });
      throw err;
    }
    backupRun = 0;
    // Off-screen (no subscriber: the Library is the only one, so the player left it): kept for
    // the next visit, and the screen that started it gets null. Otherwise it downloads now, and
    // any kept one, now stale, goes.
    const offScreen = listeners.size === 0;
    publish({
      ...snapshot,
      backup: null,
      pendingDownload: offScreen ? { result, finishedAt: new Date().toISOString() } : null,
    });
    return offScreen ? null : result;
  }

  function clearPendingDownload(pending: PendingDownload) {
    if (snapshot.pendingDownload !== pending) return;
    publish({ ...snapshot, pendingDownload: null });
  }

  /** A restore (its read or its import) is running. */
  let restoreRunning = false;

  /** Runs `job` as the one restore step, with `restoring` set; null when another job runs. */
  async function asRestore<T>(job: () => Promise<T>, failure: string): Promise<T | null> {
    if (backupRun !== 0 || restoreRunning) return null;
    restoreRunning = true;
    publish({ ...snapshot, restoring: true });
    try {
      // A write that started before the restore finishes before the takes are listed.
      if (writes.size > 0) await writesSettled();
      return await job();
    } catch (err) {
      devWarn(failure, err);
      throw err;
    } finally {
      restoreRunning = false;
      publish({ ...snapshot, restoring: false });
    }
  }

  function readBackupFile(file: Blob): Promise<RestorePlan | null> {
    return asRestore(async () => {
      const backup = await deps.readBackup(file);
      const existing = new Set((await deps.listTakes()).map((t) => t.id));
      const toSkip = backup.takes.filter((t) => existing.has(t.id)).length;
      return { backup, toImport: backup.takes.length - toSkip, toSkip };
    }, 'Library: reading a backup failed');
  }

  /**
   * Removes each file a restore wrote (that file only: another writer's file of the take in
   * another format stays); true when every removal succeeded. Never rejects.
   */
  async function removeRestoredAudio(files: readonly RestoredFile[]): Promise<boolean> {
    let removed = true;
    for (const { id, ext } of files) {
      await deps.removeCompressedFile(id, ext).catch((cleanup: unknown) => {
        removed = false;
        devWarn(`Library: removing restored audio of take ${id} failed`, cleanup);
      });
    }
    return removed;
  }

  function restore(backup: ValidBackup): Promise<RestoreResult | null> {
    return asRestore(async () => {
      // Held from before the first audio write until the import and its cleanup are done: the
      // recovery scan must not take the new audio for orphans before its records exist.
      const endRestore = deps.beginRestore();
      try {
        const existing = new Set((await deps.listTakes()).map((t) => t.id));
        const fresh = backup.takes.filter((t) => !existing.has(t.id));
        const tabs = new Map(backup.tabs.map((t) => [t.takeId, t]));
        /** The files this restore wrote (or began to write). */
        const written: RestoredFile[] = [];
        let inserted: string[];
        try {
          // Audio first: a record never points at audio that is not there yet.
          for (const take of fresh) {
            const audio = backup.audio.get(take.id);
            if (!audio) continue;
            // Re-read just before the write: a take created since the library was read keeps its
            // audio. With no record, any file of the id is an orphan, and is replaced.
            if ((await deps.getTake(take.id)) !== null) continue;
            // Listed before the write: one that committed and then failed (fenced after its
            // close) is still removed by the rollback.
            written.push({ id: take.id, ext: extensionFor(audio.type) });
            await deps.restoreCompressed(take.id, audio, backup.deflated.get(take.id) ?? null);
          }
          inserted = await deps.importTakes(
            fresh.map((take) => ({ take, tab: tabs.get(take.id) ?? null })),
          );
        } catch (err) {
          // Nothing was imported (one transaction): the new takes' audio goes again.
          if (!(await removeRestoredAudio(written))) throw new RestoreLeftFilesError(err);
          throw err;
        }
        // A take that appeared since the library was read was skipped by the import: the audio
        // written for it goes (best effort; the import itself succeeded).
        const imported = new Set(inserted);
        await removeRestoredAudio(written.filter(({ id }) => !imported.has(id)));
        if (inserted.length > 0) requestPersist(deps);
        return { imported: inserted.length, skipped: backup.takes.length - inserted.length };
      } finally {
        endRestore();
      }
    }, 'Library: restoring failed');
  }

  return {
    rename: (id, title) => tracked(rename(id, title)),
    deleteTake: (id) => tracked(deleteTake(id)),
    deleteAudio: (id) => tracked(deleteAudio(id)),
    backUp,
    clearPendingDownload,
    readBackup: readBackupFile,
    restore,
    markPersistNoticeShown() {
      try {
        deps.markPersistNoticeShown();
      } catch (err) {
        devWarn('Library: remembering the storage notice failed', err);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1 && !unsubscribeStorage) attach();
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) detach();
      };
    },
    getSnapshot: () => snapshot,
    isBusy: () => backupRun !== 0 || restoreRunning || deps.isRestoreRunning(),
    flush: writesSettled,
  };
}

export const librarySession: LibrarySession = createLibrarySession({
  listTakes: () => db.listTakes(),
  listTabs: () => db.listTabs(),
  listCompressed: () => audioStore.listCompressed(),
  getTake: (id) => db.getTake(id),
  getTab: (id) => db.getTab(id),
  compressedSize: (id, mime) => audioStore.compressedSize(id, mime),
  subscribeStorage,
  patchTake: (id, patch, writer) => db.patchTake(id, patch, writer),
  deleteTake: (id, writer) => db.deleteTake(id, writer),
  deleteAudio: (id) => audioStore.deleteAudio(id),
  deleteRaw: (id) => audioStore.deleteRaw(id),
  createBackup: (onProgress) => {
    const work = createBackup(
      { listTakes: () => db.listTakes(), listTabs: () => db.listTabs() },
      onProgress,
    );
    return import.meta.env.DEV ? devHoldBackup(work) : work;
  },
  readBackup: (file) => readBackup(file),
  restoreCompressed: (id, blob, inflatedSize) =>
    audioStore.restoreCompressed(id, blob, inflatedSize),
  removeCompressedFile: (id, ext) => audioStore.removeCompressedFile(id, ext),
  importTakes: (records) => db.importTakes(records),
  beginRestore,
  isRestoreRunning,
  requestPersist: () => {
    void persistence.requestPersistOnce();
  },
  persisted: () => persistence.persisted(),
  estimateUsage: () => persistence.estimateUsage(),
  isStorageFull,
  subscribeStorageFull,
  beginFreeing: () => beginFreeing(),
  persistNoticeShown: () => loadPrefs().persistNoticeShown,
  markPersistNoticeShown: () => {
    updatePrefs({ persistNoticeShown: true });
  },
});

// An app reload awaits the Library's writes in flight (spine AD-16). Registered for the app's
// lifetime: the session outlives the Library screen.
registerFlush(() => librarySession.flush());
