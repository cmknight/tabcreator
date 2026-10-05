import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/model/errors';
import type { Note, Tab, Take } from '../../src/model/types';
import type { AnalysisOutcome, ProgressListener, ReanalysisRun } from '../../src/session/analysis';
import {
  activeTakeSession,
  capTitle,
  createTakeSession,
  hasAudio,
  hasUnsavedEdits,
  isTabShown,
  onPageHide,
  type EditEvent,
  setActiveTakeSession,
  type TakeSessionDeps,
} from '../../src/session/take-session';
import type { StorageEvent, StorageListener } from '../../src/storage/events';
import { deferred } from './helpers';

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
      patchTake: vi.fn(async (_id: string, patch: Partial<Take>) => ({ ...take!, ...patch })),
      commitAnalysis: vi.fn(async (_id: string, t: Tab, patch: Partial<Take>) => ({
        take: { ...take!, ...patch },
        tab: t,
      })),
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
      reanalyse: vi.fn(() => new Promise<never>(() => {})),
    },
    hasRaw: vi.fn(async () => false),
    deleteRaw: vi.fn(async () => {}),
    cancel: vi.fn(),
    subscribeStorage: vi.fn((listener) => {
      storageListener = listener;
      return () => {
        storageListener = null;
      };
    }),
    putTab: vi.fn(async (t: Tab) => t),
    mapFrets: vi.fn(async () => []),
    onPageHide: vi.fn(() => () => {}),
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
      selectedNoteId: null,
      lastFocusedNoteId: null,
      saveFailed: null,
      undoLabel: null,
      redoLabel: null,
      reanalysis: null,
      hasRaw: false,
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
      selectedNoteId: null,
      lastFocusedNoteId: null,
      saveFailed: null,
      undoLabel: null,
      redoLabel: null,
      reanalysis: null,
      hasRaw: false,
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

// Story "Tab screen, reflow and selection" (US-6.3): the selection, rename and the active session.
describe('take session selection', () => {
  const note = (id: string, startMs: number): Note => ({
    id,
    startMs,
    endMs: startMs + 100,
    midi: 60,
    confidence: 0.9,
    string: 2,
    fret: 1,
    locked: false,
    lowConfidence: false,
  });
  // Stored out of played order: played order is a, b, c.
  const NOTES = [note('c', 900), note('a', 100), note('b', 500)];
  const TAB3: Tab = { ...TAB, notes: NOTES };

  async function open() {
    const h = harness(ANALYZED, TAB3);
    const session = createTakeSession('t1', h.deps);
    session.subscribe(() => {});
    await settle();
    return { h, session };
  }

  it('starts with nothing selected; select picks a note by id; an unknown id clears', async () => {
    const { session } = await open();
    expect(session.getSnapshot().selectedNoteId).toBeNull();
    session.select('b');
    expect(session.getSnapshot().selectedNoteId).toBe('b');
    session.select('nope');
    expect(session.getSnapshot().selectedNoteId).toBeNull();
  });

  it('next and previous follow played order and stop at the ends', async () => {
    const { session } = await open();
    const ids: (string | null)[] = [];
    const step = (fn: () => void) => {
      fn();
      ids.push(session.getSnapshot().selectedNoteId);
    };
    step(session.selectNext); // none selected: the first
    step(session.selectNext);
    step(session.selectNext);
    step(session.selectNext); // stops at the last
    step(session.selectPrev);
    step(session.selectPrev);
    step(session.selectPrev); // stops at the first
    expect(ids).toEqual(['a', 'b', 'c', 'c', 'b', 'a', 'a']);
    session.select(null);
    session.selectPrev(); // none selected: the last
    expect(session.getSnapshot().selectedNoteId).toBe('c');
  });

  it('with nothing selected, next and previous step from the focused note', async () => {
    const { session } = await open();
    session.selectNext('b'); // Esc cleared b while it kept focus: → goes to c
    expect(session.getSnapshot().selectedNoteId).toBe('c');
    session.select(null);
    session.selectPrev('b');
    expect(session.getSnapshot().selectedNoteId).toBe('a');
    session.select('a');
    session.selectNext('c'); // a selection wins over the focused note
    expect(session.getSnapshot().selectedNoteId).toBe('b');
    session.select(null);
    session.selectNext('gone'); // an unknown note: from the start
    expect(session.getSnapshot().selectedNoteId).toBe('a');
  });

  it('focusNote records the last focused note; the arrows start from it with nothing selected', async () => {
    const { session } = await open();
    session.focusNote('nope'); // unknown: ignored
    expect(session.getSnapshot().lastFocusedNoteId).toBeNull();
    session.focusNote('b');
    expect(session.getSnapshot().lastFocusedNoteId).toBe('b');
    session.selectNext();
    expect(session.getSnapshot().selectedNoteId).toBe('c');
    session.select(null);
    session.selectPrev();
    expect(session.getSnapshot().selectedNoteId).toBe('a');
  });

  it('the last focused note is cleared when its note is gone', async () => {
    const { h, session } = await open();
    session.focusNote('b');
    vi.mocked(h.deps.db.getTab).mockResolvedValue({ ...TAB3, notes: [NOTES[0]!, NOTES[1]!] });
    session.analyse(); // not recorded: re-reads the tab, which lost b
    await settle();
    expect(session.getSnapshot().lastFocusedNoteId).toBeNull();
  });

  it('an unchanged selection publishes nothing', async () => {
    const { session } = await open();
    session.select('a');
    const listener = vi.fn();
    session.subscribe(listener);
    session.select('a');
    session.selectPrev();
    expect(listener).not.toHaveBeenCalled();
  });

  it('with no notes the selection actions do nothing', async () => {
    const h = harness(ANALYZED, TAB);
    const session = createTakeSession('t1', h.deps);
    session.subscribe(() => {});
    await settle();
    session.selectNext();
    session.selectPrev();
    expect(session.getSnapshot().selectedNoteId).toBeNull();
  });

  it('the selection is cleared when its note is gone (a re-analysis), kept otherwise', async () => {
    const h = harness(TAKE);
    const session = createTakeSession('t1', h.deps);
    session.subscribe(() => {});
    await settle();
    h.finish({ take: ANALYZED, tab: TAB3 });
    await settle();
    session.select('b');
    h.progress(0.5); // a publish that keeps the tab keeps the selection
    expect(session.getSnapshot().selectedNoteId).toBe('b');
    // Not recorded: analyse re-reads; the stored tab still has note b, then has lost it.
    vi.mocked(h.deps.db.getTake).mockResolvedValue(ANALYZED);
    vi.mocked(h.deps.db.getTab).mockResolvedValue(TAB3);
    session.analyse();
    await settle();
    expect(session.getSnapshot()).toMatchObject({ tab: TAB3, selectedNoteId: 'b' });
    vi.mocked(h.deps.db.getTab).mockResolvedValue({ ...TAB3, notes: [NOTES[0]!, NOTES[1]!] });
    session.analyse();
    await settle();
    expect(session.getSnapshot().tab?.notes).toHaveLength(2);
    expect(session.getSnapshot().selectedNoteId).toBeNull();
  });

  it('a deleted take clears the selection', async () => {
    const { h, session } = await open();
    session.select('a');
    h.emit({ type: 'take-deleted', takeId: 't1', writer: 'library-session' });
    expect(session.getSnapshot().selectedNoteId).toBeNull();
  });
});

describe('take session next to check', () => {
  const note = (id: string, startMs: number, lowConfidence: boolean): Note => ({
    id,
    startMs,
    endMs: startMs + 100,
    midi: 60,
    confidence: lowConfidence ? 0.2 : 0.9,
    string: 2,
    fret: 1,
    locked: false,
    lowConfidence,
  });

  async function open(notes: Note[]) {
    const h = harness(ANALYZED, { ...TAB, notes });
    const session = createTakeSession('t1', h.deps);
    session.subscribe(() => {});
    await settle();
    return session;
  }

  // Stored out of played order; played order a … e, flagged b, d, e.
  const NOTES = [
    note('e', 900, true),
    note('a', 100, false),
    note('d', 700, true),
    note('b', 300, true),
    note('c', 500, false),
  ];

  it('steps through the flagged notes in played order and wraps to the first', async () => {
    const session = await open(NOTES);
    const ids: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      session.selectNextFlagged();
      ids.push(session.getSnapshot().selectedNoteId);
    }
    expect(ids).toEqual(['b', 'd', 'e', 'b']);
  });

  it('starts after the selection, else after the focused note, else from the start', async () => {
    const session = await open(NOTES);
    session.select('c');
    session.selectNextFlagged('e'); // the selection wins over the focused note
    expect(session.getSnapshot().selectedNoteId).toBe('d');
    session.select(null);
    session.selectNextFlagged('d'); // nothing selected: after the focused note
    expect(session.getSnapshot().selectedNoteId).toBe('e');
    session.select(null);
    session.selectNextFlagged('gone'); // an unknown note: from the start
    expect(session.getSnapshot().selectedNoteId).toBe('b');
  });

  it('with nothing given, starts after the last focused note (after Esc, focus moved to Play)', async () => {
    const session = await open(NOTES);
    session.focusNote('c'); // a note button took focus, selecting it
    session.select('c');
    session.select(null); // Esc; focus then moves to Play, which records nothing
    session.selectNextFlagged(); // N and the Next to check button both call it so
    expect(session.getSnapshot().selectedNoteId).toBe('d');
  });

  it('a lone flagged note stays selected; none flagged does nothing', async () => {
    const lone = await open([note('a', 100, false), note('b', 300, true)]);
    lone.selectNextFlagged();
    lone.selectNextFlagged();
    expect(lone.getSnapshot().selectedNoteId).toBe('b');
    const none = await open([note('a', 100, false), note('b', 300, false)]);
    none.select('a');
    none.selectNextFlagged();
    expect(none.getSnapshot().selectedNoteId).toBe('a');
  });
});

describe('take session rename', () => {
  afterEach(() => vi.restoreAllMocks());

  async function open() {
    const h = harness(ANALYZED, TAB);
    const session = createTakeSession('t1', h.deps);
    session.subscribe(() => {});
    await settle();
    return { h, session };
  }

  it('trims, writes the title as take-session, and shows it at once', async () => {
    const { h, session } = await open();
    const done = session.rename('  Riff in A  ');
    expect(session.getSnapshot().take?.title).toBe('Riff in A');
    await done;
    expect(h.deps.db.patchTake).toHaveBeenCalledWith('t1', { title: 'Riff in A' }, 'take-session');
    // Its own take-put is skipped; the title stays.
    h.emit({ type: 'take-put', takeId: 't1', writer: 'take-session' });
    await settle();
    expect(session.getSnapshot().take?.title).toBe('Riff in A');
  });

  it.each(['', '   ', 'Take 1', '  Take 1 '])('%j writes nothing', async (title) => {
    const { h, session } = await open();
    await session.rename(title);
    expect(h.deps.db.patchTake).not.toHaveBeenCalled();
    expect(session.getSnapshot().take?.title).toBe('Take 1');
  });

  it('keeps at most 100 characters', async () => {
    const { h, session } = await open();
    await session.rename('x'.repeat(150));
    expect(h.deps.db.patchTake).toHaveBeenCalledWith(
      't1',
      { title: 'x'.repeat(100) },
      'take-session',
    );
  });

  it('cuts at 100 code points, never inside an emoji', async () => {
    const { h, session } = await open();
    await session.rename('x'.repeat(99) + '🎸🎸');
    const title = 'x'.repeat(99) + '🎸';
    expect(h.deps.db.patchTake).toHaveBeenCalledWith('t1', { title }, 'take-session');
    expect(capTitle('a'.repeat(99) + '🎸b')).toBe('a'.repeat(99) + '🎸');
    expect(capTitle('🎸')).toBe('🎸');
  });

  it('a take read while the rename is being written keeps the new title', async () => {
    const h = harness(TAKE);
    const session = createTakeSession('t1', h.deps);
    session.subscribe(() => {});
    await settle();
    let write!: () => void;
    vi.mocked(h.deps.db.patchTake).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          write = () => resolve({ ...ANALYZED, title: 'New' });
        }),
    );
    const done = session.rename('New');
    // The analysis commits a take read before the patch.
    h.finish({ take: ANALYZED, tab: TAB });
    await settle();
    expect(session.getSnapshot().take).toMatchObject({ status: 'analyzed', title: 'New' });
    write();
    await done;
    expect(session.getSnapshot().take?.title).toBe('New');
  });

  it('two renames that both fail revert to the stored title', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { h, session } = await open();
    const rejects: (() => void)[] = [];
    vi.mocked(h.deps.db.patchTake).mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejects.push(() => reject(new AppError('storage-failed', 'write')));
        }),
    );
    const first = session.rename('One');
    const second = session.rename('Two');
    expect(session.getSnapshot().take?.title).toBe('Two');
    rejects[0]!();
    await first;
    expect(session.getSnapshot().take?.title).toBe('Two');
    rejects[1]!();
    await second;
    expect(session.getSnapshot().take?.title).toBe('Take 1');
  });

  it('a first rename saved, a second failed: reverts to the first', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { h, session } = await open();
    await session.rename('One');
    vi.mocked(h.deps.db.patchTake).mockRejectedValueOnce(new AppError('storage-failed', 'write'));
    await session.rename('Two');
    expect(session.getSnapshot().take?.title).toBe('One');
  });

  it('a failed write puts the old title back', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { h, session } = await open();
    vi.mocked(h.deps.db.patchTake).mockRejectedValueOnce(new AppError('storage-failed', 'write'));
    await session.rename('New');
    expect(session.getSnapshot().take?.title).toBe('Take 1');
  });
});

describe('the active take session', () => {
  it('is set and cleared', () => {
    const h = harness(ANALYZED, TAB);
    const session = createTakeSession('t1', h.deps);
    expect(activeTakeSession()).toBeNull();
    setActiveTakeSession(session);
    expect(activeTakeSession()).toBe(session);
    setActiveTakeSession(null);
    expect(activeTakeSession()).toBeNull();
  });
});

// Refactor sweep: the one "tab shown" condition, shared by the Tab screen and its shortcuts.
describe('isTabShown', () => {
  const tab = (notes: number) =>
    ({
      takeId: 't1',
      notes: Array.from({ length: notes }, (_, i) => ({ id: `n${i}` })),
    }) as unknown as Tab;
  const idle = { kind: 'idle' } as const;
  it.each([
    ['no snapshot', null, false],
    ['the take is missing', { missing: true as const, analysis: idle, tab: tab(3) }, false],
    ['no tab yet', { analysis: idle, tab: null }, false],
    [
      'an analysis running',
      { analysis: { kind: 'running', progress: 0.5 } as const, tab: tab(3) },
      false,
    ],
    [
      'an analysis failed',
      { analysis: { kind: 'failed', code: 'analysis-failed' } as const, tab: tab(3) },
      false,
    ],
    ['an analysis cancelled', { analysis: { kind: 'cancelled' } as const, tab: tab(3) }, false],
    ['a tab with no notes', { analysis: idle, tab: tab(0) }, false],
    ['an analysed tab with notes', { analysis: idle, tab: tab(3) }, true],
  ])('%s', (_name, snapshot, shown) => {
    expect(isTabShown(snapshot as Parameters<typeof isTabShown>[0])).toBe(shown);
  });
});

// Story "Change a fret and undo it" (spine AD-4, AD-16): edits, undo/redo, the debounced save.
describe('take session edits', () => {
  const OPEN: Record<number, number> = { 1: 64, 2: 59, 3: 55, 4: 50, 5: 45, 6: 40 };
  const note = (id: string, startMs: number, string: Note['string'], fret: number): Note => ({
    id,
    startMs,
    endMs: startMs + 200,
    midi: OPEN[string]! + fret,
    confidence: 0.9,
    string,
    fret,
    locked: false,
    lowConfidence: false,
  });
  // Phrase 1: a, b, c; phrase 2 (a 1200 ms gap): d, e. b is on string 2 at fret 1, flagged.
  const NOTES: Note[] = [
    note('a', 0, 1, 0),
    { ...note('b', 300, 2, 1), lowConfidence: true, confidence: 0.2 },
    note('c', 600, 3, 2),
    note('d', 2000, 1, 3),
    note('e', 2300, 2, 3),
  ];
  const TAB5: Tab = { ...TAB, notes: NOTES, deletedStartMs: [1500] };

  /** Thickest string that plays each unlocked note; locks kept. */
  function fakeMap(request: Parameters<TakeSessionDeps['mapFrets']>[1]) {
    return request.notes.map((n, i) => {
      const lock = request.locks.find((l) => l.index === i);
      if (lock) return { string: lock.string, fret: lock.fret };
      for (const s of [6, 5, 4, 3, 2, 1] as const) {
        const fret = n.midi - OPEN[s]!;
        if (fret >= 0 && fret <= request.maxFret) return { string: s, fret };
      }
      return null;
    });
  }

  let clock = 0;
  const tick = async (ms: number) => {
    clock += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };

  async function open(tab: Tab = TAB5, take: Take = ANALYZED) {
    vi.useFakeTimers();
    clock = 1_000_000;
    const h = harness(take, tab);
    vi.mocked(h.deps.mapFrets).mockImplementation(async (_id, r) => fakeMap(r));
    let pageHide: (() => void) | null = null;
    vi.mocked(h.deps.onPageHide).mockImplementation((l) => {
      pageHide = l;
      return () => {
        pageHide = null;
      };
    });
    h.deps.now = () => clock;
    let ids = 0;
    h.deps.newId = () => `new${++ids}`;
    const session = createTakeSession('t1', h.deps);
    opened.push(session);
    const events: EditEvent[] = [];
    session.onEditEvent((e) => events.push(e));
    session.subscribe(() => {});
    await tick(0);
    return { h, session, events, pageHide: () => pageHide?.() };
  }

  const noteOf = (session: ReturnType<typeof createTakeSession>, id: string) =>
    session.getSnapshot().tab!.notes.find((n) => n.id === id)!;
  /** The ids in played order. */
  const noteLabelsOrder = (session: ReturnType<typeof createTakeSession>) =>
    [...session.getSnapshot().tab!.notes].sort((x, y) => x.startMs - y.startMs).map((n) => n.id);

  const opened: ReturnType<typeof createTakeSession>[] = [];
  afterEach(async () => {
    // Close every session and let its last save settle, so none counts as unsaved later.
    for (const s of opened.splice(0)) s.dispose();
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });

  it('single digit: fret 5, pitch follows, locked, unflagged, phrase re-fitted, announced', async () => {
    const { h, session, events } = await open();
    session.select('b');
    session.typeDigit(5);
    await tick(0);
    expect(noteOf(session, 'b')).toEqual({
      ...NOTES[1],
      fret: 5,
      midi: NOTES[1]!.midi + 4,
      locked: true,
      lowConfidence: false,
    });
    expect(h.deps.mapFrets).toHaveBeenCalledTimes(1);
    expect(vi.mocked(h.deps.mapFrets).mock.calls[0]![1]).toMatchObject({
      kind: 'mapFrets',
      locks: [{ index: 1, string: 2, fret: 5 }],
      maxFret: 24,
    });
    expect(noteOf(session, 'a')).toMatchObject({ string: 6, fret: 24 }); // re-fitted
    // The other phrase and deletedStartMs untouched.
    expect(noteOf(session, 'd')).toBe(NOTES[3]);
    expect(noteOf(session, 'e')).toBe(NOTES[4]);
    expect(session.getSnapshot().tab!.deletedStartMs).toBe(TAB5.deletedStartMs);
    expect(session.getSnapshot().selectedNoteId).toBe('b');
    expect(events).toEqual([
      {
        kind: 'edit',
        label: { kind: 'setFret', fret: 5 },
        string: 2,
        fret: 5,
        refingered: ['a', 'c'],
      },
    ]);
    expect(session.canUndo()).toBe(true);
  });

  it('two digits within 400 ms: fret 12, one undo step back to before the first', async () => {
    const { session } = await open();
    session.select('b');
    session.typeDigit(1);
    await tick(200);
    session.typeDigit(2);
    await tick(0);
    expect(noteOf(session, 'b').fret).toBe(12);
    await session.undo();
    expect(session.getSnapshot().tab!.notes).toEqual(NOTES);
    expect(session.canUndo()).toBe(false);
  });

  it('slow digits (500 ms apart): fret 2, two undo steps', async () => {
    const { session } = await open();
    session.select('b');
    session.typeDigit(1);
    await tick(500);
    session.typeDigit(2);
    await tick(0);
    expect(noteOf(session, 'b').fret).toBe(2);
    await session.undo();
    expect(noteOf(session, 'b').fret).toBe(1);
    expect(noteOf(session, 'b').locked).toBe(true);
    await session.undo();
    expect(session.getSnapshot().tab!.notes).toEqual(NOTES);
  });

  it('a second digit on another note starts afresh', async () => {
    const { session } = await open();
    session.select('b');
    session.typeDigit(1);
    session.select('c');
    session.typeDigit(2);
    await tick(0);
    expect(noteOf(session, 'b').fret).toBe(1);
    expect(noteOf(session, 'c').fret).toBe(2);
  });

  it('over max: 3, 0 with maxFret 24 gives 24', async () => {
    const { session, events } = await open();
    session.select('b');
    session.typeDigit(3);
    session.typeDigit(0);
    await tick(0);
    expect(noteOf(session, 'b').fret).toBe(24);
    expect(events.at(-1)).toMatchObject({ kind: 'edit', label: { fret: 24 }, fret: 24 });
  });

  it('a digit with nothing selected does nothing', async () => {
    const { h, session } = await open();
    session.typeDigit(5);
    await tick(0);
    expect(h.deps.mapFrets).not.toHaveBeenCalled();
    expect(session.getSnapshot().tab).toEqual(TAB5);
  });

  it('a null position keeps that note where it is', async () => {
    const { h, session } = await open();
    vi.mocked(h.deps.mapFrets).mockResolvedValueOnce([null, { string: 2, fret: 5 }, null]);
    await session.setFret('b', 5);
    expect(noteOf(session, 'a')).toBe(NOTES[0]);
    expect(noteOf(session, 'c')).toBe(NOTES[2]);
  });

  it('a stale result is dropped and the command re-planned on the new Tab', async () => {
    const { h, session } = await open();
    const first = deferred<Awaited<ReturnType<TakeSessionDeps['mapFrets']>>>();
    vi.mocked(h.deps.mapFrets).mockReturnValueOnce(first.promise);
    const done = session.setFret('b', 5);
    await tick(0);
    // The stored tab changes (a re-read replaces it) while the re-fit is in flight.
    const moved = { ...NOTES[0]!, startMs: 100, endMs: 250 };
    vi.mocked(h.deps.db.getTab).mockResolvedValue({ ...TAB5, notes: [moved, ...NOTES.slice(1)] });
    session.analyse(); // analysed: re-reads the take and tab
    await tick(0);
    first.resolve([
      { string: 1, fret: 0 },
      { string: 2, fret: 5 },
      { string: 3, fret: 2 },
    ]);
    await done;
    expect(h.deps.mapFrets).toHaveBeenCalledTimes(2);
    expect(vi.mocked(h.deps.mapFrets).mock.calls[1]![1].notes[0]).toMatchObject({ startMs: 100 });
    expect(noteOf(session, 'a')).toMatchObject({ startMs: 100, string: 6, fret: 24 });
    expect(noteOf(session, 'b').fret).toBe(5);
  });

  it('undo and redo restore exactly, the selection follows the target; nothing to do: no-op', async () => {
    const { h, session, events } = await open();
    await session.undo();
    await session.redo();
    expect(session.getSnapshot().tab).toEqual(TAB5);
    session.select('b');
    await session.setFret('b', 5);
    const after = session.getSnapshot().tab!;
    session.select('d');
    await session.undo();
    expect(session.getSnapshot().tab!.notes).toEqual(TAB5.notes);
    expect(session.getSnapshot().tab!.deletedStartMs).toEqual(TAB5.deletedStartMs);
    expect(session.getSnapshot().selectedNoteId).toBe('b');
    expect(session.canRedo()).toBe(true);
    session.select('d');
    await session.redo();
    expect(session.getSnapshot().tab!.notes).toEqual(after.notes);
    expect(session.getSnapshot().selectedNoteId).toBe('b');
    expect(events.slice(-2)).toEqual([
      { kind: 'undo', label: { kind: 'setFret', fret: 5 } },
      { kind: 'redo', label: { kind: 'setFret', fret: 5 } },
    ]);
    await session.redo(); // nothing to redo
    expect(session.getSnapshot().tab!.notes).toEqual(after.notes);
    expect(h.deps.mapFrets).toHaveBeenCalledTimes(1); // undo and redo never re-fit
  });

  // Story "Re-fit feedback": an edit reports the other notes its re-fit re-fingered.
  it('re-fit feedback: neighbours the re-fit leaves are not reported', async () => {
    // a and c already sit where the fake mapper puts them (the thickest string).
    const settled: Tab = {
      ...TAB5,
      notes: [note('a', 0, 6, 24), NOTES[1]!, note('c', 600, 6, 17), ...NOTES.slice(3)],
    };
    const { session, events } = await open(settled);
    await session.setFret('b', 5);
    expect(events).toEqual([
      { kind: 'edit', label: { kind: 'setFret', fret: 5 }, string: 2, fret: 5, refingered: [] },
    ]);
  });

  it('re-fit feedback: a locked neighbour is never re-fingered; the target is not counted', async () => {
    const locked: Tab = {
      ...TAB5,
      notes: [{ ...NOTES[0]!, locked: true }, ...NOTES.slice(1)],
    };
    const { session, events } = await open(locked);
    await session.setFret('b', 5);
    expect(events.at(-1)).toMatchObject({ kind: 'edit', refingered: ['c'] });
  });

  it('re-fit feedback: two digits within 400 ms report the whole step’s re-fit on the second', async () => {
    const { session, events } = await open();
    session.select('b');
    session.typeDigit(1);
    await tick(200);
    session.typeDigit(2);
    await tick(0);
    // The second fit leaves a and c where the first put them; against the merged step's
    // `before` (the Tab before the first digit) they are still re-fingered.
    expect(events).toEqual([
      {
        kind: 'edit',
        label: { kind: 'setFret', fret: 1 },
        string: 2,
        fret: 1,
        refingered: ['a', 'c'],
      },
      {
        kind: 'edit',
        label: { kind: 'setFret', fret: 12 },
        string: 2,
        fret: 12,
        refingered: ['a', 'c'],
      },
    ]);
  });

  it('re-fit feedback: a fret set to the fret it has reports no re-fingered list', async () => {
    const { session, events } = await open();
    session.select('b');
    session.typeDigit(5);
    await tick(500);
    session.typeDigit(5);
    await tick(0);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ kind: 'edit', label: { kind: 'setFret', fret: 5 } });
    expect('refingered' in events[1]!).toBe(false);
  });

  it('re-fit feedback: undo and redo report nothing re-fingered', async () => {
    const { session, events } = await open();
    await session.setFret('b', 5);
    await session.undo();
    await session.redo();
    expect(events.slice(-2)).toEqual([
      { kind: 'undo', label: { kind: 'setFret', fret: 5 } },
      { kind: 'redo', label: { kind: 'setFret', fret: 5 } },
    ]);
  });

  it('a new edit clears redo', async () => {
    const { session } = await open();
    await session.setFret('b', 5);
    await session.undo();
    await session.setFret('c', 7);
    expect(session.canRedo()).toBe(false);
  });

  it('201 edits: 200 undoable', async () => {
    const { session } = await open();
    for (let i = 0; i < 201; i++) await session.setFret('b', i % 2 === 0 ? 5 : 6);
    let undone = 0;
    while (session.canUndo()) {
      await session.undo();
      undone++;
    }
    expect(undone).toBe(200);
    // The oldest step (the first edit) was dropped: the Tab is the state after it.
    expect(noteOf(session, 'b').fret).toBe(5);
  });

  it('an engine error drops the command: Tab unchanged, failure announced', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { h, session, events } = await open();
    vi.mocked(h.deps.mapFrets).mockRejectedValueOnce(new AppError('analysis-failed', 'boom'));
    await session.setFret('b', 5);
    expect(session.getSnapshot().tab!.notes).toBe(TAB5.notes);
    expect(events).toEqual([{ kind: 'failed' }]);
    expect(session.canUndo()).toBe(false);
    await tick(1000);
    expect(h.deps.putTab).not.toHaveBeenCalled();
  });

  it('commands run one at a time, in order', async () => {
    const { h, session } = await open();
    const first = deferred<Awaited<ReturnType<TakeSessionDeps['mapFrets']>>>();
    vi.mocked(h.deps.mapFrets).mockReturnValueOnce(first.promise);
    const one = session.setFret('b', 5);
    const two = session.setFret('b', 7);
    const undo = session.undo();
    await tick(0);
    expect(h.deps.mapFrets).toHaveBeenCalledTimes(1); // the second waits
    first.resolve([null, { string: 2, fret: 5 }, null]);
    await Promise.all([one, two, undo]);
    // 5, then 7, then undo of 7.
    expect(noteOf(session, 'b').fret).toBe(5);
  });

  it('debounce: 3 edits 100 ms apart, one putTab 300 ms after the last', async () => {
    const { h, session } = await open();
    await session.setFret('b', 5);
    await tick(100);
    await session.setFret('b', 6);
    await tick(100);
    await session.setFret('b', 7);
    await tick(299);
    expect(h.deps.putTab).not.toHaveBeenCalled();
    expect(hasUnsavedEdits()).toBe(true);
    await tick(1);
    expect(h.deps.putTab).toHaveBeenCalledTimes(1);
    expect(h.deps.putTab).toHaveBeenCalledWith(session.getSnapshot().tab, 'take-session');
    expect(vi.mocked(h.deps.putTab).mock.calls[0]![0].notes.find((n) => n.id === 'b')?.fret).toBe(
      7,
    );
    expect(hasUnsavedEdits()).toBe(false);
  });

  it('undo and redo save too', async () => {
    const { h, session } = await open();
    await session.setFret('b', 5);
    await tick(300);
    await session.undo();
    await tick(300);
    expect(h.deps.putTab).toHaveBeenCalledTimes(2);
    expect(vi.mocked(h.deps.putTab).mock.calls[1]![0].notes).toEqual(TAB5.notes);
  });

  it('dispose (route exit) saves at once', async () => {
    const { h, session } = await open();
    await session.setFret('b', 5);
    session.dispose();
    await tick(0);
    expect(h.deps.putTab).toHaveBeenCalledTimes(1);
    await tick(1000);
    expect(h.deps.putTab).toHaveBeenCalledTimes(1);
  });

  it('pagehide / hidden saves at once; nothing unsaved: no write', async () => {
    const { h, session, pageHide } = await open();
    pageHide();
    await tick(0);
    expect(h.deps.putTab).not.toHaveBeenCalled();
    await session.setFret('b', 5);
    pageHide();
    await tick(0);
    expect(h.deps.putTab).toHaveBeenCalledTimes(1);
    session.dispose();
    expect(h.deps.onPageHide).toHaveBeenCalledTimes(1);
  });

  it('storage full: the Tab is kept, saveFailed shows, Retry saves and clears it', async () => {
    const { h, session } = await open();
    vi.mocked(h.deps.putTab).mockRejectedValueOnce(new AppError('storage-full', 'quota'));
    await session.setFret('b', 5);
    await tick(300);
    expect(session.getSnapshot().saveFailed).toBe('storage-full');
    expect(noteOf(session, 'b').fret).toBe(5);
    expect(hasUnsavedEdits()).toBe(true);
    session.retrySave();
    await tick(0);
    expect(h.deps.putTab).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot().saveFailed).toBeNull();
    expect(hasUnsavedEdits()).toBe(false);
  });

  it('storage full: further edits keep working and retry the save', async () => {
    const { h, session } = await open();
    vi.mocked(h.deps.putTab).mockRejectedValueOnce(new AppError('storage-full', 'quota'));
    await session.setFret('b', 5);
    await tick(300);
    expect(session.getSnapshot().saveFailed).toBe('storage-full');
    await session.setFret('c', 7);
    expect(noteOf(session, 'c').fret).toBe(7);
    await tick(300);
    expect(session.getSnapshot().saveFailed).toBeNull();
    expect(vi.mocked(h.deps.putTab).mock.calls.at(-1)![0]).toBe(session.getSnapshot().tab);
  });

  it('another save error: no banner, logged, retried on the next flush', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { h, session } = await open();
    vi.mocked(h.deps.putTab).mockRejectedValueOnce(new AppError('storage-failed', 'io'));
    await session.setFret('b', 5);
    await tick(300);
    expect(session.getSnapshot().saveFailed).toBeNull();
    expect(warn).toHaveBeenCalled();
    await session.flush();
    expect(h.deps.putTab).toHaveBeenCalledTimes(2);
  });

  it('take deleted: the pending save and queued commands are dropped', async () => {
    const { h, session } = await open();
    await session.setFret('b', 5);
    const first = deferred<Awaited<ReturnType<TakeSessionDeps['mapFrets']>>>();
    vi.mocked(h.deps.mapFrets).mockReturnValueOnce(first.promise);
    const inFlight = session.setFret('b', 6);
    const queued = session.setFret('c', 7);
    await tick(0);
    h.emit({ type: 'take-deleted', takeId: 't1', writer: 'library-session' });
    first.reject(new AppError('analysis-cancelled', 'cancelled'));
    await Promise.all([inFlight, queued]);
    await tick(1000);
    expect(h.deps.putTab).not.toHaveBeenCalled();
    expect(h.deps.mapFrets).toHaveBeenCalledTimes(2);
    expect(h.deps.cancel).toHaveBeenCalledWith('t1');
    expect(session.getSnapshot().tab).toBeNull();
    expect(hasUnsavedEdits()).toBe(false);
  });

  it('a completed analysis or a reload of the take resets the history', async () => {
    const { h, session } = await open();
    await session.setFret('b', 5);
    expect(session.canUndo()).toBe(true);
    session.analyse(); // analysed: re-reads the take and tab
    await tick(0);
    expect(session.canUndo()).toBe(false);
    expect(h.deps.db.getTab).toHaveBeenCalledTimes(2);
  });

  it('storage full, then the screen closes: the next session for the take shows the held edit and the banner; Retry saves it', async () => {
    const first = await open();
    vi.mocked(first.h.deps.putTab).mockRejectedValue(new AppError('storage-full', 'quota'));
    await first.session.setFret('b', 5);
    await tick(300);
    expect(first.session.getSnapshot().saveFailed).toBe('storage-full');
    first.session.dispose(); // the dispose flush fails again
    await tick(0);
    expect(first.h.deps.putTab).toHaveBeenCalledTimes(2);
    expect(hasUnsavedEdits()).toBe(false); // held, not busy (as analysis's held result)

    const second = await open(); // storage still holds the unedited tab
    expect(second.session.getSnapshot().saveFailed).toBe('storage-full');
    expect(noteOf(second.session, 'b')).toMatchObject({ fret: 5, locked: true });
    second.session.retrySave();
    await tick(0);
    expect(second.h.deps.putTab).toHaveBeenCalledTimes(1);
    expect(vi.mocked(second.h.deps.putTab).mock.calls[0]![0].notes[1]).toMatchObject({ fret: 5 });
    expect(second.session.getSnapshot().saveFailed).toBeNull();

    const third = await open(); // saved: nothing held any more
    expect(third.session.getSnapshot().saveFailed).toBeNull();
    expect(third.session.getSnapshot().tab).toEqual(TAB5);
  });

  it('a held edit is dropped when the take is deleted', async () => {
    const first = await open();
    vi.mocked(first.h.deps.putTab).mockRejectedValue(new AppError('storage-full', 'quota'));
    await first.session.setFret('b', 5);
    await tick(300);
    first.h.emit({ type: 'take-deleted', takeId: 't1', writer: 'library-session' });
    const second = await open();
    expect(second.session.getSnapshot().saveFailed).toBeNull();
    expect(second.session.getSnapshot().tab).toEqual(TAB5);
  });

  it('a save that throws does not stop later saves', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { h, session } = await open();
    vi.mocked(h.deps.putTab).mockRejectedValueOnce(new AppError('storage-full', 'quota'));
    let throwing = true;
    session.subscribe(() => {
      if (throwing && session.getSnapshot().saveFailed === 'storage-full') throw new Error('boom');
    });
    await session.setFret('b', 5);
    await tick(300); // the save's publish throws
    throwing = false;
    await session.setFret('b', 6);
    await tick(300);
    expect(h.deps.putTab).toHaveBeenCalledTimes(2);
    expect(vi.mocked(h.deps.putTab).mock.calls[1]![0].notes[1]).toMatchObject({ fret: 6 });
  });

  it('a selection change in between: the second digit starts afresh', async () => {
    const { session } = await open();
    session.select('b');
    session.typeDigit(1);
    session.select('c');
    session.select('b');
    session.typeDigit(2);
    await tick(0);
    expect(noteOf(session, 'b').fret).toBe(2);
  });

  // Story "String moves, delete, insert and confirm".
  describe('string moves, delete, insert and confirm', () => {
    // A G-string note at fret 7 (D4, midi 62), flagged, in phrase 1 in place of b.
    const G7: Note = { ...note('g', 300, 3, 7), lowConfidence: true };
    const TABG: Tab = { ...TAB5, notes: [NOTES[0]!, G7, ...NOTES.slice(2)] };

    it('↑ moves the selected note to the next thinner string at the same pitch, locked, re-fitted', async () => {
      const { h, session, events } = await open(TABG);
      session.select('g');
      await session.moveStringBy(-1);
      expect(noteOf(session, 'g')).toEqual({
        ...G7,
        string: 2,
        fret: 3,
        locked: true,
        lowConfidence: false,
      });
      expect(h.deps.mapFrets).toHaveBeenCalledTimes(1);
      expect(noteOf(session, 'a')).toMatchObject({ string: 6, fret: 24 }); // phrase re-fitted
      expect(noteOf(session, 'd')).toBe(NOTES[3]);
      expect(events).toEqual([
        {
          kind: 'edit',
          label: { kind: 'moveString', string: 2, fret: 3 },
          string: 2,
          fret: 3,
          refingered: ['a', 'c'],
        },
      ]);
      expect(session.canUndo()).toBe(true);
      await session.moveStringBy(1); // ↓ back to the G string
      expect(noteOf(session, 'g')).toMatchObject({ string: 3, fret: 7, midi: 62 });
    });

    it('↓ skips strings that cannot play the pitch: none left that way does nothing', async () => {
      // maxFret 5: D4 on the B string (fret 3) has no thicker string within 5 frets.
      const B3: Note = { ...note('g', 300, 2, 3), locked: true };
      const { h, session } = await open(
        { ...TAB5, notes: [NOTES[0]!, B3, ...NOTES.slice(2)] },
        { ...ANALYZED, settings: { ...ANALYZED.settings, maxFret: 5 } },
      );
      session.select('g');
      await session.moveStringBy(1);
      expect(h.deps.mapFrets).not.toHaveBeenCalled();
      expect(session.canUndo()).toBe(false);
      await session.moveStringBy(-1); // the high e plays it at fret −2: no
      expect(session.canUndo()).toBe(false);
    });

    it('edge: ↑ on the high e does nothing, no step', async () => {
      const { h, session, events } = await open();
      session.select('a'); // string 1
      await session.moveStringBy(-1);
      expect(h.deps.mapFrets).not.toHaveBeenCalled();
      expect(session.canUndo()).toBe(false);
      expect(events).toEqual([]);
      await session.moveStringBy(1);
      expect(noteOf(session, 'a')).toMatchObject({ string: 2, fret: 5, midi: 64 });
    });

    it('moveString to an explicit string (the popover)', async () => {
      const { session } = await open(TABG);
      await session.moveString('g', 4);
      expect(noteOf(session, 'g')).toMatchObject({ string: 4, fret: 12, locked: true });
    });

    it('delete: removed, startMs recorded, next note selected, neighbours re-fitted, announced', async () => {
      const { h, session, events } = await open();
      session.select('b');
      await session.deleteSelected();
      const tab = session.getSnapshot().tab!;
      expect(tab.notes.map((n) => n.id)).toEqual(['a', 'c', 'd', 'e']);
      expect(tab.deletedStartMs).toEqual([1500, 300]);
      expect(session.getSnapshot().selectedNoteId).toBe('c');
      expect(vi.mocked(h.deps.mapFrets).mock.calls[0]![1].notes.map((n) => n.startMs)).toEqual([
        0, 600,
      ]);
      expect(noteOf(session, 'a')).toMatchObject({ string: 6 }); // re-fitted
      // The deleted target is gone; its re-fitted neighbours are still reported.
      expect(events).toEqual([
        { kind: 'edit', label: { kind: 'delete' }, string: 2, fret: 1, refingered: ['a', 'c'] },
      ]);
    });

    it('delete the last note in played order: the previous one is selected', async () => {
      const { session } = await open();
      session.select('e');
      await session.deleteSelected();
      expect(session.getSnapshot().selectedNoteId).toBe('d');
    });

    it('undo a delete: the note and deletedStartMs come back, the note selected', async () => {
      const { session } = await open();
      session.select('b');
      await session.deleteSelected();
      await session.undo();
      expect(session.getSnapshot().tab!.notes).toEqual(TAB5.notes);
      expect(session.getSnapshot().tab!.deletedStartMs).toEqual([1500]);
      expect(session.getSnapshot().selectedNoteId).toBe('b');
    });

    it('delete the only note: No notes found; undo and redo still work with history', async () => {
      const only = note('x', 500, 3, 2);
      const { session } = await open({ ...TAB, notes: [only], deletedStartMs: [] });
      session.select('x');
      await session.deleteSelected();
      expect(session.getSnapshot().tab!.notes).toEqual([]);
      expect(session.getSnapshot().selectedNoteId).toBeNull();
      expect(isTabShown(session.getSnapshot())).toBe(false);
      // No edits apply with no notes; undo does.
      await session.insert();
      expect(session.getSnapshot().tab!.notes).toEqual([]);
      await session.undo();
      expect(session.getSnapshot().tab!.notes).toEqual([only]);
      expect(session.getSnapshot().tab!.deletedStartMs).toEqual([]);
      expect(session.getSnapshot().selectedNoteId).toBe('x');
      await session.redo();
      expect(session.getSnapshot().tab!.notes).toEqual([]);
      expect(session.getSnapshot().tab!.deletedStartMs).toEqual([500]);
    });

    it('delete with nothing selected does nothing', async () => {
      const { h, session } = await open();
      await session.deleteSelected();
      expect(h.deps.mapFrets).not.toHaveBeenCalled();
      expect(session.getSnapshot().tab).toEqual(TAB5);
    });

    it('insert after the selection: midway, its string, fret 0, locked, selected, announced', async () => {
      const p = { ...note('p', 1000, 3, 4), endMs: 1100 };
      const q = note('q', 1500, 1, 0);
      const { session, events } = await open({ ...TAB, notes: [p, q], deletedStartMs: [] });
      session.select('p');
      await session.insert();
      expect(session.getSnapshot().tab!.notes.map((n) => n.id)).toEqual(['p', 'new1', 'q']);
      expect(noteOf(session, 'new1')).toEqual({
        id: 'new1',
        startMs: 1250,
        endMs: 1350,
        midi: 55,
        confidence: 1,
        string: 3,
        fret: 0,
        locked: true,
        lowConfidence: false,
        inserted: true,
      });
      expect(session.getSnapshot().selectedNoteId).toBe('new1');
      expect(events).toEqual([
        { kind: 'edit', label: { kind: 'insert' }, string: 3, fret: 0, refingered: ['p', 'q'] },
      ]);
      // Undo removes it, and the selection with it.
      await session.undo();
      expect(session.getSnapshot().tab!.notes.map((n) => n.id)).toEqual(['p', 'q']);
      expect(session.getSnapshot().selectedNoteId).toBeNull();
    });

    it('insert at the end: 250 ms after the last note', async () => {
      const { session } = await open();
      session.select('e');
      await session.insert();
      expect(noteOf(session, 'new1')).toMatchObject({ startMs: 2550, string: 2 });
    });

    it('insert with no selection: before the first note, not before the take start', async () => {
      const first = note('f', 1500, 4, 2);
      const one = await open({ ...TAB, notes: [first], deletedStartMs: [] });
      await one.session.insert();
      expect(noteOf(one.session, 'new1')).toMatchObject({ startMs: 1250, string: 4 });
      const early = await open({ ...TAB, notes: [note('f', 100, 4, 2)], deletedStartMs: [] });
      await early.session.insert();
      expect(noteOf(early.session, 'new1')).toMatchObject({ startMs: 0 });
    });

    it('insert, then a digit typed before it lands: the new note gets the fret', async () => {
      const { h, session } = await open();
      const first = deferred<Awaited<ReturnType<TakeSessionDeps['mapFrets']>>>();
      vi.mocked(h.deps.mapFrets).mockReturnValueOnce(first.promise);
      session.select('e');
      const inserting = session.insert();
      session.typeDigit(5);
      await tick(0);
      first.resolve([null, null, null]);
      await inserting;
      await tick(0);
      expect(noteOf(session, 'new1')).toMatchObject({ fret: 5, string: 2, midi: 64 });
      // The digit did not land on the note selected before the insert (only re-fitted).
      expect(noteOf(session, 'e')).toMatchObject({ locked: false, midi: NOTES[4]!.midi });
    });

    it('insert, then two digits: one number on the new note', async () => {
      const { session } = await open();
      session.select('e');
      await session.insert();
      session.typeDigit(1);
      session.typeDigit(2);
      await tick(0);
      expect(noteOf(session, 'new1').fret).toBe(12);
    });

    it('insert with no selection on a trimmed take: at the trim start, before the first note', async () => {
      const first = note('f', 100, 4, 2);
      const { session } = await open(
        { ...TAB, notes: [first, note('s', 400, 1, 0)], deletedStartMs: [] },
        { ...ANALYZED, trimStartMs: 60 },
      );
      await session.insert();
      expect(session.getSnapshot().tab!.notes.map((n) => n.id)).toEqual(['new1', 'f', 's']);
      expect(noteOf(session, 'new1')).toMatchObject({ startMs: 60, string: 4 });
      expect(noteLabelsOrder(session)).toEqual(['new1', 'f', 's']);
    });

    it('I, one digit before the insert lands and one after within 400 ms: one fret, one undo step', async () => {
      const { h, session } = await open();
      const first = deferred<Awaited<ReturnType<TakeSessionDeps['mapFrets']>>>();
      vi.mocked(h.deps.mapFrets).mockReturnValueOnce(first.promise);
      session.select('e');
      const inserting = session.insert();
      session.typeDigit(1);
      await tick(100);
      first.resolve([null, null, null]);
      await inserting;
      await tick(0);
      session.typeDigit(2);
      await tick(0);
      expect(noteOf(session, 'new1').fret).toBe(12);
      await session.undo();
      expect(noteOf(session, 'new1').fret).toBe(0); // back to before the first digit
      await session.undo();
      expect(session.getSnapshot().tab!.notes.some((n) => n.id === 'new1')).toBe(false);
    });

    it('a digit after I goes to a note the player then selected, not the pending insert', async () => {
      const { h, session } = await open();
      const first = deferred<Awaited<ReturnType<TakeSessionDeps['mapFrets']>>>();
      vi.mocked(h.deps.mapFrets).mockReturnValueOnce(first.promise);
      session.select('e');
      const inserting = session.insert();
      session.select('d');
      session.typeDigit(7);
      first.resolve([null, null, null]);
      await inserting;
      await tick(0);
      expect(noteOf(session, 'd').fret).toBe(7);
      expect(noteOf(session, 'new1').fret).toBe(0);
    });

    it('a digit aimed at an insert that made no note goes to the selection', async () => {
      const { h, session } = await open();
      vi.mocked(h.deps.mapFrets).mockRejectedValueOnce(new AppError('analysis-failed', 'x'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      session.select('e');
      const inserting = session.insert();
      session.typeDigit(6);
      await inserting;
      await tick(0);
      expect(session.getSnapshot().tab!.notes.some((n) => n.id === 'new1')).toBe(false);
      expect(noteOf(session, 'e').fret).toBe(6);
    });

    it('three ↑ queued before any lands move three strings', async () => {
      // C4 (midi 60) on the low E at fret 20: ↑ goes A 15, D 10, G 5.
      const z = note('z', 300, 6, 20);
      const { h, session } = await open({ ...TAB, notes: [z], deletedStartMs: [] });
      const first = deferred<Awaited<ReturnType<TakeSessionDeps['mapFrets']>>>();
      vi.mocked(h.deps.mapFrets).mockReturnValueOnce(first.promise);
      session.select('z');
      const moves = [session.moveStringBy(-1), session.moveStringBy(-1), session.moveStringBy(-1)];
      first.resolve([null]);
      await Promise.all(moves);
      expect(noteOf(session, 'z')).toMatchObject({ string: 3, fret: 5, midi: 60 });
      // Two more: B fret 1, then the high e cannot play it (the edge): it stays.
      await Promise.all([session.moveStringBy(-1), session.moveStringBy(-1)]);
      expect(noteOf(session, 'z')).toMatchObject({ string: 2, fret: 1 });
    });

    it('Delete twice deletes two notes', async () => {
      const { session } = await open();
      session.select('b');
      await Promise.all([session.deleteSelected(), session.deleteSelected()]);
      expect(session.getSnapshot().tab!.notes.map((n) => n.id)).toEqual(['a', 'd', 'e']);
      expect(session.getSnapshot().tab!.deletedStartMs).toEqual([1500, 300, 600]);
      expect(session.getSnapshot().selectedNoteId).toBe('d');
    });

    it('I twice: two notes in played order after the original', async () => {
      const p = note('p', 1000, 3, 4);
      const q = note('q', 1800, 1, 0);
      const { session } = await open({ ...TAB, notes: [p, q], deletedStartMs: [] });
      session.select('p');
      await Promise.all([session.insert(), session.insert()]);
      expect(noteLabelsOrder(session)).toEqual(['p', 'new1', 'new2', 'q']);
      expect(noteOf(session, 'new1').startMs).toBe(1400);
      expect(noteOf(session, 'new2').startMs).toBe(1600);
      expect(session.getSnapshot().selectedNoteId).toBe('new2');
    });

    it('Delete then I: inserts after the newly selected note', async () => {
      const { session } = await open();
      session.select('b');
      await Promise.all([session.deleteSelected(), session.insert()]);
      expect(noteLabelsOrder(session)).toEqual(['a', 'c', 'new1', 'd', 'e']);
      // c's string as the delete's re-fit left it.
      expect(noteOf(session, 'new1')).toMatchObject({
        string: noteOf(session, 'c').string,
        startMs: 1300,
      });
    });

    it('confirm a flagged note: locked, unflagged, re-fitted, announced', async () => {
      const { h, session, events } = await open();
      await session.confirm('b');
      expect(noteOf(session, 'b')).toEqual({ ...NOTES[1], locked: true, lowConfidence: false });
      expect(session.getSnapshot().tab!.notes.filter((n) => n.lowConfidence)).toHaveLength(0);
      expect(h.deps.mapFrets).toHaveBeenCalledTimes(1);
      expect(events).toEqual([
        { kind: 'edit', label: { kind: 'confirm' }, string: 2, fret: 1, refingered: ['a', 'c'] },
      ]);
    });

    it('confirm an already confirmed note: no step, no announcement', async () => {
      const { h, session, events } = await open();
      await session.confirm('b');
      events.length = 0;
      await session.confirm('b');
      expect(events).toEqual([]);
      expect(h.deps.mapFrets).toHaveBeenCalledTimes(1);
      await session.undo();
      expect(session.canUndo()).toBe(false); // one step only
    });
  });

  // Story "Undo and redo controls": the top steps' labels in the snapshot.
  describe('undo and redo labels', () => {
    /** The snapshot's labels, checked against canUndo / canRedo. */
    const labels = (session: ReturnType<typeof createTakeSession>) => {
      const { undoLabel, redoLabel } = session.getSnapshot();
      expect(session.canUndo()).toBe(undoLabel !== null);
      expect(session.canRedo()).toBe(redoLabel !== null);
      return { undoLabel, redoLabel };
    };

    it('fresh: both null', async () => {
      const { session } = await open();
      expect(labels(session)).toEqual({ undoLabel: null, redoLabel: null });
    });

    it('a move, undo, redo and a new edit after an undo republish the labels', async () => {
      const { session } = await open();
      let published = 0;
      session.subscribe(() => published++);
      const MOVE = { kind: 'moveString', string: 3, fret: 5 };
      await session.moveString('b', 3);
      expect(labels(session)).toEqual({ undoLabel: MOVE, redoLabel: null });
      published = 0;
      await session.undo();
      expect(published).toBeGreaterThan(0);
      expect(labels(session)).toEqual({ undoLabel: null, redoLabel: MOVE });
      await session.redo();
      expect(labels(session)).toEqual({ undoLabel: MOVE, redoLabel: null });
      await session.undo();
      await session.confirm('c'); // a new edit clears redo
      expect(labels(session)).toEqual({ undoLabel: { kind: 'confirm' }, redoLabel: null });
    });

    it('merged digits: the merged step labels set fret 12', async () => {
      const { session } = await open();
      session.select('b');
      session.typeDigit(1);
      await tick(0);
      expect(labels(session).undoLabel).toEqual({ kind: 'setFret', fret: 1 });
      await tick(200);
      session.typeDigit(2);
      await tick(0);
      expect(labels(session)).toEqual({
        undoLabel: { kind: 'setFret', fret: 12 },
        redoLabel: null,
      });
    });

    it('an edit that changed nothing leaves them, redo included', async () => {
      const { session } = await open();
      await session.confirm('b');
      await session.confirm('c');
      await session.undo();
      const before = session.getSnapshot();
      expect(before.redoLabel).toEqual({ kind: 'confirm' });
      await session.confirm('b'); // already confirmed: no step
      expect(session.getSnapshot().undoLabel).toBe(before.undoLabel);
      expect(session.getSnapshot().redoLabel).toBe(before.redoLabel);
      expect(session.canRedo()).toBe(true);
    });

    it('a re-read that finds the take gone resets them; the pending save is dropped', async () => {
      const { h, session } = await open();
      await session.setFret('b', 5);
      expect(session.canUndo()).toBe(true);
      vi.mocked(h.deps.db.getTake).mockResolvedValue(null);
      session.analyse(); // not recorded: re-reads the take
      await tick(0);
      expect(session.getSnapshot()).toMatchObject({
        missing: true,
        undoLabel: null,
        redoLabel: null,
      });
      expect(session.canUndo()).toBe(false);
      await tick(1000);
      expect(h.deps.putTab).not.toHaveBeenCalled();
    });

    it('deleting every note keeps undo: "delete note"', async () => {
      const { session } = await open({ ...TAB5, notes: [NOTES[0]!] });
      session.select('a');
      await session.deleteSelected();
      expect(session.getSnapshot().tab!.notes).toEqual([]);
      expect(labels(session)).toEqual({ undoLabel: { kind: 'delete' }, redoLabel: null });
      await session.undo();
      expect(labels(session)).toEqual({ undoLabel: null, redoLabel: { kind: 'delete' } });
    });

    it('a reload, an analysis and a deletion reset them', async () => {
      const { h, session } = await open();
      await session.setFret('b', 5);
      await session.undo();
      await session.setFret('c', 4);
      await session.undo();
      expect(labels(session).redoLabel).not.toBeNull();
      session.analyse(); // analysed: re-reads the take and tab
      await tick(0);
      expect(labels(session)).toEqual({ undoLabel: null, redoLabel: null });
      await session.setFret('b', 5);
      expect(labels(session).undoLabel).not.toBeNull();
      h.emit({ type: 'take-deleted', takeId: 't1', writer: 'library-session' });
      expect(session.getSnapshot()).toMatchObject({
        missing: true,
        undoLabel: null,
        redoLabel: null,
      });
    });
  });

  // Story "Undo and redo controls": history integrity at the session level.
  describe('property: 50 random commands through the session', () => {
    /** mulberry32: a small seeded PRNG. */
    function rng(seed: number) {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    it.each([1, 7, 42, 99, 2026])(
      'one step per changing command; undo all = original, redo all = final (seed %i)',
      async (seed) => {
        const random = rng(seed);
        const notes = Array.from({ length: 12 }, (_, i) => {
          const string = (Math.floor(random() * 6) + 1) as Note['string'];
          // A phrase break (a gap over 1000 ms) every four notes.
          const startMs = i * 300 + Math.floor(i / 4) * 1500;
          return {
            ...note(`n${i}`, startMs, string, Math.floor(random() * 13)),
            lowConfidence: random() < 0.3,
          };
        });
        const { session } = await open({ ...TAB5, notes, deletedStartMs: [99] });
        /** The labels agree with canUndo / canRedo. */
        const agree = () => {
          const { undoLabel, redoLabel } = session.getSnapshot();
          expect(undoLabel !== null).toBe(session.canUndo());
          expect(redoLabel !== null).toBe(session.canRedo());
        };
        const state = () => {
          const { notes, deletedStartMs } = session.getSnapshot().tab!;
          return structuredClone({ notes, deletedStartMs });
        };
        /** The Tab after each command that changed it, the original first. */
        const states = [state()];
        for (let i = 0; i < 50; i++) {
          const current = session.getSnapshot().tab!.notes;
          const target = current[Math.floor(random() * current.length)]?.id ?? null;
          const kind = Math.floor(random() * 5);
          const before = session.getSnapshot().tab!;
          if (target === null || kind === 3) {
            session.select(random() < 0.2 ? null : target);
            await session.insert();
          } else if (kind === 0) {
            await session.setFret(target, Math.floor(random() * 30));
          } else if (kind === 1) {
            await session.moveString(target, (Math.floor(random() * 6) + 1) as Note['string']);
          } else if (kind === 2) {
            session.select(target);
            await session.deleteSelected();
          } else {
            await session.confirm(target);
          }
          const after = session.getSnapshot().tab!;
          const changed =
            after.notes !== before.notes || after.deletedStartMs !== before.deletedStartMs;
          if (changed) states.push(state());
        }
        expect(states.length).toBeGreaterThan(10);
        // Undo walks back through every changed state, one step per command.
        for (let i = states.length - 2; i >= 0; i--) {
          expect(session.canUndo()).toBe(true);
          await session.undo();
          agree();
          expect(state()).toEqual(states[i]);
        }
        expect(session.canUndo()).toBe(false);
        expect(state()).toEqual(states[0]);
        for (let i = 1; i < states.length; i++) {
          await session.redo();
          agree();
          expect(state()).toEqual(states[i]);
        }
        expect(session.canRedo()).toBe(false);
        expect(state()).toEqual(states.at(-1));
      },
    );
  });

  it('edits do nothing while the tab is not shown (analysing)', async () => {
    const { h, session } = await open(TAB5, TAKE);
    await session.setFret('b', 5);
    expect(h.deps.mapFrets).not.toHaveBeenCalled();
  });
});

// The app's page-hide hook (createAppTakeSession's `onPageHide`).
describe('onPageHide', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs on pagehide and on visibilitychange to hidden, not to visible; cleanup removes both', () => {
    const listener = vi.fn();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const remove = onPageHide(listener);
    window.dispatchEvent(new Event('pagehide'));
    expect(listener).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(listener).toHaveBeenCalledTimes(1); // visible: no save
    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(listener).toHaveBeenCalledTimes(2);
    remove();
    window.dispatchEvent(new Event('pagehide'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

// Story "Analysis settings and re-analysis" (US-4.6, spine AD-4, AD-14, AD-15).
describe('take session analysis settings and re-analysis', () => {
  const note = (id: string, startMs: number, fret: number, over: Partial<Note> = {}): Note => ({
    id,
    startMs,
    endMs: startMs + 100,
    midi: 64 + fret,
    confidence: 0.9,
    string: 1,
    fret,
    locked: false,
    lowConfidence: false,
    ...over,
  });
  const detected = (startMs: number, fret: number, confidence = 0.9) => ({
    startMs,
    endMs: startMs + 100,
    midi: 64 + fret,
    confidence,
  });
  const run = (notes: ReturnType<typeof detected>[], fromRaw = false): ReanalysisRun => ({
    result: { notes, tuningOffsetCents: 4, belowRangeNotes: 0, confidenceThreshold: 0.35 },
    analysisVersion: '0.5.0',
    fromRaw,
  });
  /** Locks kept; everything else on the high e string (null past the highest fret). */
  const fakeMap = (r: Parameters<TakeSessionDeps['mapFrets']>[1]) =>
    r.notes.map((n, i) => {
      const lock = r.locks.find((l) => l.index === i);
      if (lock) return { string: lock.string, fret: lock.fret };
      const fret = n.midi - 64;
      return fret >= 0 && fret <= r.maxFret ? { string: 1 as const, fret } : null;
    });

  const LOCKED = note('L', 1000, 7, { locked: true });
  const PLAIN = note('P', 2000, 3);
  const TAB2: Tab = { ...TAB, notes: [LOCKED, PLAIN], deletedStartMs: [1500] };
  const opened: ReturnType<typeof createTakeSession>[] = [];
  afterEach(() => {
    for (const s of opened.splice(0)) s.dispose();
  });

  async function open(tab: Tab = TAB2, take: Take = ANALYZED, hasRaw = false) {
    const h = harness(take, tab);
    const engine = { run: deferred<ReanalysisRun>(), progress: null as ProgressListener | null };
    engine.run.promise.catch(() => {}); // a cancel before any run rejects this unused one
    vi.mocked(h.deps.analysis.reanalyse).mockImplementation((_take, onProgress) => {
      engine.run = deferred<ReanalysisRun>();
      engine.progress = onProgress ?? null;
      return engine.run.promise;
    });
    vi.mocked(h.deps.analysis.cancel).mockImplementation(() => {
      engine.run.reject(new AppError('analysis-cancelled', 'cancelled'));
      return true;
    });
    vi.mocked(h.deps.mapFrets).mockImplementation(async (_id, r) => fakeMap(r));
    vi.mocked(h.deps.hasRaw).mockResolvedValue(hasRaw);
    let ids = 0;
    h.deps.newId = () => `new${++ids}`;
    const session = createTakeSession('t1', h.deps);
    opened.push(session);
    const events: EditEvent[] = [];
    session.onEditEvent((e) => events.push(e));
    session.subscribe(() => {});
    await settle();
    return { h, session, events, engine };
  }

  describe('setSettings', () => {
    it('saves the settings to the take at once (patchTake), shows them, and makes no undo step', async () => {
      const { h, session } = await open();
      const done = session.setSettings({ sensitivity: 0.3 });
      expect(session.getSnapshot().take!.settings).toEqual({
        sensitivity: 0.3,
        minNoteMs: 40,
        maxFret: 24,
      });
      await done;
      expect(h.deps.db.patchTake).toHaveBeenCalledWith(
        't1',
        { settings: { sensitivity: 0.3, minNoteMs: 40, maxFret: 24 } },
        'take-session',
      );
      expect(session.getSnapshot().undoLabel).toBeNull();
      expect(session.canUndo()).toBe(false);
    });

    it('clamps to the ranges: a minimum length of 5 stores 20; unchanged writes nothing', async () => {
      const { h, session } = await open();
      await session.setSettings({ minNoteMs: 5 });
      expect(h.deps.db.patchTake).toHaveBeenLastCalledWith(
        't1',
        { settings: { sensitivity: 0.5, minNoteMs: 20, maxFret: 24 } },
        'take-session',
      );
      await session.setSettings({ minNoteMs: 20, maxFret: NaN });
      expect(h.deps.db.patchTake).toHaveBeenCalledTimes(1);
    });

    it('a take read while a settings write is pending does not become the stored settings', async () => {
      const { h, session } = await open();
      const write = deferred<Take>();
      vi.mocked(h.deps.db.patchTake).mockReturnValueOnce(write.promise);
      const done = session.setSettings({ sensitivity: 0.8 });
      // The Library renames the take meanwhile: its take-put is re-read.
      vi.mocked(h.deps.db.getTake).mockResolvedValueOnce({ ...ANALYZED, title: 'Renamed' });
      h.emit({ type: 'take-put', takeId: 't1', writer: 'library-session' });
      await settle();
      expect(session.getSnapshot().take).toMatchObject({
        title: 'Renamed',
        settings: { sensitivity: 0.8 },
      });
      write.reject(new AppError('storage-full', 'full'));
      await done;
      expect(session.getSnapshot().take).toMatchObject({
        title: 'Renamed',
        settings: { sensitivity: 0.5 },
      });
    });

    it('refused while an undo of a re-analysis commits', async () => {
      const { h, session, engine } = await open();
      const done = session.reanalyse();
      await settle();
      engine.run.resolve(run([detected(1200, 3)]));
      await done;
      const restore = deferred<{ take: Take; tab: Tab }>();
      vi.mocked(h.deps.db.commitAnalysis).mockReturnValueOnce(restore.promise);
      const undo = session.undo();
      await settle();
      await session.setSettings({ sensitivity: 0.9 });
      expect(h.deps.db.patchTake).not.toHaveBeenCalled();
      restore.resolve({ take: ANALYZED, tab: TAB2 });
      await undo;
      expect(session.getSnapshot().take!.settings.sensitivity).toBe(0.5);
    });

    it('a failed save puts the stored value back', async () => {
      const { h, session } = await open();
      vi.mocked(h.deps.db.patchTake).mockRejectedValueOnce(new AppError('storage-full', 'full'));
      await session.setSettings({ sensitivity: 0.8 });
      expect(session.getSnapshot().take!.settings.sensitivity).toBe(0.5);
    });
  });

  describe('reanalyse', () => {
    it('merges: the locked note kept exactly, near ones and deleted times dropped; one commit; one undo step', async () => {
      const { h, session, events, engine } = await open();
      session.select('P');
      const done = session.reanalyse();
      await settle();
      expect(session.getSnapshot().reanalysis).toEqual({ progress: 0 });
      engine.progress!(0.45);
      expect(session.getSnapshot().reanalysis).toEqual({ progress: 0.45 });
      engine.progress!(0.2); // never backward
      expect(session.getSnapshot().reanalysis).toEqual({ progress: 0.45 });
      engine.run.resolve(
        run(
          [detected(980, 2), detected(1200, 3, 0.4), detected(1530, 1), detected(3000, 30)],
          true,
        ),
      );
      await done;
      expect(h.deps.analysis.reanalyse).toHaveBeenCalledWith(ANALYZED, expect.any(Function));
      const request = vi.mocked(h.deps.mapFrets).mock.calls[0]![1];
      expect(request.locks).toEqual([{ index: 0, string: 1, fret: 7 }]);
      const [id, tab, patch] = vi.mocked(h.deps.db.commitAnalysis).mock.calls[0]!;
      expect(id).toBe('t1');
      // 980 is within 50 ms of the locked note, 1530 of a deleted time; fret 30 has no place.
      expect(tab.notes.map((n) => n.id)).toEqual(['L', 'new2']);
      expect(tab.notes[0]).toBe(LOCKED);
      expect(tab.notes[1]).toMatchObject({
        startMs: 1200,
        fret: 3,
        locked: false,
        lowConfidence: true,
      });
      expect(tab.deletedStartMs).toEqual([1500]);
      expect(patch).toEqual({
        analysisVersion: '0.5.0',
        warnings: { tuningOffsetCents: 4, belowRangeNotes: 0 },
      });
      const snap = session.getSnapshot();
      expect(snap.reanalysis).toBeNull();
      expect(snap.tab!.notes.map((n) => n.id)).toEqual(['L', 'new2']);
      expect(snap.take!.analysisVersion).toBe('0.5.0');
      expect(snap.selectedNoteId).toBeNull(); // its note is gone
      expect(snap.undoLabel).toEqual({ kind: 'reanalyse' });
      expect(h.deps.deleteRaw).toHaveBeenCalledWith('t1'); // read from the raw file
      expect(events).toEqual([{ kind: 'reanalysed', notes: 2 }]);
    });

    it('while it runs, edits, undo and redo do nothing and the labels read null', async () => {
      const { h, session, engine } = await open();
      session.select('P');
      session.typeDigit(5);
      await settle();
      expect(session.getSnapshot().undoLabel).toEqual({ kind: 'setFret', fret: 5 });
      const done = session.reanalyse();
      await settle();
      expect(session.getSnapshot().undoLabel).toBeNull();
      expect(session.canUndo()).toBe(false);
      session.select('P');
      session.typeDigit(9);
      await session.undo();
      await session.deleteSelected();
      await session.setSettings({ sensitivity: 0.9 });
      expect(h.deps.mapFrets).toHaveBeenCalledTimes(1); // the digit before the run only
      expect(h.deps.db.patchTake).not.toHaveBeenCalled();
      engine.run.resolve(run([]));
      await done;
      // A re-analysis does not reset history: the digit's step is still there under it.
      await session.undo();
      await session.undo();
      expect(session.getSnapshot().tab!.notes).toEqual(TAB2.notes);
    });

    it('Cancel: the tab, history and settings stay as they were, and it is announced', async () => {
      const { h, session, events } = await open();
      session.select('P');
      session.typeDigit(5);
      await settle();
      await session.setSettings({ sensitivity: 0.8 });
      const edited = session.getSnapshot().tab;
      const done = session.reanalyse();
      await settle();
      session.cancelReanalysis();
      await done;
      expect(h.deps.analysis.cancel).toHaveBeenCalledWith('t1');
      expect(h.deps.cancel).toHaveBeenCalledWith('t1');
      const snap = session.getSnapshot();
      expect(snap.reanalysis).toBeNull();
      expect(snap.tab).toBe(edited);
      expect(snap.take!.settings).toEqual({ sensitivity: 0.8, minNoteMs: 40, maxFret: 24 });
      expect(snap.undoLabel).toEqual({ kind: 'setFret', fret: 5 });
      expect(session.canUndo()).toBe(true);
      expect(h.deps.db.commitAnalysis).not.toHaveBeenCalled();
      expect(events.at(-1)).toEqual({ kind: 'reanalyseCancelled' });
    });

    it('Cancel while it maps the frets: the fret mapping is cancelled, nothing committed', async () => {
      const { h, session, events, engine } = await open();
      const frets = deferred<Awaited<ReturnType<TakeSessionDeps['mapFrets']>>>();
      vi.mocked(h.deps.mapFrets).mockReturnValueOnce(frets.promise);
      const done = session.reanalyse();
      await settle();
      engine.run.resolve(run([detected(1200, 3)]));
      await settle();
      expect(h.deps.mapFrets).toHaveBeenCalledTimes(1);
      session.cancelReanalysis();
      expect(h.deps.cancel).toHaveBeenCalledWith('t1');
      frets.reject(new AppError('analysis-cancelled', 'cancelled'));
      await done;
      expect(h.deps.db.commitAnalysis).not.toHaveBeenCalled();
      expect(session.getSnapshot()).toMatchObject({ reanalysis: null, tab: TAB2, undoLabel: null });
      expect(events).toEqual([{ kind: 'reanalyseCancelled' }]);
    });

    it('the take deleted while it runs: cleared, nothing committed', async () => {
      const { h, session, engine } = await open();
      const done = session.reanalyse();
      await settle();
      h.emit({ type: 'take-deleted', takeId: 't1', writer: 'library-session' });
      expect(session.getSnapshot()).toMatchObject({ reanalysis: null, missing: true });
      engine.run.resolve(run([detected(1200, 3)]));
      await done;
      expect(h.deps.db.commitAnalysis).not.toHaveBeenCalled();
      expect(session.getSnapshot()).toMatchObject({ reanalysis: null, tab: null });
    });

    it('the commit failing storage-full: nothing changes, announced with its code, no undo step', async () => {
      const { h, session, events, engine } = await open();
      vi.mocked(h.deps.db.commitAnalysis).mockRejectedValueOnce(new AppError('storage-full', 'x'));
      const done = session.reanalyse();
      await settle();
      engine.run.resolve(run([detected(1200, 3)]));
      await expect(done).rejects.toMatchObject({ code: 'storage-full' });
      expect(session.getSnapshot()).toMatchObject({ reanalysis: null, tab: TAB2, undoLabel: null });
      expect(events).toEqual([{ kind: 'reanalyseFailed', code: 'storage-full' }]);
    });

    it('queued behind other work: shown as running at once; edits meanwhile do nothing', async () => {
      const { h, session, engine } = await open();
      const frets = deferred<Awaited<ReturnType<TakeSessionDeps['mapFrets']>>>();
      vi.mocked(h.deps.mapFrets).mockReturnValueOnce(frets.promise);
      session.select('P');
      session.typeDigit(5); // in flight on the engine
      await settle();
      const done = session.reanalyse();
      expect(session.getSnapshot().reanalysis).toEqual({ progress: 0 });
      expect(session.getSnapshot().undoLabel).toBeNull();
      session.typeDigit(7);
      await session.deleteSelected();
      frets.resolve([
        { string: 1, fret: 7 },
        { string: 1, fret: 5 },
      ]);
      await settle();
      expect(h.deps.analysis.reanalyse).toHaveBeenCalledTimes(1);
      engine.run.resolve(run([]));
      await done;
      // The digit before the click applied; the ones after did nothing.
      expect(session.getSnapshot().tab!.notes.find((n) => n.id === 'P')).toMatchObject({
        fret: 5,
        locked: true,
      });
      expect(h.deps.mapFrets).toHaveBeenCalledTimes(2); // the digit, then the re-analysis
    });

    it('cancelled while queued: it never runs', async () => {
      const { h, session, events } = await open();
      const frets = deferred<Awaited<ReturnType<TakeSessionDeps['mapFrets']>>>();
      vi.mocked(h.deps.mapFrets).mockReturnValueOnce(frets.promise);
      session.select('P');
      session.typeDigit(5);
      await settle();
      const done = session.reanalyse();
      session.cancelReanalysis();
      expect(session.getSnapshot().reanalysis).toBeNull();
      frets.resolve([
        { string: 1, fret: 7 },
        { string: 1, fret: 5 },
      ]);
      await done;
      expect(h.deps.analysis.reanalyse).not.toHaveBeenCalled();
      expect(events).toContainEqual({ kind: 'reanalyseCancelled' });
    });

    it('a pending edit save never lands after a fast re-analysis commit', async () => {
      const { h, session, engine } = await open();
      vi.useFakeTimers();
      try {
        session.select('P');
        session.typeDigit(5);
        await vi.advanceTimersByTimeAsync(0);
        expect(session.getSnapshot().undoLabel).toEqual({ kind: 'setFret', fret: 5 });
        const done = session.reanalyse(); // within the 300 ms save debounce
        await vi.advanceTimersByTimeAsync(0);
        engine.run.resolve(run([detected(1200, 3)]));
        await done;
        expect(h.deps.db.commitAnalysis).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(h.deps.putTab).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('a failed restore commit with an unsaved edit: the edit is saved afterwards', async () => {
      const { h, session, engine } = await open();
      const done = session.reanalyse();
      await settle();
      engine.run.resolve(run([detected(1200, 3)]));
      await done;
      vi.useFakeTimers();
      try {
        session.select('L');
        session.typeDigit(9);
        await vi.advanceTimersByTimeAsync(400); // saved
        expect(h.deps.putTab).toHaveBeenCalledTimes(1);
        void session.undo(); // the edit: unsaved again, its save pending
        await vi.advanceTimersByTimeAsync(0);
        const shown = session.getSnapshot().tab;
        vi.mocked(h.deps.db.commitAnalysis).mockRejectedValueOnce(
          new AppError('storage-full', 'x'),
        );
        void session.undo(); // the re-analysis: its commit fails
        await vi.advanceTimersByTimeAsync(0);
        expect(session.getSnapshot().undoLabel).toEqual({ kind: 'reanalyse' });
        await vi.advanceTimersByTimeAsync(400);
        expect(h.deps.putTab).toHaveBeenCalledTimes(2);
        expect(vi.mocked(h.deps.putTab).mock.calls[1]![0]).toBe(shown);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a raw-only take whose raw file is not checked yet: not refused; analysis decides', async () => {
      const h0 = harness({ ...ANALYZED, audioMime: null }, TAB2);
      vi.mocked(h0.deps.hasRaw).mockReturnValue(new Promise<boolean>(() => {}));
      vi.mocked(h0.deps.analysis.reanalyse).mockReturnValue(new Promise<never>(() => {}));
      const session = createTakeSession('t1', h0.deps);
      opened.push(session);
      session.subscribe(() => {});
      await settle();
      expect(session.getSnapshot().hasRaw).toBeNull();
      expect(hasAudio(session.getSnapshot())).toBe(true);
      void session.reanalyse();
      await settle();
      expect(h0.deps.analysis.reanalyse).toHaveBeenCalledTimes(1);
    });

    it('a failure leaves everything as it was, announced; the call rejects with its code', async () => {
      const { h, session, events, engine } = await open();
      const done = session.reanalyse();
      await settle();
      engine.run.reject(new AppError('analysis-failed', 'boom'));
      await expect(done).rejects.toMatchObject({ code: 'analysis-failed' });
      expect(session.getSnapshot()).toMatchObject({ reanalysis: null, tab: TAB2 });
      expect(h.deps.db.commitAnalysis).not.toHaveBeenCalled();
      expect(events).toEqual([{ kind: 'reanalyseFailed', code: 'analysis-failed' }]);
    });

    it('no audio (audioMime null, no raw file): rejects audio-missing, announced, no engine call', async () => {
      const { h, session, events } = await open(TAB2, { ...ANALYZED, audioMime: null });
      expect(hasAudio(session.getSnapshot())).toBe(false);
      await expect(session.reanalyse()).rejects.toMatchObject({ code: 'audio-missing' });
      expect(h.deps.analysis.reanalyse).not.toHaveBeenCalled();
      expect(events).toEqual([{ kind: 'reanalyseFailed', code: 'audio-missing' }]);
    });

    it('no compressed audio but a raw file: it runs', async () => {
      const { h, session } = await open(TAB2, { ...ANALYZED, audioMime: null }, true);
      expect(session.getSnapshot().hasRaw).toBe(true);
      expect(hasAudio(session.getSnapshot())).toBe(true);
      void session.reanalyse();
      await settle();
      expect(h.deps.analysis.reanalyse).toHaveBeenCalledTimes(1);
    });

    it('undo restores the previous tab with the analysed-with settings, warnings and version; redo the new', async () => {
      const take: Take = { ...ANALYZED, warnings: { tuningOffsetCents: -2, belowRangeNotes: 1 } };
      const { h, session, events, engine } = await open(TAB2, take);
      await session.setSettings({ sensitivity: 0.8 });
      const done = session.reanalyse();
      await settle();
      engine.run.resolve(run([detected(500, 2)]));
      await done;
      const after = session.getSnapshot();
      await session.undo();
      const [, tab, patch] = vi.mocked(h.deps.db.commitAnalysis).mock.calls[1]!;
      expect({ notes: tab.notes, deletedStartMs: tab.deletedStartMs }).toEqual({
        notes: TAB2.notes,
        deletedStartMs: [1500],
      });
      expect(patch).toEqual({
        settings: { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 }, // as the old tab was analysed
        trimStartMs: 0,
        trimEndMs: null,
        warnings: { tuningOffsetCents: -2, belowRangeNotes: 1 },
        analysisVersion: '0.4.0',
      });
      expect(session.getSnapshot().tab!.notes).toEqual(TAB2.notes);
      expect(session.getSnapshot().take!.settings.sensitivity).toBe(0.5);
      expect(session.getSnapshot().redoLabel).toEqual({ kind: 'reanalyse' });
      await session.redo();
      const [, redoTab, redoPatch] = vi.mocked(h.deps.db.commitAnalysis).mock.calls[2]!;
      expect(redoTab.notes).toEqual(after.tab!.notes);
      expect(redoPatch).toMatchObject({
        settings: { sensitivity: 0.8, minNoteMs: 40, maxFret: 24 },
        analysisVersion: '0.5.0',
        warnings: { tuningOffsetCents: 4, belowRangeNotes: 0 },
      });
      expect(session.getSnapshot().take!.settings.sensitivity).toBe(0.8);
      expect(events.slice(-2)).toEqual([
        { kind: 'undo', label: { kind: 'reanalyse' } },
        { kind: 'redo', label: { kind: 'reanalyse' } },
      ]);
    });

    it('a failed restore keeps the history and announces the failure', async () => {
      const { h, session, events, engine } = await open();
      const done = session.reanalyse();
      await settle();
      engine.run.resolve(run([]));
      await done;
      vi.mocked(h.deps.db.commitAnalysis).mockRejectedValueOnce(new AppError('storage-full', 'x'));
      await session.undo();
      expect(session.getSnapshot().undoLabel).toEqual({ kind: 'reanalyse' });
      expect(events.at(-1)).toEqual({ kind: 'failed' });
    });

    it('No notes found: notes appear; undo returns to the empty tab', async () => {
      const { session, engine } = await open({ ...TAB, notes: [], deletedStartMs: [] });
      expect(isTabShown(session.getSnapshot())).toBe(false);
      const done = session.reanalyse();
      await settle();
      engine.run.resolve(run([detected(100, 0), detected(400, 2)]));
      await done;
      expect(isTabShown(session.getSnapshot())).toBe(true);
      expect(session.getSnapshot().tab!.notes).toHaveLength(2);
      await session.undo();
      expect(session.getSnapshot().tab!.notes).toEqual([]);
    });

    it('a second call while one runs does nothing', async () => {
      const { h, session } = await open();
      void session.reanalyse();
      await settle();
      await session.reanalyse();
      expect(h.deps.analysis.reanalyse).toHaveBeenCalledTimes(1);
    });
  });
});
