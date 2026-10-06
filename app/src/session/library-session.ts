// Library store (spine AD-3, AD-5; story "Library list (tracer)", US-7.1): the take list the
// Library screen shows. Read it with useSyncExternalStore. Built from one read of every take,
// every tab and every compressed file size, then kept live by storage events while it has
// listeners. It reads only storage (AD-3) and writes nothing yet; stories 6.2 (row actions),
// 6.3 (search), 6.5/6.6 (backup, restore) and 6.7 (storage states) build on this snapshot.

import { libraryRow, pickSize, sortRows, type LibraryRow } from '../model/library';
import { isAppError, type AppErrorCode } from '../model/errors';
import { devWarn } from '../model/log';
import type { Tab, Take } from '../model/types';
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
}

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
      libraryRow(
        take,
        tabById.get(take.id) ?? null,
        pickSize(filesById.get(take.id) ?? [], take.audioMime),
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
        row = libraryRow(take, tab, size);
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

  return {
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
});
