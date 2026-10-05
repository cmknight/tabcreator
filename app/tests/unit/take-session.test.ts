import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/model/errors';
import type { Note, Tab, Take } from '../../src/model/types';
import type { AnalysisOutcome, ProgressListener } from '../../src/session/analysis';
import {
  activeTakeSession,
  capTitle,
  createTakeSession,
  setActiveTakeSession,
  type TakeSessionDeps,
} from '../../src/session/take-session';
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
      patchTake: vi.fn(async (_id: string, patch: Partial<Take>) => ({ ...take!, ...patch })),
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
      selectedNoteId: null,
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
