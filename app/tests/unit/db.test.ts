import 'fake-indexeddb/auto';
import { IDBDatabase, IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { AppError } from '../../src/model/errors';
import type { Tab, Take } from '../../src/model/types';
import { createTakeDb, type ConnectionState, type TakeDb } from '../../src/storage/db';
import { subscribe, type StorageEvent } from '../../src/storage/events';
import { DB_VERSION, MIGRATIONS, type Migration } from '../../src/storage/migrations';
import { resetFenceForTests } from '../../src/storage/write-guard';

const NAME = 'tabcreator-test';
const T0 = '2026-10-01T10:00:00.000Z';

function makeTake(id = 'take-1', overrides: Partial<Take> = {}): Take {
  return {
    id,
    title: 'Take 2026-10-01 10:00',
    createdAt: T0,
    status: 'recording',
    durationMs: 0,
    sampleRate: 48000,
    tuning: 'EADGBE',
    micLabel: 'Fake mic',
    audioMime: null,
    trimStartMs: 0,
    trimEndMs: null,
    settings: { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 },
    analysisVersion: null,
    updatedAt: 'ignored',
    ...overrides,
  };
}

function makeTab(takeId = 'take-1'): Tab {
  return {
    takeId,
    notes: [
      {
        id: 'n1',
        startMs: 100,
        endMs: 300,
        midi: 64,
        confidence: 0.9,
        string: 1,
        fret: 0,
        locked: false,
        lowConfidence: false,
      },
    ],
    updatedAt: 'ignored',
    deletedStartMs: [500],
  };
}

async function rejection(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error('expected a rejection');
}

let clock: number;
let events: StorageEvent[];
let unsubscribe: () => void;
type FileOp = (takeId: string) => Promise<void>;
let audio: { deleteAudio: Mock<FileOp>; deleteRaw: Mock<FileOp> };
let db: TakeDb;

function newDb(migrations?: readonly Migration[]): TakeDb {
  return createTakeDb({
    name: NAME,
    migrations,
    audio,
    now: () => new Date(Date.parse(T0) + 1000 * ++clock),
  });
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetFenceForTests();
  clock = 0;
  events = [];
  unsubscribe = subscribe((e) => events.push(e));
  audio = {
    deleteAudio: vi.fn<FileOp>(() => Promise.resolve()),
    deleteRaw: vi.fn<FileOp>(() => Promise.resolve()),
  };
  db = newDb();
});

afterEach(() => {
  unsubscribe();
  vi.restoreAllMocks();
  resetFenceForTests();
});

describe('round-trip', () => {
  it('reads back a created Take and its Tab deep-equal, plus updatedAt', async () => {
    const take = makeTake();
    const tab = makeTab();
    const created = await db.createTake(take);
    const savedTab = await db.putTab(tab, 'take-session');

    expect(await db.getTake(take.id)).toEqual({ ...take, updatedAt: created.updatedAt });
    expect(await db.getTab(take.id)).toEqual({ ...tab, updatedAt: savedTab.updatedAt });
    expect(created.updatedAt).toBe('2026-10-01T10:00:01.000Z');
    expect(savedTab.updatedAt).toBe('2026-10-01T10:00:02.000Z');
  });

  it('lists takes by createdAt and returns null for unknown ids', async () => {
    await db.createTake(makeTake('b', { createdAt: '2026-10-02T00:00:00.000Z' }));
    await db.createTake(makeTake('a', { createdAt: '2026-10-01T00:00:00.000Z' }));
    expect((await db.listTakes()).map((t) => t.id)).toEqual(['a', 'b']);
    expect(await db.getTake('nope')).toBeNull();
    expect(await db.getTab('nope')).toBeNull();
  });

  it('patchTake merges the patch and stamps updatedAt', async () => {
    await db.createTake(makeTake());
    const patched = await db.patchTake(
      'take-1',
      { status: 'recorded', durationMs: 5000, audioMime: 'audio/webm;codecs=opus' },
      'recording-session',
    );
    expect(patched).toMatchObject({
      status: 'recorded',
      durationMs: 5000,
      title: makeTake().title,
    });
    expect(patched.updatedAt).toBe('2026-10-01T10:00:02.000Z');
    expect(await db.getTake('take-1')).toEqual(patched);
  });
});

describe('missing take', () => {
  it('patchTake, putTab and commitAnalysis reject take-not-found and write nothing', async () => {
    expect((await rejection(db.patchTake('x', { title: 'T' }, 'take-session'))).code).toBe(
      'take-not-found',
    );
    expect((await rejection(db.putTab(makeTab('x'), 'take-session'))).code).toBe('take-not-found');
    expect(
      (await rejection(db.commitAnalysis('x', makeTab('x'), { status: 'analyzed' }))).code,
    ).toBe('take-not-found');
    expect(await db.getTake('x')).toBeNull();
    expect(await db.getTab('x')).toBeNull();
    expect(events).toEqual([]);
  });
});

describe('createTake', () => {
  it('rejects a duplicate id with storage-failed and keeps the original', async () => {
    const original = await db.createTake(makeTake());
    events = [];
    const err = await rejection(db.createTake(makeTake('take-1', { title: 'Other' })));
    expect(err.code).toBe('storage-failed');
    expect(await db.getTake('take-1')).toEqual(original);
    expect(events).toEqual([]);
  });
});

describe('field ownership (dev builds)', () => {
  it('throws when a writer patches a field it does not own, and writes nothing', async () => {
    const original = await db.createTake(makeTake());
    events = [];
    await expect(db.patchTake('take-1', { title: 'X' }, 'recording-session')).rejects.toThrow(
      /recording-session may not write Take field\(s\): title/,
    );
    await expect(db.patchTake('take-1', { durationMs: 1 }, 'library-session')).rejects.toThrow(
      /library-session/,
    );
    await expect(
      db.patchTake('take-1', { updatedAt: T0 } as never, 'take-session'),
    ).rejects.toThrow(/updatedAt/);
    await expect(db.commitAnalysis('take-1', makeTab(), { micLabel: 'x' })).rejects.toThrow(
      /take-session may not write/,
    );
    expect(await db.getTake('take-1')).toEqual(original);
    expect(await db.getTab('take-1')).toBeNull();
    expect(events).toEqual([]);
  });

  it('skips the check when disabled (production builds)', async () => {
    const prod = createTakeDb({ name: NAME, audio, checkOwnership: false });
    await prod.createTake(makeTake());
    await expect(
      prod.patchTake('take-1', { title: 'X' }, 'recording-session'),
    ).resolves.toMatchObject({ title: 'X' });
  });
});

describe('commitAnalysis', () => {
  it('writes Tab and Take patch in one transaction and emits tab-put then take-put', async () => {
    await db.createTake(makeTake('take-1', { status: 'recorded' }));
    events = [];
    const warnings = { tuningOffsetCents: -3, belowRangeNotes: 0 };
    const { take, tab } = await db.commitAnalysis('take-1', makeTab(), {
      status: 'analyzed',
      analysisVersion: '0.1.0',
      warnings,
    });
    expect(take).toMatchObject({ status: 'analyzed', analysisVersion: '0.1.0', warnings });
    expect(tab.updatedAt).toBe(take.updatedAt);
    expect(await db.getTake('take-1')).toEqual(take);
    expect(await db.getTab('take-1')).toEqual(tab);
    expect(events).toEqual([
      { type: 'tab-put', takeId: 'take-1', writer: 'take-session' },
      { type: 'take-put', takeId: 'take-1', writer: 'take-session' },
    ]);
  });
});

describe('deleteTake', () => {
  it('removes Take and Tab, emits one take-deleted, then removes audio and raw files', async () => {
    await db.createTake(makeTake());
    await db.putTab(makeTab(), 'take-session');
    events = [];
    await db.deleteTake('take-1', 'library-session');
    expect(await db.getTake('take-1')).toBeNull();
    expect(await db.getTab('take-1')).toBeNull();
    expect(events).toEqual([{ type: 'take-deleted', takeId: 'take-1', writer: 'library-session' }]);
    expect(audio.deleteAudio).toHaveBeenCalledWith('take-1');
    expect(audio.deleteRaw).toHaveBeenCalledWith('take-1');
  });

  it('treats OPFS removal as best-effort', async () => {
    audio.deleteAudio.mockRejectedValue(new AppError('storage-failed', 'boom'));
    audio.deleteRaw.mockRejectedValue(new AppError('storage-failed', 'boom'));
    await db.createTake(makeTake());
    await expect(db.deleteTake('take-1', 'library-session')).resolves.toBeUndefined();
    expect(await db.getTake('take-1')).toBeNull();
  });

  it('emits nothing for an unknown take but still clears its files', async () => {
    await db.deleteTake('ghost', 'recording-session');
    expect(events).toEqual([]);
    expect(audio.deleteRaw).toHaveBeenCalledWith('ghost');
  });
});

describe('quota', () => {
  function quotaOnPut(callNo: number) {
    let calls = 0;
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore['put']>
    ) {
      if (++calls === callNo) throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return put.apply(this, args);
    });
  }

  it('rejects storage-full, leaves existing data unchanged and emits nothing', async () => {
    const original = await db.createTake(makeTake());
    events = [];
    quotaOnPut(1);
    const err = await rejection(db.patchTake('take-1', { title: 'New' }, 'take-session'));
    expect(err.code).toBe('storage-full');
    vi.restoreAllMocks();
    expect(await db.getTake('take-1')).toEqual(original);
    expect(events).toEqual([]);
  });

  it('rolls back the whole commitAnalysis transaction', async () => {
    await db.createTake(makeTake('take-1', { status: 'recorded' }));
    const oldTab = await db.putTab(makeTab(), 'take-session');
    const take = await db.getTake('take-1');
    events = [];
    quotaOnPut(2); // the Tab put succeeds, the Take put fails
    const err = await rejection(
      db.commitAnalysis('take-1', { ...makeTab(), notes: [] }, { status: 'analyzed' }),
    );
    expect(err.code).toBe('storage-full');
    vi.restoreAllMocks();
    expect(await db.getTab('take-1')).toEqual(oldTab);
    expect(await db.getTake('take-1')).toEqual(take);
    expect(events).toEqual([]);
  });

  it('maps a quota abort at commit to storage-full', async () => {
    await db.createTake(makeTake());
    const original = await db.getTake('take-1');
    events = [];
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore['put']>
    ) {
      const request = put.apply(this, args);
      // A browser reports quota at commit by aborting the transaction with this error.
      this.transaction.abort();
      Object.defineProperty(this.transaction, 'error', {
        value: new DOMException('Quota exceeded', 'QuotaExceededError'),
      });
      return request;
    });
    const err = await rejection(db.patchTake('take-1', { title: 'New' }, 'take-session'));
    expect(err.code).toBe('storage-full');
    vi.restoreAllMocks();
    expect(await db.getTake('take-1')).toEqual(original);
    expect(events).toEqual([]);
  });

  it('maps other failures to storage-failed', async () => {
    await db.createTake(makeTake());
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('nope', 'UnknownError');
    });
    expect((await rejection(db.patchTake('take-1', { title: 'x' }, 'take-session'))).code).toBe(
      'storage-failed',
    );
  });
});

describe('events', () => {
  it('carries the writer of each write', async () => {
    await db.createTake(makeTake());
    await db.patchTake('take-1', { title: 'Renamed' }, 'take-session');
    await db.patchTake('take-1', { audioMime: null }, 'library-session');
    await db.putTab(makeTab(), 'take-session');
    expect(events).toEqual([
      { type: 'take-put', takeId: 'take-1', writer: 'recording-session' },
      { type: 'take-put', takeId: 'take-1', writer: 'take-session' },
      { type: 'take-put', takeId: 'take-1', writer: 'library-session' },
      { type: 'tab-put', takeId: 'take-1', writer: 'take-session' },
    ]);
  });

  it('are delivered after commit: a listener reads the committed record', async () => {
    const seen: (Take | null)[] = [];
    const stop = subscribe((e) => {
      if (e.type === 'take-put') void db.getTake(e.takeId).then((t) => seen.push(t));
    });
    await db.createTake(makeTake());
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]?.id).toBe('take-1');
    stop();
  });
});

describe('importTakes', () => {
  it('writes whole records as given and emits one library-restored with the count', async () => {
    const a = makeTake('a', { updatedAt: '2025-01-01T00:00:00.000Z', status: 'analyzed' });
    const b = makeTake('b', { updatedAt: '2025-01-02T00:00:00.000Z' });
    const tab = { ...makeTab('a'), updatedAt: '2025-01-01T00:00:00.000Z' };
    expect(
      await db.importTakes([
        { take: a, tab },
        { take: b, tab: null },
      ]),
    ).toBe(2);
    expect(await db.getTake('a')).toEqual(a);
    expect(await db.getTake('b')).toEqual(b);
    expect(await db.getTab('a')).toEqual(tab);
    expect(events).toEqual([{ type: 'library-restored', count: 2, writer: 'restore' }]);
  });
});

describe('old tabs', () => {
  it('default a missing deletedStartMs to []', async () => {
    await db.createTake(makeTake());
    const raw = await openDB(NAME);
    const { deletedStartMs: _omitted, ...oldTab } = makeTab();
    void _omitted;
    await raw.put('tabs', oldTab);
    raw.close();
    expect((await db.getTab('take-1'))?.deletedStartMs).toEqual([]);
    expect((await db.listTabs())[0]?.deletedStartMs).toEqual([]);
  });
});

describe('listTabs', () => {
  it('reads every tab in one call; empty with none', async () => {
    expect(await db.listTabs()).toEqual([]);
    await db.importTakes([
      { take: makeTake('a'), tab: makeTab('a') },
      { take: makeTake('b'), tab: null },
      { take: makeTake('c'), tab: makeTab('c') },
    ]);
    expect((await db.listTabs()).map((t) => t.takeId).sort()).toEqual(['a', 'c']);
    expect(await db.listTabs()).toContainEqual(makeTab('a'));
  });
});

describe('fenceWrites', () => {
  it('makes every write reject instance-taken while reads keep working', async () => {
    const take = await db.createTake(makeTake());
    events = [];
    db.fenceWrites();
    const writes: Promise<unknown>[] = [
      db.createTake(makeTake('other')),
      db.patchTake('take-1', { title: 'X' }, 'take-session'),
      db.putTab(makeTab(), 'take-session'),
      db.commitAnalysis('take-1', makeTab(), { status: 'analyzed' }),
      db.importTakes([{ take: makeTake('z'), tab: null }]),
      db.deleteTake('take-1', 'library-session'),
    ];
    for (const w of writes) expect((await rejection(w)).code).toBe('instance-taken');
    expect(await db.getTake('take-1')).toEqual(take);
    expect(await db.listTakes()).toHaveLength(1);
    expect(audio.deleteAudio).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});

describe('close', () => {
  it('closes the connection: later reads and writes reject instance-taken', async () => {
    await db.createTake(makeTake());
    db.close();
    expect((await rejection(db.getTake('take-1'))).code).toBe('instance-taken');
    expect((await rejection(db.listTakes())).code).toBe('instance-taken');
    expect((await rejection(db.patchTake('take-1', { title: 'X' }, 'take-session'))).code).toBe(
      'instance-taken',
    );
    // Closed for real: a newer version opens without being blocked by this connection.
    const states: ConnectionState[] = [];
    db.onConnectionState((s) => states.push(s));
    const newer = await openDB(NAME, DB_VERSION + 1);
    newer.close();
    expect(states).toEqual([]);
    // A second close does nothing.
    db.close();
  });

  it('an operation that got the connection before close() rejects instance-taken', async () => {
    await db.createTake(makeTake());
    const original = IDBDatabase.prototype.transaction;
    // The close lands between the operation getting its connection and opening its transaction.
    const closeFirst = function (this: IDBDatabase, ...args: Parameters<typeof original>) {
      db.close();
      this.close();
      return original.apply(this, args);
    };
    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementationOnce(closeFirst);
    const write = await rejection(db.patchTake('take-1', { title: 'X' }, 'take-session'));
    expect(write.code).toBe('instance-taken');
    expect(write.cause).toMatchObject({ name: 'InvalidStateError' });
    spy.mockRestore();
  });

  it('a read that got the connection before close() rejects instance-taken', async () => {
    await db.createTake(makeTake());
    const original = IDBDatabase.prototype.transaction;
    const closeFirst = function (this: IDBDatabase, ...args: Parameters<typeof original>) {
      db.close();
      this.close();
      return original.apply(this, args);
    };
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementationOnce(closeFirst);
    expect((await rejection(db.getTake('take-1'))).code).toBe('instance-taken');
  });

  it('closes an open still in flight once it succeeds', async () => {
    const pending = db.listTakes();
    db.close();
    await expect(pending).resolves.toEqual([]);
    const newer = await openDB(NAME, DB_VERSION + 1);
    expect(newer.version).toBe(DB_VERSION + 1);
    newer.close();
  });
});

describe('connection state', () => {
  it('closes on versionchange and reports it', async () => {
    const states: ConnectionState[] = [];
    db.onConnectionState((s) => states.push(s));
    await db.createTake(makeTake());
    // Another tab opens a newer version: ours must close so its upgrade can proceed.
    const newer = await openDB(NAME, DB_VERSION + 1);
    expect(newer.version).toBe(DB_VERSION + 1);
    newer.close();
    expect(states).toEqual(['versionchange']);
    expect((await rejection(db.getTake('take-1'))).code).toBe('storage-failed');
  });

  it('reports blocked while an older connection stays open, then open', async () => {
    const old = await openDB(NAME, 1, {
      upgrade: (d) => {
        d.createObjectStore('takes', { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
        d.createObjectStore('tabs', { keyPath: 'takeId' });
      },
    });
    const upgraded = newDb([...MIGRATIONS, () => {}]);
    const states: ConnectionState[] = [];
    upgraded.onConnectionState((s) => states.push(s));
    const pending = upgraded.listTakes();
    await vi.waitFor(() => expect(states).toEqual(['blocked']));
    old.close();
    await expect(pending).resolves.toEqual([]);
    expect(states).toEqual(['blocked', 'open']);
  });
});
