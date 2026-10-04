import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/model/errors';
import type { Tab, Take } from '../../src/model/types';
import type { AnalysisOutcome, ProgressListener } from '../../src/session/analysis';
import { createTakeSession, type TakeSessionDeps } from '../../src/session/take-session';
import type { StorageEvent, StorageListener } from '../../src/storage/events';

// Story 5.6 (spine AD-3, AD-5, AD-16): the take session against mocked storage and analysis.

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
  trimStartMs: 0,
  trimEndMs: null,
  settings: { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 },
  analysisVersion: null,
  updatedAt: '2026-10-04T10:00:04.000Z',
};
const ANALYZED: Take = { ...TAKE, status: 'analyzed', analysisVersion: '0.4.0' };
const TAB: Tab = { takeId: 't1', notes: [], updatedAt: TAKE.updatedAt, deletedStartMs: [] };

const settle = () => new Promise((r) => setTimeout(r, 0));

function harness(take: Take | null, tab: Tab | null = null) {
  let storageListener: StorageListener | null = null;
  const listeners = new Set<ProgressListener>();
  const savers = new Set<() => void>();
  // One run per ensureAnalysed or retryCommit call; finish and fail settle the latest.
  const runs: { resolve: (o: AnalysisOutcome) => void; reject: (e: unknown) => void }[] = [];
  const newRun = () =>
    new Promise<AnalysisOutcome>((resolve, reject) => {
      runs.push({ resolve, reject });
    });
  const finish = (outcome: AnalysisOutcome) => runs.at(-1)!.resolve(outcome);
  const fail = (err: unknown) => runs.at(-1)!.reject(err);
  const deps: TakeSessionDeps = {
    db: {
      getTake: vi.fn(async () => take),
      getTab: vi.fn(async () => tab),
    },
    analysis: {
      ensureAnalysed: vi.fn((_take, onProgress, onSaving) => {
        if (onProgress) listeners.add(onProgress);
        if (onSaving) savers.add(onSaving);
        return newRun();
      }),
      detach: vi.fn((_id, onProgress) => {
        listeners.delete(onProgress);
      }),
      cancel: vi.fn(() => {
        runs.at(-1)?.reject(new AppError('analysis-cancelled', 'cancelled'));
        return true;
      }),
      retryCommit: vi.fn(() => newRun()),
      pendingCommit: vi.fn(() => false),
    },
    cancel: vi.fn(),
    subscribeStorage: vi.fn((listener) => {
      storageListener = listener;
      return () => {
        storageListener = null;
      };
    }),
  };
  return {
    deps,
    progress: (p: number) => listeners.forEach((l) => l(p)),
    saving: () => savers.forEach((l) => l()),
    finish,
    fail,
    emit: (event: StorageEvent) => storageListener?.(event),
    hasStorageListener: () => storageListener !== null,
  };
}

describe('take session', () => {
  it('already analysed: no analysis; take and tab from storage', async () => {
    const h = harness(ANALYZED, TAB);
    const session = createTakeSession('t1', h.deps);
    expect(session.getSnapshot().loading).toBe(true);
    session.subscribe(() => {});
    await settle();
    expect(session.getSnapshot()).toEqual({
      take: ANALYZED,
      tab: TAB,
      loading: false,
      analysis: { kind: 'idle' },
    });
    expect(h.deps.analysis.ensureAnalysed).not.toHaveBeenCalled();
  });

  it('a recorded take: running with progress, then the committed take and tab', async () => {
    const h = harness(TAKE);
    const session = createTakeSession('t1', h.deps);
    const seen: unknown[] = [];
    session.subscribe(() => seen.push(session.getSnapshot().analysis));
    await settle();
    expect(session.getSnapshot().analysis).toEqual({ kind: 'running', progress: 0 });
    h.progress(0.45);
    expect(session.getSnapshot().analysis).toEqual({ kind: 'running', progress: 0.45 });
    h.finish({ take: ANALYZED, tab: TAB });
    await settle();
    expect(session.getSnapshot()).toMatchObject({
      take: ANALYZED,
      tab: TAB,
      analysis: { kind: 'idle' },
    });
    expect(h.deps.analysis.ensureAnalysed).toHaveBeenCalledTimes(1);
  });

  it('in flight on reopen: dispose detaches without cancelling; a new session attaches', async () => {
    const h = harness(TAKE);
    const first = createTakeSession('t1', h.deps);
    first.subscribe(() => {});
    await settle();
    first.dispose();
    expect(h.deps.analysis.detach).toHaveBeenCalledTimes(1);
    expect(h.deps.cancel).not.toHaveBeenCalled();
    expect(h.hasStorageListener()).toBe(false);

    const second = createTakeSession('t1', h.deps);
    second.subscribe(() => {});
    await settle();
    h.progress(0.6);
    expect(second.getSnapshot().analysis).toEqual({ kind: 'running', progress: 0.6 });
    h.finish({ take: ANALYZED, tab: TAB });
    await settle();
    expect(second.getSnapshot().tab).toBe(TAB);
    await expect(second.flush()).resolves.toBeUndefined();
  });

  it('a subscribe after dispose attaches again (StrictMode remount)', async () => {
    const h = harness(TAKE);
    const session = createTakeSession('t1', h.deps);
    session.subscribe(() => {});
    session.dispose();
    session.subscribe(() => {});
    await settle();
    expect(h.hasStorageListener()).toBe(true);
    h.progress(0.3);
    expect(session.getSnapshot().analysis).toEqual({ kind: 'running', progress: 0.3 });
    expect(h.deps.db.getTake).toHaveBeenCalledTimes(1);
  });

  it('failed: the error code', async () => {
    const h = harness(TAKE);
    const session = createTakeSession('t1', h.deps);
    session.subscribe(() => {});
    await settle();
    h.fail(new AppError('audio-missing', 'no raw'));
    await settle();
    expect(session.getSnapshot().analysis).toEqual({ kind: 'failed', code: 'audio-missing' });
  });

  it('take deleted mid-run: cancels the engine work and is missing', async () => {
    const h = harness(TAKE);
    const session = createTakeSession('t1', h.deps);
    session.subscribe(() => {});
    await settle();
    h.emit({ type: 'take-deleted', takeId: 'other', writer: 'library-session' });
    expect(h.deps.cancel).not.toHaveBeenCalled();
    h.emit({ type: 'take-deleted', takeId: 't1', writer: 'library-session' });
    expect(h.deps.cancel).toHaveBeenCalledWith('t1');
    expect(session.getSnapshot()).toMatchObject({ take: null, tab: null, missing: true });
    h.fail(new AppError('analysis-cancelled', 'cancelled'));
    await settle();
    expect(session.getSnapshot()).toMatchObject({ missing: true, analysis: { kind: 'idle' } });
  });

  it('take deleted, then the run resolves: the snapshot stays missing', async () => {
    const h = harness(TAKE);
    const session = createTakeSession('t1', h.deps);
    session.subscribe(() => {});
    await settle();
    h.emit({ type: 'take-deleted', takeId: 't1', writer: 'library-session' });
    h.finish({ take: ANALYZED, tab: TAB });
    await settle();
    expect(session.getSnapshot()).toEqual({
      take: null,
      tab: null,
      loading: false,
      analysis: { kind: 'idle' },
      missing: true,
    });
  });

  it('a take that does not exist is missing', async () => {
    const h = harness(null);
    const session = createTakeSession('nope', h.deps);
    session.subscribe(() => {});
    await settle();
    expect(session.getSnapshot()).toMatchObject({ loading: false, missing: true, take: null });
  });

  it('take-put: ignores its own; from others re-reads only title and audioMime', async () => {
    const h = harness(ANALYZED, TAB);
    const session = createTakeSession('t1', h.deps);
    session.subscribe(() => {});
    await settle();
    vi.mocked(h.deps.db.getTake).mockResolvedValue({
      ...ANALYZED,
      title: 'Renamed',
      audioMime: null,
      trimStartMs: 999,
    });
    h.emit({ type: 'take-put', takeId: 't1', writer: 'take-session' });
    await settle();
    expect(session.getSnapshot().take?.title).toBe('Take 1');
    h.emit({ type: 'take-put', takeId: 't1', writer: 'library-session' });
    await settle();
    expect(session.getSnapshot().take).toEqual({
      ...ANALYZED,
      title: 'Renamed',
      audioMime: null,
    });
  });
});

// Story 5.7 (US-4.5): Cancel, Analyse, Retry and the storage-full retry.
describe('take session actions', () => {
  afterEach(() => vi.restoreAllMocks());

  async function running(h: ReturnType<typeof harness>) {
    const session = createTakeSession('t1', h.deps);
    session.subscribe(() => {});
    await settle();
    expect(session.getSnapshot().analysis).toEqual({ kind: 'running', progress: 0 });
    return session;
  }

  it('cancel: cancelled at once, the run cancelled and detached; it does not restart by itself', async () => {
    const h = harness(TAKE);
    const session = await running(h);
    h.progress(0.3);
    session.cancel();
    expect(session.getSnapshot().analysis).toEqual({ kind: 'cancelled' });
    expect(h.deps.analysis.cancel).toHaveBeenCalledWith('t1');
    expect(h.deps.analysis.detach).toHaveBeenCalledTimes(1);
    h.progress(0.6); // a late progress report changes nothing
    await settle();
    expect(session.getSnapshot().analysis).toEqual({ kind: 'cancelled' });
    expect(session.getSnapshot().take?.status).toBe('recorded');
    // A StrictMode remount of the same session does not restart it.
    session.dispose();
    session.subscribe(() => {});
    await settle();
    expect(session.getSnapshot().analysis).toEqual({ kind: 'cancelled' });
    expect(h.deps.analysis.ensureAnalysed).toHaveBeenCalledTimes(1);
  });

  it('analyse after a cancel: running again, then the committed tab', async () => {
    const h = harness(TAKE);
    const session = await running(h);
    session.cancel();
    await settle();
    session.analyse();
    expect(session.getSnapshot().analysis).toEqual({ kind: 'running', progress: 0 });
    expect(h.deps.analysis.ensureAnalysed).toHaveBeenCalledTimes(2);
    h.progress(0.5);
    expect(session.getSnapshot().analysis).toEqual({ kind: 'running', progress: 0.5 });
    h.finish({ take: ANALYZED, tab: TAB });
    await settle();
    expect(session.getSnapshot()).toMatchObject({
      take: ANALYZED,
      tab: TAB,
      analysis: { kind: 'idle' },
    });
  });

  it('a new session for a cancelled take analyses it again', async () => {
    const h = harness(TAKE);
    const first = await running(h);
    first.cancel();
    first.dispose();
    await running(h);
    expect(h.deps.analysis.ensureAnalysed).toHaveBeenCalledTimes(2);
  });

  it('cancel refused (the result is being committed): stays running, then the tab', async () => {
    const h = harness(TAKE);
    vi.mocked(h.deps.analysis.cancel).mockReturnValue(false);
    const session = await running(h);
    session.cancel();
    expect(session.getSnapshot().analysis.kind).toBe('running');
    h.finish({ take: ANALYZED, tab: TAB });
    await settle();
    expect(session.getSnapshot()).toMatchObject({ tab: TAB, analysis: { kind: 'idle' } });
  });

  it('a run cancelled elsewhere shows cancelled', async () => {
    const h = harness(TAKE);
    const session = await running(h);
    h.fail(new AppError('analysis-cancelled', 'instance lost'));
    await settle();
    expect(session.getSnapshot().analysis).toEqual({ kind: 'cancelled' });
  });

  it('failed: the detail goes to devWarn; Retry analyses again and succeeds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness(TAKE);
    const session = await running(h);
    const err = new AppError('analysis-failed', 'boom');
    h.fail(err);
    await settle();
    expect(session.getSnapshot().analysis).toEqual({ kind: 'failed', code: 'analysis-failed' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('t1'), err);
    session.analyse();
    expect(session.getSnapshot().analysis).toEqual({ kind: 'running', progress: 0 });
    h.finish({ take: ANALYZED, tab: TAB });
    await settle();
    expect(session.getSnapshot()).toMatchObject({ tab: TAB, analysis: { kind: 'idle' } });
  });

  it('the take could not be read: Retry reads it again and analyses it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness(TAKE);
    vi.mocked(h.deps.db.getTake).mockRejectedValueOnce(new AppError('storage-failed', 'read'));
    const session = createTakeSession('t1', h.deps);
    session.subscribe(() => {});
    await settle();
    expect(session.getSnapshot()).toMatchObject({
      loading: false,
      analysis: { kind: 'failed', code: 'storage-failed' },
    });
    session.analyse();
    expect(session.getSnapshot().loading).toBe(true);
    await settle();
    expect(session.getSnapshot()).toMatchObject({
      take: TAKE,
      analysis: { kind: 'running', progress: 0 },
    });
  });

  it('storage full: failed with the code; Retry commits the held result, with no new analysis', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness(TAKE);
    const session = await running(h);
    h.fail(new AppError('storage-full', 'quota'));
    await settle();
    expect(session.getSnapshot().analysis).toEqual({ kind: 'failed', code: 'storage-full' });
    vi.mocked(h.deps.analysis.pendingCommit).mockReturnValue(true);
    session.retryCommit();
    expect(h.deps.analysis.retryCommit).toHaveBeenCalledWith('t1');
    expect(h.deps.analysis.ensureAnalysed).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().analysis).toEqual({ kind: 'running', progress: 1, saving: true });
    session.cancel(); // nothing to cancel while saving
    expect(h.deps.analysis.cancel).not.toHaveBeenCalled();
    h.finish({ take: ANALYZED, tab: TAB });
    await settle();
    expect(session.getSnapshot()).toMatchObject({ take: ANALYZED, analysis: { kind: 'idle' } });
  });

  it('storage full, Retry with nothing held (a reload lost it): analyses again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness(TAKE);
    const session = await running(h);
    h.fail(new AppError('storage-full', 'quota'));
    await settle();
    session.retryCommit();
    expect(h.deps.analysis.retryCommit).not.toHaveBeenCalled();
    expect(h.deps.analysis.ensureAnalysed).toHaveBeenCalledTimes(2);
  });

  it('reopened while a result is held: the storage-full state, no analysis', async () => {
    const h = harness(TAKE);
    vi.mocked(h.deps.analysis.pendingCommit).mockReturnValue(true);
    const session = createTakeSession('t1', h.deps);
    session.subscribe(() => {});
    await settle();
    expect(session.getSnapshot().analysis).toEqual({ kind: 'failed', code: 'storage-full' });
    expect(h.deps.analysis.ensureAnalysed).not.toHaveBeenCalled();
  });
});

describe('take session saving and Retry fallbacks (story 5.7 review)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a run that starts committing is saving; Cancel then does nothing', async () => {
    const h = harness(TAKE);
    const session = createTakeSession('t1', h.deps);
    session.subscribe(() => {});
    await settle();
    h.progress(1);
    h.saving();
    expect(session.getSnapshot().analysis).toEqual({ kind: 'running', progress: 1, saving: true });
    session.cancel();
    expect(h.deps.analysis.cancel).not.toHaveBeenCalled();
    h.finish({ take: ANALYZED, tab: TAB });
    await settle();
    expect(session.getSnapshot()).toMatchObject({ tab: TAB, analysis: { kind: 'idle' } });
  });

  it('analyse when the take shown is not recorded: re-reads it, and analyses it if now recorded', async () => {
    const h = harness({ ...TAKE, status: 'recording' });
    const session = createTakeSession('t1', h.deps);
    session.subscribe(() => {});
    await settle();
    expect(session.getSnapshot().analysis).toEqual({ kind: 'idle' });
    expect(h.deps.analysis.ensureAnalysed).not.toHaveBeenCalled();
    vi.mocked(h.deps.db.getTake).mockResolvedValue(TAKE);
    session.analyse();
    expect(session.getSnapshot().loading).toBe(true);
    await settle();
    expect(session.getSnapshot()).toMatchObject({
      take: TAKE,
      loading: false,
      analysis: { kind: 'running', progress: 0 },
    });
    expect(h.deps.analysis.ensureAnalysed).toHaveBeenCalledTimes(1);
  });

  it('analyse when the stored take is analysed: shows its tab, no analysis', async () => {
    const h = harness({ ...TAKE, status: 'recording' });
    const session = createTakeSession('t1', h.deps);
    session.subscribe(() => {});
    await settle();
    vi.mocked(h.deps.db.getTake).mockResolvedValue(ANALYZED);
    vi.mocked(h.deps.db.getTab).mockResolvedValue(TAB);
    session.analyse();
    await settle();
    expect(session.getSnapshot()).toMatchObject({
      take: ANALYZED,
      tab: TAB,
      analysis: { kind: 'idle' },
    });
    expect(h.deps.analysis.ensureAnalysed).not.toHaveBeenCalled();
  });

  it('storage-full Retry when the take could not be read: re-reads and analyses it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness(TAKE);
    vi.mocked(h.deps.db.getTake).mockRejectedValueOnce(new AppError('storage-full', 'quota'));
    const session = createTakeSession('t1', h.deps);
    session.subscribe(() => {});
    await settle();
    expect(session.getSnapshot().analysis).toEqual({ kind: 'failed', code: 'storage-full' });
    session.retryCommit();
    await settle();
    expect(h.deps.analysis.retryCommit).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toMatchObject({
      take: TAKE,
      analysis: { kind: 'running', progress: 0 },
    });
  });
});
