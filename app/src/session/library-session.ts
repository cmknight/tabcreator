// Library store (spine AD-3, AD-5; story "Library list (tracer)", US-7.1): the take list the
// Library screen shows. Read it with useSyncExternalStore. Built from one read of every take,
// every tab and every compressed file size, then kept live by storage events while it has
// listeners. It reads only storage (AD-3). Story 6.2 adds its writes, as the `library-session`
// writer (AD-14): rename, delete a take, delete a take's audio. Stories 6.3 (search), 6.5/6.6
// (backup, restore) and 6.7 (storage states) build on this snapshot.

import { libraryRow, pickSize, sortRows, type LibraryRow } from '../model/library';
import { isAppError, type AppErrorCode } from '../model/errors';
import { devWarn } from '../model/log';
import { renamedTitle } from '../model/title';
import type { Tab, Take, TakeWriter } from '../model/types';
import { audioStore, type CompressedFile } from '../storage/audio-store';
import { db } from '../storage/db';
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
   * the stored title unless a later rename is being written.
   */
  rename(id: string, title: string): Promise<void>;
  /**
   * Deletes the take, its tab and every audio file (`db.deleteTake`; files best-effort, AD-15).
   * The row goes with the `take-deleted` event. A failure rejects (logged) and the row stays.
   */
  deleteTake(id: string): Promise<void>;
  /**
   * Deletes the take's audio, keeping its tab: `audioMime` set to null first, then every
   * compressed file and the raw file removed, best-effort (AD-15). The row shows "Audio deleted"
   * through the `take-put` event. Does nothing unless the take is analysed and still has
   * `audioMime`. A failed read or patch rejects (logged) and no file is removed.
   */
  deleteAudio(id: string): Promise<void>;
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
}

const WRITER = 'library-session';

const errorCode = (err: unknown): AppErrorCode => (isAppError(err) ? err.code : 'storage-failed');

export function createLibrarySession(deps: LibraryDeps): LibrarySession {
  let snapshot: LibrarySnapshot = { loading: true, rows: [], error: null };
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
    return title === undefined || title === row.title ? row : { ...row, title };
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
    publish({ loading: false, rows: sortRows(rows), error: null });
    refreshChanged();
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

  function attach() {
    unsubscribeStorage = deps.subscribeStorage(onStorage);
    void loadAll();
  }

  function detach() {
    unsubscribeStorage?.();
    unsubscribeStorage = null;
    generation++;
    changedDuringLoad.clear();
    refreshSeq.clear();
  }

  /** Shows `title` on the take's row, if it is listed. */
  function showTitle(id: string, title: string) {
    const row = snapshot.rows.find((r) => r.id === id);
    if (!row || row.title === title) return;
    publish({ ...snapshot, rows: snapshot.rows.map((r) => (r.id === id ? { ...r, title } : r)) });
  }

  async function rename(id: string, raw: string) {
    const shown = snapshot.rows.find((r) => r.id === id);
    if (!shown) return;
    const title = renamedTitle(raw, shown.title);
    if (title === null) return;
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
    try {
      await deps.deleteTake(id, WRITER);
    } catch (err) {
      devWarn(`Library: deleting take ${id} failed`, err);
      throw err;
    }
  }

  async function deleteAudio(id: string) {
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
    await deps.deleteAudio(id).catch((err: unknown) => {
      devWarn(`Library: removing the compressed audio of take ${id} failed`, err);
    });
    await deps.deleteRaw(id).catch((err: unknown) => {
      devWarn(`Library: removing the raw audio of take ${id} failed`, err);
    });
  }

  return {
    rename,
    deleteTake,
    deleteAudio,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1 && !unsubscribeStorage) attach();
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) detach();
      };
    },
    getSnapshot: () => snapshot,
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
});
