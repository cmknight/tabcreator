import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/model/errors';
import type { AnalysisResult, DetectedNote, Tab, Take } from '../../src/model/types';
import { createAnalysis, type AnalysisDeps } from '../../src/session/analysis';
import type { FretPosition } from '../../src/engine/engine-client';
import type { StorageEvent, StorageListener } from '../../src/storage/events';
import { deferred } from './helpers';

// Story 5.6 (US-4.4, US-4.5; spine AD-8, AD-9, AD-15): ensureAnalysed against a mocked engine,
// database and audio store (plan I/O matrix, the analysis side).

const TAKE: Take = {
  id: 't1',
  title: 'Take 1',
  createdAt: '2026-10-04T10:00:00.000Z',
  status: 'recorded',
  durationMs: 4_000,
  sampleRate: 48_000,
  tuning: 'EADGBE',
  micLabel: 'Mic',
  audioMime: 'audio/webm;codecs=opus',
  trimStartMs: 120,
  trimEndMs: 3_800,
  countInBpm: 120,
  settings: { sensitivity: 0.6, minNoteMs: 50, maxFret: 15 },
  analysisVersion: null,
  updatedAt: '2026-10-04T10:00:04.000Z',
};

const note = (startMs: number, midi: number, confidence = 0.9): DetectedNote => ({
  startMs,
  endMs: startMs + 200,
  midi,
  confidence,
});

const RESULT: AnalysisResult = {
  notes: [note(100, 60), note(400, 62)],
  tuningOffsetCents: -3.5,
  belowRangeNotes: 1,
  confidenceThreshold: 0.35,
};

interface Harness {
  deps: AnalysisDeps;
  calls: string[];
  progress: (p: number) => void;
  finishAnalyze: (result?: AnalysisResult) => void;
  failAnalyze: (err: unknown) => void;
  /** Delivers a storage event to the registry's listener, if it has one. */
  emit: (event: StorageEvent) => void;
  hasStorageListener: () => boolean;
}

function harness(
  options: {
    take?: Take;
    positions?: (n: DetectedNote[]) => (FretPosition | null)[];
    readRaw?: () => Promise<Float32Array>;
    readCompressed?: () => Promise<Blob | null>;
    decode?: (blob: Blob, rate: number) => Promise<{ pcm: Float32Array; sampleRate: number }>;
    commit?: () => Promise<{ take: Take; tab: Tab }>;
    deleteRaw?: () => Promise<void>;
  } = {},
): Harness {
  const take = options.take ?? TAKE;
  const calls: string[] = [];
  // The current analyze call's result. Rejected by `cancel` even when analyze was never called
  // (observed through analyze only); each analyze after the first, or after a cancel, gets a
  // fresh one.
  const fresh = () => {
    const d = deferred<AnalysisResult>();
    d.promise.catch(() => {});
    return d;
  };
  let analyzeDone = fresh();
  let used = false;
  let onProgress: ((p: number) => void) | undefined;
  let lastNotes: DetectedNote[] = [];
  let storageListener: StorageListener | null = null;
  const deps: AnalysisDeps = {
    engine: {
      analyze: vi.fn((_id, _pcm, _rate, _input, progress) => {
        calls.push('analyze');
        onProgress = progress;
        if (used) analyzeDone = fresh();
        used = true;
        return analyzeDone.promise.then((r) => {
          lastNotes = r.notes;
          return r;
        });
      }),
      mapFrets: vi.fn(async (_id, notes) => {
        calls.push('mapFrets');
        return options.positions
          ? options.positions(lastNotes)
          : notes.map(() => ({ string: 2 as const, fret: 1 }));
      }),
      version: vi.fn(async () => '0.4.0'),
      // As the engine client does: the take's in-flight analyze rejects.
      cancel: vi.fn((id: string) => {
        analyzeDone.reject(new AppError('analysis-cancelled', `cancelled take ${id}`));
        used = true;
      }),
    },
    subscribeStorage: vi.fn((listener: StorageListener) => {
      storageListener = listener;
      return () => {
        storageListener = null;
      };
    }),
    db: {
      getTake: vi.fn(async () => take),
      getTab: vi.fn(async () => null),
      commitAnalysis: vi.fn(async (takeId, tab, patch) => {
        calls.push('commitAnalysis');
        if (options.commit) return options.commit();
        return { take: { ...take, ...patch, id: takeId }, tab };
      }),
    },
    audio: {
      readRaw: vi.fn(async () => {
        calls.push('readRaw');
        return options.readRaw ? options.readRaw() : new Float32Array(48_000);
      }),
      readCompressed: vi.fn(async () => {
        calls.push('readCompressed');
        return options.readCompressed ? options.readCompressed() : null;
      }),
      deleteRaw: vi.fn(async () => {
        calls.push('deleteRaw');
        if (options.deleteRaw) return options.deleteRaw();
      }),
    },
    decode: vi.fn(async (blob: Blob, rate: number) => {
      calls.push('decode');
      return options.decode
        ? options.decode(blob, rate)
        : { pcm: new Float32Array(rate), sampleRate: rate };
    }),
    now: () => new Date('2026-10-04T10:01:00.000Z'),
    newId: (() => {
      let n = 0;
      return () => `n${++n}`;
    })(),
  };
  return {
    deps,
    calls,
    progress: (p) => onProgress?.(p),
    finishAnalyze: (result = RESULT) => analyzeDone.resolve(result),
    failAnalyze: (err) => analyzeDone.reject(err),
    emit: (event) => storageListener?.(event),
    hasStorageListener: () => storageListener !== null,
  };
}

/** Lets pending promise callbacks run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.restoreAllMocks());

describe('ensureAnalysed', () => {
  it('fresh take: progress 0.9·p then 1.0; one commit, then deleteRaw; resolves with the commit', async () => {
    const h = harness();
    const analysis = createAnalysis(h.deps);
    const seen: number[] = [];
    const done = analysis.ensureAnalysed(TAKE, (p) => seen.push(p));
    await settle();
    expect(analysis.isAnalysing()).toBe(true);
    h.progress(0.1);
    h.progress(0.5);
    h.progress(0.4); // not monotone from the engine: ignored
    h.progress(1);
    h.finishAnalyze();
    const outcome = await done;

    expect(seen).toEqual([0.9 * 0.1, 0.9 * 0.5, 0.9, 1]);
    expect(h.calls).toEqual(['readRaw', 'analyze', 'mapFrets', 'commitAnalysis', 'deleteRaw']);
    expect(h.deps.db.commitAnalysis).toHaveBeenCalledTimes(1);
    const [takeId, tab, patch] = vi.mocked(h.deps.db.commitAnalysis).mock.calls[0]!;
    expect(takeId).toBe('t1');
    expect(tab).toEqual({
      takeId: 't1',
      updatedAt: '2026-10-04T10:01:00.000Z',
      deletedStartMs: [],
      notes: [
        { ...note(100, 60), id: 'n1', string: 2, fret: 1, locked: false, lowConfidence: false },
        { ...note(400, 62), id: 'n2', string: 2, fret: 1, locked: false, lowConfidence: false },
      ],
    });
    expect(patch).toEqual({
      status: 'analyzed',
      analysisVersion: '0.4.0',
      warnings: { tuningOffsetCents: -3.5, belowRangeNotes: 1 },
    });
    expect(outcome.take.status).toBe('analyzed');
    expect(outcome.tab).toBe(tab);
    expect(analysis.isAnalysing()).toBe(false);
  });

  it('explicit input: exactly the six fields; skipStartMs 100 with a count-in; the take sample rate', async () => {
    const take = { ...TAKE, settings: { ...TAKE.settings, extra: 1 } as Take['settings'] };
    const h = harness({ take });
    const done = createAnalysis(h.deps).ensureAnalysed(take);
    await settle();
    h.finishAnalyze();
    await done;
    const [, , rate, input] = vi.mocked(h.deps.engine.analyze).mock.calls[0]!;
    expect(rate).toBe(48_000);
    expect(input).toStrictEqual({
      sensitivity: 0.6,
      minNoteMs: 50,
      maxFret: 15,
      trimStartMs: 120,
      trimEndMs: 3_800,
      skipStartMs: 100,
    });
    expect(vi.mocked(h.deps.engine.mapFrets).mock.calls[0]).toEqual([
      't1',
      [
        { midi: 60, startMs: 100, endMs: 300 },
        { midi: 62, startMs: 400, endMs: 600 },
      ],
      [],
      15,
    ]);
  });

  it('no count-in: skipStartMs 0', async () => {
    const take: Take = { ...TAKE, countInBpm: undefined };
    const h = harness({ take });
    const done = createAnalysis(h.deps).ensureAnalysed(take);
    await settle();
    h.finishAnalyze();
    await done;
    expect(vi.mocked(h.deps.engine.analyze).mock.calls[0]![3].skipStartMs).toBe(0);
  });

  it('already analysed: no engine call', async () => {
    const h = harness();
    const analysis = createAnalysis(h.deps);
    await expect(analysis.ensureAnalysed({ ...TAKE, status: 'analyzed' })).rejects.toBeInstanceOf(
      AppError,
    );
    expect(h.deps.engine.analyze).not.toHaveBeenCalled();
    expect(h.deps.audio.readRaw).not.toHaveBeenCalled();
  });

  it('analysed since the caller read it: the stored take and tab, no engine call', async () => {
    const stored: Take = { ...TAKE, status: 'analyzed', analysisVersion: '0.4.0' };
    const tab: Tab = { takeId: 't1', notes: [], updatedAt: stored.updatedAt, deletedStartMs: [] };
    const h = harness({ take: stored });
    vi.mocked(h.deps.db.getTab).mockResolvedValue(tab);
    const outcome = await createAnalysis(h.deps).ensureAnalysed(TAKE);
    expect(outcome).toEqual({ take: stored, tab });
    expect(h.deps.engine.analyze).not.toHaveBeenCalled();
  });

  it('concurrent ensure and attach mid-run: one analyze; the late listener gets the progress so far and the same result', async () => {
    const h = harness();
    const analysis = createAnalysis(h.deps);
    const first: number[] = [];
    const second: number[] = [];
    const a = analysis.ensureAnalysed(TAKE, (p) => first.push(p));
    await settle();
    h.progress(0.5);
    const b = analysis.ensureAnalysed(TAKE, (p) => second.push(p));
    h.progress(1);
    h.finishAnalyze();
    const [ra, rb] = await Promise.all([a, b]);
    expect(h.deps.engine.analyze).toHaveBeenCalledTimes(1);
    expect(ra).toBe(rb);
    expect(second).toEqual([0.45, 0.9, 1]);
    expect(first).toEqual([0.45, 0.9, 1]);
  });

  it('two calls in the same tick: one analyze', async () => {
    const h = harness();
    const analysis = createAnalysis(h.deps);
    const a = analysis.ensureAnalysed(TAKE);
    const b = analysis.ensureAnalysed(TAKE);
    await settle();
    h.finishAnalyze();
    await Promise.all([a, b]);
    expect(h.deps.engine.analyze).toHaveBeenCalledTimes(1);
  });

  it('a detached listener gets no more progress; the run carries on', async () => {
    const h = harness();
    const analysis = createAnalysis(h.deps);
    const seen: number[] = [];
    const listener = (p: number) => seen.push(p);
    const done = analysis.ensureAnalysed(TAKE, listener);
    await settle();
    h.progress(0.5);
    analysis.detach('t1', listener);
    h.progress(1);
    h.finishAnalyze();
    await done;
    expect(seen).toEqual([0.45]);
    expect(h.deps.db.commitAnalysis).toHaveBeenCalledTimes(1);
  });

  it('lowConfidence: c 0.35 flags 0.49, not 0.51', async () => {
    const h = harness();
    const done = createAnalysis(h.deps).ensureAnalysed(TAKE);
    await settle();
    h.finishAnalyze({ ...RESULT, notes: [note(100, 60, 0.49), note(400, 62, 0.51)] });
    const { tab } = await done;
    expect(tab.notes.map((n) => n.lowConfidence)).toEqual([true, false]);
  });

  it('a null position drops that note', async () => {
    const h = harness({
      positions: (notes) =>
        notes.map((n, i) => (i === 1 ? null : { string: 3, fret: n.midi - 55 })),
    });
    const done = createAnalysis(h.deps).ensureAnalysed(TAKE);
    await settle();
    h.finishAnalyze({ ...RESULT, notes: [note(100, 57), note(400, 99), note(700, 59)] });
    const { tab } = await done;
    expect(tab.notes.map((n) => [n.startMs, n.string, n.fret])).toEqual([
      [100, 3, 2],
      [700, 3, 4],
    ]);
  });

  it('engine error: rejects with it; no commit, raw kept; the registry is cleared', async () => {
    const h = harness();
    const analysis = createAnalysis(h.deps);
    const done = analysis.ensureAnalysed(TAKE);
    await settle();
    h.failAnalyze(new AppError('analysis-failed', 'boom'));
    await expect(done).rejects.toMatchObject({ code: 'analysis-failed' });
    expect(h.deps.db.commitAnalysis).not.toHaveBeenCalled();
    expect(h.deps.audio.deleteRaw).not.toHaveBeenCalled();
    expect(analysis.isAnalysing()).toBe(false);
  });

  it('no raw and no compressed audio: audio-missing, no engine call', async () => {
    const h = harness({
      readRaw: () => Promise.reject(new AppError('audio-missing', 'no raw')),
    });
    await expect(createAnalysis(h.deps).ensureAnalysed(TAKE)).rejects.toMatchObject({
      code: 'audio-missing',
    });
    expect(h.deps.audio.readCompressed).toHaveBeenCalledWith(TAKE.id);
    expect(h.deps.decode).not.toHaveBeenCalled();
    expect(h.deps.engine.analyze).not.toHaveBeenCalled();
  });

  it('no raw and audioMime null: audio-missing without reading the compressed audio', async () => {
    const take: Take = { ...TAKE, audioMime: null };
    const h = harness({
      take,
      readRaw: () => Promise.reject(new AppError('audio-missing', 'no raw')),
      readCompressed: async () => new Blob(['x'], { type: 'audio/wav' }),
    });
    await expect(createAnalysis(h.deps).ensureAnalysed(take)).rejects.toMatchObject({
      code: 'audio-missing',
    });
    expect(h.deps.audio.readCompressed).not.toHaveBeenCalled();
    expect(h.deps.engine.analyze).not.toHaveBeenCalled();
  });

  it('raw present: the raw path, decode never called', async () => {
    const h = harness();
    const done = createAnalysis(h.deps).ensureAnalysed(TAKE);
    await settle();
    h.finishAnalyze();
    await done;
    expect(h.deps.audio.readCompressed).not.toHaveBeenCalled();
    expect(h.deps.decode).not.toHaveBeenCalled();
    expect(vi.mocked(h.deps.engine.analyze).mock.calls[0]?.[2]).toBe(TAKE.sampleRate);
  });

  it('no raw: decodes the compressed audio at the take rate, analyses it at the decoded rate, and skips deleteRaw', async () => {
    const blob = new Blob(['webm'], { type: 'audio/webm;codecs=opus' });
    const pcm = new Float32Array(10);
    const h = harness({
      readRaw: () => Promise.reject(new AppError('audio-missing', 'no raw')),
      readCompressed: async () => blob,
      // The decoded buffer reports its own rate, which the engine must be given.
      decode: async () => ({ pcm, sampleRate: 44_100 }),
    });
    const done = createAnalysis(h.deps).ensureAnalysed(TAKE);
    await settle();
    h.finishAnalyze();
    const outcome = await done;
    expect(outcome.take.status).toBe('analyzed');
    expect(h.deps.decode).toHaveBeenCalledWith(blob, TAKE.sampleRate);
    const call = vi.mocked(h.deps.engine.analyze).mock.calls[0];
    expect(call?.[1]).toBe(pcm);
    expect(call?.[2]).toBe(44_100);
    expect(h.calls).toEqual([
      'readRaw',
      'readCompressed',
      'decode',
      'analyze',
      'mapFrets',
      'commitAnalysis',
    ]);
    // There is no raw file to delete after a decode-sourced commit.
    expect(h.deps.audio.deleteRaw).not.toHaveBeenCalled();
  });

  it('no raw, the compressed read fails storage-failed: the run rejects with it, no decode or engine call', async () => {
    const h = harness({
      readRaw: () => Promise.reject(new AppError('audio-missing', 'no raw')),
      readCompressed: () => Promise.reject(new AppError('storage-failed', 'io')),
    });
    await expect(createAnalysis(h.deps).ensureAnalysed(TAKE)).rejects.toMatchObject({
      code: 'storage-failed',
    });
    expect(h.deps.decode).not.toHaveBeenCalled();
    expect(h.deps.engine.analyze).not.toHaveBeenCalled();
  });

  it('no raw, undecodable audio: the decode error (audio-missing, cause kept) rejects the run', async () => {
    const cause = new Error('EncodingError');
    const h = harness({
      readRaw: () => Promise.reject(new AppError('audio-missing', 'no raw')),
      readCompressed: async () => new Blob(['junk'], { type: 'audio/wav' }),
      decode: () => Promise.reject(new AppError('audio-missing', 'undecodable', { cause })),
    });
    const err: unknown = await createAnalysis(h.deps)
      .ensureAnalysed(TAKE)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'audio-missing' });
    expect((err as Error).cause).toBe(cause);
    expect(h.deps.engine.analyze).not.toHaveBeenCalled();
  });

  it('a raw read failure other than audio-missing does not fall back to decoding', async () => {
    const h = harness({
      readRaw: () => Promise.reject(new AppError('storage-failed', 'io')),
      readCompressed: async () => new Blob(['x'], { type: 'audio/wav' }),
    });
    await expect(createAnalysis(h.deps).ensureAnalysed(TAKE)).rejects.toMatchObject({
      code: 'storage-failed',
    });
    expect(h.deps.audio.readCompressed).not.toHaveBeenCalled();
  });

  it('commit fails: rejects, raw kept', async () => {
    const h = harness({
      commit: () => Promise.reject(new AppError('storage-failed', 'disk')),
    });
    const done = createAnalysis(h.deps).ensureAnalysed(TAKE);
    await settle();
    h.finishAnalyze();
    await expect(done).rejects.toMatchObject({ code: 'storage-failed' });
    expect(h.deps.audio.deleteRaw).not.toHaveBeenCalled();
  });

  it('raw delete fails: the commit stands and it is logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness({ deleteRaw: () => Promise.reject(new Error('locked')) });
    const done = createAnalysis(h.deps).ensureAnalysed(TAKE);
    await settle();
    h.finishAnalyze();
    const outcome = await done;
    expect(outcome.take.status).toBe('analyzed');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('cancelled mid-run (take deleted): rejects analysis-cancelled, no commit', async () => {
    const h = harness();
    const done = createAnalysis(h.deps).ensureAnalysed(TAKE);
    await settle();
    h.failAnalyze(new AppError('analysis-cancelled', 'cancelled take t1'));
    await expect(done).rejects.toMatchObject({ code: 'analysis-cancelled' });
    expect(h.deps.db.commitAnalysis).not.toHaveBeenCalled();
  });

  it('a non-AppError failure rejects as analysis-failed', async () => {
    const h = harness();
    const done = createAnalysis(h.deps).ensureAnalysed(TAKE);
    await settle();
    h.failAnalyze(new Error('oops'));
    await expect(done).rejects.toMatchObject({ code: 'analysis-failed' });
  });

  it("uses the stored take, not the caller's stale copy", async () => {
    const stored: Take = {
      ...TAKE,
      sampleRate: 44_100,
      trimStartMs: 500,
      settings: { sensitivity: 0.2, minNoteMs: 60, maxFret: 12 },
    };
    const h = harness({ take: stored });
    const done = createAnalysis(h.deps).ensureAnalysed(TAKE);
    await settle();
    h.finishAnalyze();
    await done;
    const [id, , rate, input] = vi.mocked(h.deps.engine.analyze).mock.calls[0]!;
    expect(id).toBe('t1');
    expect(rate).toBe(44_100);
    expect(input).toMatchObject({ sensitivity: 0.2, minNoteMs: 60, maxFret: 12, trimStartMs: 500 });
    expect(vi.mocked(h.deps.engine.mapFrets).mock.calls[0]![3]).toBe(12);
  });

  it('a stored take that is not recorded: analysis-failed, nothing read', async () => {
    const h = harness({ take: { ...TAKE, status: 'recording' } });
    await expect(createAnalysis(h.deps).ensureAnalysed(TAKE)).rejects.toMatchObject({
      code: 'analysis-failed',
    });
    expect(h.calls).toEqual([]);
  });

  it('a stored take analysed but without a tab: analysis-failed, nothing read', async () => {
    const h = harness({ take: { ...TAKE, status: 'analyzed' } });
    await expect(createAnalysis(h.deps).ensureAnalysed(TAKE)).rejects.toMatchObject({
      code: 'analysis-failed',
    });
    expect(h.calls).toEqual([]);
  });

  it('take deleted while no session is attached: the engine is cancelled, the run stops', async () => {
    const h = harness();
    const analysis = createAnalysis(h.deps);
    const listener = () => {};
    const done = analysis.ensureAnalysed(TAKE, listener);
    await settle();
    analysis.detach('t1', listener);
    h.emit({ type: 'take-deleted', takeId: 'other', writer: 'library-session' });
    expect(h.deps.engine.cancel).not.toHaveBeenCalled();
    h.emit({ type: 'take-deleted', takeId: 't1', writer: 'library-session' });
    expect(h.deps.engine.cancel).toHaveBeenCalledWith('t1');
    await expect(done).rejects.toMatchObject({ code: 'analysis-cancelled' });
    expect(h.deps.db.commitAnalysis).not.toHaveBeenCalled();
    expect(analysis.isAnalysing()).toBe(false);
    expect(h.hasStorageListener()).toBe(false);
  });

  it('take deleted before analyze is enqueued: analysis-cancelled, no engine call', async () => {
    const raw = deferred<Float32Array>();
    const h = harness({ readRaw: () => raw.promise });
    const analysis = createAnalysis(h.deps);
    const done = analysis.ensureAnalysed(TAKE);
    await settle();
    expect(h.calls).toEqual(['readRaw']);
    h.emit({ type: 'take-deleted', takeId: 't1', writer: 'library-session' });
    raw.resolve(new Float32Array(10));
    await expect(done).rejects.toMatchObject({ code: 'analysis-cancelled' });
    expect(h.deps.engine.analyze).not.toHaveBeenCalled();
    expect(analysis.isAnalysing()).toBe(false);
  });

  it('hold (dev ?holdAnalysis): nothing starts and nothing is in flight', async () => {
    const h = harness();
    const analysis = createAnalysis({ ...h.deps, hold: true });
    void analysis.ensureAnalysed(TAKE);
    await settle();
    expect(h.calls).toEqual([]);
    expect(analysis.isAnalysing()).toBe(false);
  });
});

// Story 5.7 (US-4.5): cancel, and the pending commit kept after a storage-full commit.
describe('cancel', () => {
  it('mid-analysis: the engine is cancelled and the run settles analysis-cancelled; no commit, raw kept', async () => {
    const h = harness();
    const analysis = createAnalysis(h.deps);
    const done = analysis.ensureAnalysed(TAKE);
    await settle();
    h.progress(0.3);
    expect(analysis.cancel('t1')).toBe(true);
    expect(h.deps.engine.cancel).toHaveBeenCalledWith('t1');
    await expect(done).rejects.toMatchObject({ code: 'analysis-cancelled' });
    expect(analysis.isAnalysing()).toBe(false);
    expect(h.deps.db.commitAnalysis).not.toHaveBeenCalled();
    expect(h.deps.audio.deleteRaw).not.toHaveBeenCalled();
    expect(h.hasStorageListener()).toBe(false);
  });

  it('while the raw file is read: settles at once, before the read ends; no engine run', async () => {
    const raw = deferred<Float32Array>();
    const h = harness({ readRaw: () => raw.promise });
    const analysis = createAnalysis(h.deps);
    const done = analysis.ensureAnalysed(TAKE);
    await settle();
    expect(analysis.cancel('t1')).toBe(true);
    await expect(done).rejects.toMatchObject({ code: 'analysis-cancelled' });
    expect(analysis.isAnalysing()).toBe(false);
    raw.resolve(new Float32Array(10));
    await settle();
    expect(h.deps.engine.analyze).not.toHaveBeenCalled();
  });

  it('then Analyse: a new run starts and completes', async () => {
    const h = harness();
    const analysis = createAnalysis(h.deps);
    const first = analysis.ensureAnalysed(TAKE);
    await settle();
    analysis.cancel('t1');
    await expect(first).rejects.toMatchObject({ code: 'analysis-cancelled' });
    const seen: number[] = [];
    const second = analysis.ensureAnalysed(TAKE, (p) => seen.push(p));
    await settle();
    h.progress(0.5);
    h.finishAnalyze();
    const outcome = await second;
    expect(outcome.take.status).toBe('analyzed');
    expect(h.deps.engine.analyze).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([0.45, 1]);
    expect(h.deps.db.commitAnalysis).toHaveBeenCalledTimes(1);
  });

  it('with no run in flight: false, nothing cancelled', () => {
    const h = harness();
    expect(createAnalysis(h.deps).cancel('t1')).toBe(false);
    expect(h.deps.engine.cancel).not.toHaveBeenCalled();
  });

  it('while committing: false; the run settles with the commit', async () => {
    const commit = deferred<{ take: Take; tab: Tab }>();
    const h = harness({ commit: () => commit.promise });
    const analysis = createAnalysis(h.deps);
    const done = analysis.ensureAnalysed(TAKE);
    await settle();
    h.finishAnalyze();
    await settle();
    expect(h.calls).toContain('commitAnalysis');
    expect(analysis.cancel('t1')).toBe(false);
    expect(h.deps.engine.cancel).not.toHaveBeenCalled();
    const tab: Tab = { takeId: 't1', notes: [], updatedAt: TAKE.updatedAt, deletedStartMs: [] };
    commit.resolve({ take: { ...TAKE, status: 'analyzed' }, tab });
    await expect(done).resolves.toMatchObject({ tab });
  });
});

describe('pending commit (storage full)', () => {
  /** A harness whose first `failures` commits reject with storage-full. */
  function storageFull(failures = 1) {
    let n = 0;
    const h = harness({
      commit: () =>
        n++ < failures
          ? Promise.reject(new AppError('storage-full', 'quota'))
          : Promise.resolve({
              take: { ...TAKE, status: 'analyzed' as const },
              tab: { takeId: 't1', notes: [], updatedAt: TAKE.updatedAt, deletedStartMs: [] },
            }),
    });
    return h;
  }

  async function failedRun(h: Harness) {
    const analysis = createAnalysis(h.deps);
    const done = analysis.ensureAnalysed(TAKE);
    await settle();
    h.finishAnalyze();
    await expect(done).rejects.toMatchObject({ code: 'storage-full' });
    return analysis;
  }

  it('keeps the result and the raw file; not busy', async () => {
    const h = storageFull();
    const analysis = await failedRun(h);
    expect(analysis.pendingCommit('t1')).toBe(true);
    expect(analysis.pendingCommit('other')).toBe(false);
    expect(analysis.isAnalysing()).toBe(false);
    expect(h.deps.audio.deleteRaw).not.toHaveBeenCalled();
    // Still listening, so a deletion drops it.
    expect(h.hasStorageListener()).toBe(true);
  });

  it('retryCommit: the same tab and patch committed again, then the raw deleted; no engine run', async () => {
    const h = storageFull();
    const analysis = await failedRun(h);
    const [, tab, patch] = vi.mocked(h.deps.db.commitAnalysis).mock.calls[0]!;
    const retry = analysis.retryCommit('t1');
    expect(analysis.isAnalysing()).toBe(true);
    const outcome = await retry;
    expect(outcome.take.status).toBe('analyzed');
    expect(h.deps.engine.analyze).toHaveBeenCalledTimes(1);
    expect(vi.mocked(h.deps.db.commitAnalysis).mock.calls[1]).toEqual(['t1', tab, patch]);
    expect(h.calls.slice(-2)).toEqual(['commitAnalysis', 'deleteRaw']);
    expect(analysis.pendingCommit('t1')).toBe(false);
    expect(analysis.isAnalysing()).toBe(false);
    expect(h.hasStorageListener()).toBe(false);
  });

  it('retryCommit full again: still held, raw kept', async () => {
    const h = storageFull(2);
    const analysis = await failedRun(h);
    await expect(analysis.retryCommit('t1')).rejects.toMatchObject({ code: 'storage-full' });
    expect(analysis.pendingCommit('t1')).toBe(true);
    expect(h.deps.audio.deleteRaw).not.toHaveBeenCalled();
    await expect(analysis.retryCommit('t1')).resolves.toMatchObject({
      take: { status: 'analyzed' },
    });
  });

  it('retryCommit with nothing held: analysis-failed, nothing written', async () => {
    const h = harness();
    await expect(createAnalysis(h.deps).retryCommit('t1')).rejects.toMatchObject({
      code: 'analysis-failed',
    });
    expect(h.deps.db.commitAnalysis).not.toHaveBeenCalled();
  });

  it('a session attaching during the retry gets its result, with no engine run', async () => {
    const h = storageFull();
    const analysis = await failedRun(h);
    const retry = analysis.retryCommit('t1');
    const attached = analysis.ensureAnalysed(TAKE);
    const [a, b] = await Promise.all([retry, attached]);
    expect(a).toBe(b);
    expect(h.deps.engine.analyze).toHaveBeenCalledTimes(1);
  });

  it('dropped when its take is deleted, with no session involved (a Library delete)', async () => {
    const h = storageFull();
    const analysis = await failedRun(h);
    h.emit({ type: 'take-deleted', takeId: 't1', writer: 'library-session' });
    expect(analysis.pendingCommit('t1')).toBe(false);
    expect(h.hasStorageListener()).toBe(false);
    await expect(analysis.retryCommit('t1')).rejects.toMatchObject({ code: 'analysis-failed' });
  });

  it('dropped when a new analysis of the take starts', async () => {
    const h = storageFull();
    const analysis = await failedRun(h);
    const again = analysis.ensureAnalysed(TAKE);
    expect(analysis.pendingCommit('t1')).toBe(false);
    await settle();
    h.finishAnalyze();
    await expect(again).resolves.toMatchObject({ take: { status: 'analyzed' } });
    expect(h.deps.engine.analyze).toHaveBeenCalledTimes(2);
  });

  it('another commit failure keeps nothing', async () => {
    const h = harness({ commit: () => Promise.reject(new AppError('storage-failed', 'disk')) });
    const analysis = createAnalysis(h.deps);
    const done = analysis.ensureAnalysed(TAKE);
    await settle();
    h.finishAnalyze();
    await expect(done).rejects.toMatchObject({ code: 'storage-failed' });
    expect(analysis.pendingCommit('t1')).toBe(false);
    expect(h.hasStorageListener()).toBe(false);
  });
});

// Story 5.7 review: deletions while committing, cancel then analyse in one tick, the saving signal.
describe('review fixes', () => {
  const storageFullError = () => new AppError('storage-full', 'quota');

  it('take deleted while its run commits, and the commit is storage-full: nothing held, listener released', async () => {
    const commit = deferred<{ take: Take; tab: Tab }>();
    const h = harness({ commit: () => commit.promise });
    const analysis = createAnalysis(h.deps);
    const done = analysis.ensureAnalysed(TAKE);
    await settle();
    h.finishAnalyze();
    await settle();
    expect(h.calls).toContain('commitAnalysis');
    h.emit({ type: 'take-deleted', takeId: 't1', writer: 'library-session' });
    commit.reject(storageFullError());
    await expect(done).rejects.toMatchObject({ code: 'storage-full' });
    expect(analysis.pendingCommit('t1')).toBe(false);
    expect(h.hasStorageListener()).toBe(false);
  });

  it('take deleted during retryCommit, and it is storage-full again: nothing held, listener released', async () => {
    let n = 0;
    const retry = deferred<{ take: Take; tab: Tab }>();
    const h = harness({
      commit: () => (n++ === 0 ? Promise.reject(storageFullError()) : retry.promise),
    });
    const analysis = createAnalysis(h.deps);
    const done = analysis.ensureAnalysed(TAKE);
    await settle();
    h.finishAnalyze();
    await expect(done).rejects.toMatchObject({ code: 'storage-full' });
    const retried = analysis.retryCommit('t1');
    await settle();
    h.emit({ type: 'take-deleted', takeId: 't1', writer: 'library-session' });
    retry.reject(storageFullError());
    await expect(retried).rejects.toMatchObject({ code: 'storage-full' });
    expect(analysis.pendingCommit('t1')).toBe(false);
    expect(h.hasStorageListener()).toBe(false);
  });

  it('cancel then ensureAnalysed in the same tick: a new run, not the cancelled one', async () => {
    const h = harness();
    const analysis = createAnalysis(h.deps);
    const first = analysis.ensureAnalysed(TAKE);
    await settle();
    analysis.cancel('t1');
    const second = analysis.ensureAnalysed(TAKE);
    expect(second).not.toBe(first);
    await expect(first).rejects.toMatchObject({ code: 'analysis-cancelled' });
    await settle();
    h.finishAnalyze();
    await expect(second).resolves.toMatchObject({ take: { status: 'analyzed' } });
    expect(h.deps.engine.analyze).toHaveBeenCalledTimes(2);
  });

  it('the saving signal: once the run commits, and at once for a session attaching then', async () => {
    const commit = deferred<{ take: Take; tab: Tab }>();
    const h = harness({ commit: () => commit.promise });
    const analysis = createAnalysis(h.deps);
    const saving = vi.fn();
    const done = analysis.ensureAnalysed(TAKE, () => {}, saving);
    await settle();
    expect(saving).not.toHaveBeenCalled();
    h.finishAnalyze();
    await settle();
    expect(saving).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    void analysis.ensureAnalysed(TAKE, () => {}, late);
    expect(late).toHaveBeenCalledTimes(1);
    const tab: Tab = { takeId: 't1', notes: [], updatedAt: TAKE.updatedAt, deletedStartMs: [] };
    commit.resolve({ take: { ...TAKE, status: 'analyzed' }, tab });
    await done;
  });
});

// Story "Analysis settings and re-analysis" (US-4.6): the re-analysis entry runs the engine and
// commits nothing; take-session merges, maps and commits.
describe('reanalyse', () => {
  const ANALYSED: Take = { ...TAKE, status: 'analyzed', analysisVersion: '0.3.0' };

  it("the take's current settings, trim and skip; progress 0.9·p; the result, version and source; no commit", async () => {
    const h = harness({ take: ANALYSED });
    const analysis = createAnalysis(h.deps);
    const seen: number[] = [];
    const take = { ...ANALYSED, settings: { sensitivity: 0.8, minNoteMs: 30, maxFret: 20 } };
    const done = analysis.reanalyse(take, (p) => seen.push(p));
    await settle();
    expect(analysis.isAnalysing()).toBe(true);
    h.progress(0.5);
    h.progress(0.2); // never backward
    h.finishAnalyze();
    await expect(done).resolves.toEqual({
      result: RESULT,
      analysisVersion: '0.4.0',
      fromRaw: true,
    });
    expect(seen).toEqual([0.45, 0.9]);
    expect(vi.mocked(h.deps.engine.analyze).mock.calls[0]![3]).toStrictEqual({
      sensitivity: 0.8,
      minNoteMs: 30,
      maxFret: 20,
      trimStartMs: 120,
      trimEndMs: 3_800,
      skipStartMs: 100,
    });
    expect(h.calls).toEqual(['readRaw', 'analyze']);
    expect(h.deps.db.commitAnalysis).not.toHaveBeenCalled();
    expect(h.deps.engine.mapFrets).not.toHaveBeenCalled();
    expect(analysis.isAnalysing()).toBe(false);
  });

  it('no raw file: the decoded compressed audio (fromRaw false)', async () => {
    const h = harness({
      take: ANALYSED,
      readRaw: () => Promise.reject(new AppError('audio-missing', 'no raw')),
      readCompressed: async () => new Blob(['x']),
    });
    const done = createAnalysis(h.deps).reanalyse(ANALYSED);
    await settle();
    h.finishAnalyze();
    await expect(done).resolves.toMatchObject({ fromRaw: false });
    expect(h.calls).toEqual(['readRaw', 'readCompressed', 'decode', 'analyze']);
  });

  it('neither raw nor compressed audio: rejects audio-missing, no engine call', async () => {
    const h = harness({
      take: { ...ANALYSED, audioMime: null },
      readRaw: () => Promise.reject(new AppError('audio-missing', 'no raw')),
    });
    await expect(
      createAnalysis(h.deps).reanalyse({ ...ANALYSED, audioMime: null }),
    ).rejects.toMatchObject({ code: 'audio-missing' });
    expect(h.deps.engine.analyze).not.toHaveBeenCalled();
  });

  it('cancel: rejects analysis-cancelled at once and cancels the engine work', async () => {
    const h = harness({ take: ANALYSED });
    const analysis = createAnalysis(h.deps);
    const done = analysis.reanalyse(ANALYSED);
    await settle();
    expect(analysis.cancel('t1')).toBe(true);
    await expect(done).rejects.toMatchObject({ code: 'analysis-cancelled' });
    expect(h.deps.engine.cancel).toHaveBeenCalledWith('t1');
    expect(analysis.isAnalysing()).toBe(false);
    expect(analysis.cancel('t1')).toBe(false);
  });

  it('the take deleted: cancelled', async () => {
    const h = harness({ take: ANALYSED });
    const analysis = createAnalysis(h.deps);
    const done = analysis.reanalyse(ANALYSED);
    await settle();
    h.emit({ type: 'take-deleted', takeId: 't1', writer: 'library-session' });
    await expect(done).rejects.toMatchObject({ code: 'analysis-cancelled' });
    expect(h.hasStorageListener()).toBe(false);
  });

  it('the take deleted with a re-analysis and a queued run both live: both cancelled, listener released', async () => {
    const h = harness();
    const analysis = createAnalysis(h.deps);
    const rerun = analysis.reanalyse(ANALYSED);
    const queued = analysis.ensureAnalysed(TAKE);
    await settle();
    expect(analysis.isAnalysing()).toBe(true);
    h.emit({ type: 'take-deleted', takeId: 't1', writer: 'library-session' });
    await expect(rerun).rejects.toMatchObject({ code: 'analysis-cancelled' });
    await expect(queued).rejects.toMatchObject({ code: 'analysis-cancelled' });
    expect(analysis.isAnalysing()).toBe(false);
    expect(analysis.pendingCommit('t1')).toBe(false);
    expect(h.hasStorageListener()).toBe(false);
    expect(h.deps.db.commitAnalysis).not.toHaveBeenCalled();
  });

  it('the take deleted with a re-analysis live and a storage-full result held: both dropped', async () => {
    let n = 0;
    const h = harness({
      commit: () =>
        n++ === 0
          ? Promise.reject(new AppError('storage-full', 'quota'))
          : Promise.reject(new AppError('storage-failed', 'unexpected second commit')),
    });
    const analysis = createAnalysis(h.deps);
    const first = analysis.ensureAnalysed(TAKE);
    await settle();
    h.finishAnalyze();
    await expect(first).rejects.toMatchObject({ code: 'storage-full' });
    expect(analysis.pendingCommit('t1')).toBe(true);
    const rerun = analysis.reanalyse(ANALYSED);
    await settle();
    h.emit({ type: 'take-deleted', takeId: 't1', writer: 'library-session' });
    await expect(rerun).rejects.toMatchObject({ code: 'analysis-cancelled' });
    expect(analysis.pendingCommit('t1')).toBe(false);
    expect(analysis.isAnalysing()).toBe(false);
    expect(h.hasStorageListener()).toBe(false);
  });

  it('an engine failure rejects with its code', async () => {
    const h = harness({ take: ANALYSED });
    const done = createAnalysis(h.deps).reanalyse(ANALYSED);
    await settle();
    h.failAnalyze(new AppError('analysis-failed', 'boom'));
    await expect(done).rejects.toMatchObject({ code: 'analysis-failed' });
  });

  it('a second re-analysis of the same take while one runs: rejected', async () => {
    const h = harness({ take: ANALYSED });
    const analysis = createAnalysis(h.deps);
    const first = analysis.reanalyse(ANALYSED);
    await expect(analysis.reanalyse(ANALYSED)).rejects.toMatchObject({ code: 'analysis-failed' });
    await settle();
    h.finishAnalyze();
    await expect(first).resolves.toMatchObject({ fromRaw: true });
  });
});
