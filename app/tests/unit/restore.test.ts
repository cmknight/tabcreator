import { describe, expect, it, vi } from 'vitest';
import type { Tab, Take } from '../../src/model/types';
import type {
  BackupEntry,
  BackupWorker,
  FromBackupWorker,
  ToBackupWorker,
} from '../../src/storage/backup';
import { readBackup, validateBackup } from '../../src/storage/restore';

// Story "Restore from a backup" (6.6, US-7.3, Flow 4): `validateBackup` against every matrix row
// (format, takes, tabs, audio entries), and `readBackup` with a fake worker. The real worker and
// OPFS run in tests/e2e/restore.dev.spec.ts.

function makeTake(id: string, overrides: Partial<Take> = {}): Take {
  return {
    id,
    title: `Take ${id}`,
    createdAt: '2026-10-01T10:00:00.000Z',
    status: 'analyzed',
    durationMs: 13_000,
    sampleRate: 48_000,
    tuning: 'EADGBE',
    micLabel: 'Mic',
    audioMime: 'audio/webm;codecs=opus',
    trimStartMs: 0,
    trimEndMs: null,
    settings: { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 },
    analysisVersion: '1',
    updatedAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

function makeTab(takeId: string): Tab {
  return {
    takeId,
    notes: [
      {
        id: `${takeId}-n1`,
        startMs: 0,
        endMs: 100,
        midi: 40,
        confidence: 0.9,
        string: 6,
        fret: 0,
        locked: false,
        lowConfidence: false,
      },
      {
        id: `${takeId}-n2`,
        startMs: 200,
        endMs: 300,
        midi: 45,
        confidence: 1,
        string: 5,
        fret: 0,
        locked: true,
        lowConfidence: false,
        inserted: true,
      },
    ],
    updatedAt: '2026-10-01T10:00:00.000Z',
    deletedStartMs: [500],
  };
}

const manifestOf = (takes: unknown[], tabs: unknown[] = [], extra: object = {}) =>
  JSON.stringify({ format: 1, exportedAt: '2026-10-06T10:00:00.000Z', takes, tabs, ...extra });

const entry = (name: string, bytes = [1, 2, 3]): BackupEntry => ({
  name,
  blob: new Blob([new Uint8Array(bytes)]),
});

const invalid = (manifest: string | null, entries: BackupEntry[] = []) =>
  expect(() => validateBackup(manifest, entries)).toThrow(
    expect.objectContaining({ code: 'backup-invalid' }),
  );

describe('validateBackup', () => {
  it('a valid backup: the records as stored (unknown fields kept), audio typed by extension', async () => {
    const a = { ...makeTake('a'), futureField: 'kept' };
    const wav = makeTake('w', {
      audioMime: 'audio/wav',
      status: 'recorded',
      analysisVersion: null,
    });
    const optional = makeTake('o', {
      warnings: { tuningOffsetCents: -12, belowRangeNotes: 2 },
      countInBpm: 100,
      clipped: true,
      stopReason: 'max-length',
      trimEndMs: 9000,
    });
    const tab = { ...makeTab('a'), extra: [1] };
    const result = validateBackup(manifestOf([a, wav, optional], [tab]), [
      entry('audio/a.webm', [9, 8, 7]),
      entry('audio/w.wav'),
    ]);
    expect(result.takes).toEqual([a, wav, optional]);
    expect(result.tabs).toEqual([tab]);
    expect([...result.audio.keys()]).toEqual(['a', 'w']);
    expect(result.audio.get('a')!.type).toBe('audio/webm;codecs=opus');
    expect(result.audio.get('w')!.type).toBe('audio/wav');
    expect([...new Uint8Array(await result.audio.get('a')!.arrayBuffer())]).toEqual([9, 8, 7]);
  });

  it('an empty backup is valid', () => {
    expect(validateBackup(manifestOf([]), [])).toEqual({ takes: [], tabs: [], audio: new Map() });
  });

  it('a take with an audio type but no entry is valid, restored without audio', () => {
    const result = validateBackup(manifestOf([makeTake('a')]), []);
    expect(result.audio.size).toBe(0);
  });

  it('a file under another format than the take type is kept under its own extension', () => {
    const result = validateBackup(manifestOf([makeTake('a')]), [entry('audio/a.ogg')]);
    expect(result.audio.get('a')!.type).toBe('audio/ogg;codecs=opus');
  });

  it('an older tab without deletedStartMs is valid', () => {
    const { deletedStartMs: _gone, ...old } = makeTab('a');
    void _gone;
    expect(validateBackup(manifestOf([makeTake('a')], [old]), []).tabs).toEqual([old]);
  });

  it('a missing or unparsable manifest is invalid', () => {
    invalid(null);
    invalid('{not json');
    invalid('[]');
    invalid('null');
  });

  it('a format other than 1, or missing parts, is invalid', () => {
    invalid(manifestOf([], [], { format: 2 }));
    invalid(JSON.stringify({ exportedAt: 'x', takes: [], tabs: [] }));
    invalid(JSON.stringify({ format: 1, exportedAt: 'x', takes: [] }));
    invalid(JSON.stringify({ format: 1, exportedAt: 'x', tabs: [] }));
    invalid(JSON.stringify({ format: 1, takes: [], tabs: [] }));
    invalid(JSON.stringify({ format: 1, exportedAt: 'x', takes: {}, tabs: [] }));
  });

  it('a malformed take is invalid', () => {
    const bad: unknown[] = [
      null,
      'take',
      makeTake(''),
      makeTake('a/b'),
      makeTake('..'),
      { ...makeTake('a'), id: 3 },
      { ...makeTake('a'), title: undefined },
      makeTake('a', { status: 'recording' }),
      { ...makeTake('a'), status: 'done' },
      makeTake('a', { durationMs: -1 }),
      makeTake('a', { durationMs: Number.NaN }),
      makeTake('a', { sampleRate: 0 }),
      { ...makeTake('a'), tuning: 'DADGAD' },
      { ...makeTake('a'), audioMime: 3 },
      { ...makeTake('a'), trimEndMs: 'end' },
      { ...makeTake('a'), settings: { sensitivity: 0.5, minNoteMs: 40 } },
      { ...makeTake('a'), analysisVersion: 1 },
      { ...makeTake('a'), updatedAt: undefined },
      { ...makeTake('a'), createdAt: undefined },
      { ...makeTake('a'), micLabel: null },
      { ...makeTake('a'), warnings: { tuningOffsetCents: 1 } },
      { ...makeTake('a'), countInBpm: '100' },
      { ...makeTake('a'), clipped: 1 },
      { ...makeTake('a'), stopReason: 'bored' },
    ];
    for (const take of bad) invalid(manifestOf([take]));
  });

  it('duplicate take ids are invalid', () => {
    invalid(manifestOf([makeTake('a'), makeTake('a', { title: 'Again' })]));
  });

  it('a malformed tab, a tab with no take, or two tabs for one take is invalid', () => {
    const take = makeTake('a');
    const tab = makeTab('a');
    const note = tab.notes[0]!;
    const bad: unknown[] = [
      null,
      { ...tab, takeId: 7 },
      { ...tab, notes: 'none' },
      { ...tab, updatedAt: null },
      { ...tab, deletedStartMs: ['x'] },
      { ...tab, notes: [{ ...note, string: 7 }] },
      { ...tab, notes: [{ ...note, string: 0 }] },
      { ...tab, notes: [{ ...note, fret: -1 }] },
      { ...tab, notes: [{ ...note, fret: 1.5 }] },
      { ...tab, notes: [{ ...note, startMs: Infinity }] },
      { ...tab, notes: [{ ...note, locked: 'no' }] },
      { ...tab, notes: [{ ...note, inserted: false }] },
      { ...tab, notes: [{ ...note, id: undefined }] },
    ];
    for (const t of bad) invalid(manifestOf([take], [t]));
    invalid(manifestOf([take], [makeTab('b')]));
    invalid(manifestOf([take], [tab, tab]));
  });

  it('a bad audio entry is invalid', () => {
    const takes = [makeTake('a'), makeTake('gone', { audioMime: null })];
    const m = manifestOf(takes);
    invalid(m, [entry('readme.txt')]);
    invalid(m, [entry('audio/')]);
    invalid(m, [entry('audio/a')]);
    invalid(m, [entry('audio/a.')]);
    invalid(m, [entry('audio/sub/a.webm')]);
    invalid(m, [entry('raw/a.f32')]);
    invalid(m, [entry('audio/a.flac')]);
    invalid(m, [entry('audio/x.webm')]);
    invalid(m, [entry('audio/a.webm'), entry('audio/a.wav')]);
    invalid(m, [entry('audio/gone.webm')]);
  });
});

/** A fake worker that replies through `script` once posted to. */
function fakeWorker(script: (w: BackupWorker, request: ToBackupWorker) => void) {
  const posted: ToBackupWorker[] = [];
  const worker: BackupWorker = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: vi.fn((request: ToBackupWorker) => {
      posted.push(request);
      queueMicrotask(() => script(worker, request));
    }),
    terminate: vi.fn(),
  };
  return { worker, posted };
}

const send = (w: BackupWorker, data: FromBackupWorker) =>
  w.onmessage?.({ data } as MessageEvent<FromBackupWorker>);

describe('readBackup', () => {
  it('posts the file as a read request, validates the reply, terminates the worker', async () => {
    const file = new Blob(['zip']);
    const { worker, posted } = fakeWorker((w) =>
      send(w, {
        type: 'read',
        manifest: manifestOf([makeTake('a')], [makeTab('a')]),
        entries: [entry('audio/a.webm')],
      }),
    );
    const result = await readBackup(file, { createWorker: () => worker });
    expect(posted).toEqual([{ type: 'read', file }]);
    expect(result.takes.map((t) => t.id)).toEqual(['a']);
    expect(result.audio.has('a')).toBe(true);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('a reply that fails validation rejects backup-invalid', async () => {
    const { worker } = fakeWorker((w) =>
      send(w, { type: 'read', manifest: manifestOf([], [], { format: 2 }), entries: [] }),
    );
    await expect(readBackup(new Blob([]), { createWorker: () => worker })).rejects.toMatchObject({
      code: 'backup-invalid',
    });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("the worker's backup-invalid error rejects with it", async () => {
    const { worker } = fakeWorker((w) =>
      send(w, { type: 'error', code: 'backup-invalid', message: 'invalid zip data' }),
    );
    await expect(readBackup(new Blob([]), { createWorker: () => worker })).rejects.toMatchObject({
      code: 'backup-invalid',
    });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('the worker failing, or a reply that cannot be read, rejects storage-failed', async () => {
    const crash = fakeWorker((w) =>
      w.onerror?.({ message: 'oom', preventDefault: () => {} } as ErrorEvent),
    );
    await expect(
      readBackup(new Blob([]), { createWorker: () => crash.worker }),
    ).rejects.toMatchObject({ code: 'storage-failed' });
    expect(crash.worker.terminate).toHaveBeenCalledTimes(1);
    const garbled = fakeWorker((w) => w.onmessageerror?.({} as MessageEvent));
    await expect(
      readBackup(new Blob([]), { createWorker: () => garbled.worker }),
    ).rejects.toMatchObject({ code: 'storage-failed' });
  });

  it('a worker that cannot start rejects storage-failed', async () => {
    await expect(
      readBackup(new Blob([]), {
        createWorker: () => {
          throw new Error('no workers');
        },
      }),
    ).rejects.toMatchObject({ code: 'storage-failed' });
  });

  it('a start failure names the Restore worker', async () => {
    await expect(
      readBackup(new Blob([]), {
        createWorker: () => {
          throw new Error('no workers');
        },
      }),
    ).rejects.toMatchObject({
      code: 'storage-failed',
      message: 'Restore worker failed to start',
    });
  });

  it('a reply of another type rejects storage-failed and terminates the worker', async () => {
    const { worker } = fakeWorker((w) => send(w, { type: 'progress', progress: 0.5 }));
    await expect(readBackup(new Blob([]), { createWorker: () => worker })).rejects.toMatchObject({
      code: 'storage-failed',
      message: 'Restore worker: unexpected reply progress',
    });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('a request that cannot be posted rejects storage-failed and terminates the worker', async () => {
    const { worker } = fakeWorker(() => {});
    vi.mocked(worker.postMessage).mockImplementationOnce(() => {
      throw new Error('DataCloneError');
    });
    await expect(readBackup(new Blob([]), { createWorker: () => worker })).rejects.toMatchObject({
      code: 'storage-failed',
      message: 'Restore worker: posting failed',
    });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
