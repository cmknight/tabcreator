import { describe, expect, it, vi } from 'vitest';
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
  let finish!: (outcome: AnalysisOutcome) => void;
  let fail!: (err: unknown) => void;
  const run = new Promise<AnalysisOutcome>((res, rej) => {
    finish = res;
    fail = rej;
  });
  const deps: TakeSessionDeps = {
    db: {
      getTake: vi.fn(async () => take),
      getTab: vi.fn(async () => tab),
    },
    analysis: {
      ensureAnalysed: vi.fn((_take, onProgress) => {
        if (onProgress) listeners.add(onProgress);
        return run;
      }),
      detach: vi.fn((_id, onProgress) => {
        listeners.delete(onProgress);
      }),
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
