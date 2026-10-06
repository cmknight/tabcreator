import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandLabel } from '../../src/model/edit-history';
import type { AppErrorCode } from '../../src/model/errors';
import type { Note, Tab as TabRecord, Take } from '../../src/model/types';
import { layoutTab } from '../../src/model/tab-render';
import {
  activeTakeSession,
  type EditEvent,
  type TakeSession,
  type TakeSnapshot,
} from '../../src/session/take-session';
import { activePlayback } from '../../src/session/playback';
import { noteLabels, TabArea } from '../../src/ui/components/TabArea';
import { REFIT_FADE_MS, REFIT_HOLD_MS, Tab } from '../../src/ui/screens/Tab';
import { announce } from '../../src/ui/a11y/announcer';
import { reloadOrExplain } from '../../src/ui/reload-or-explain';
import { dispatchShortcut } from '../../src/ui/a11y/shortcuts';
import { strings } from '../../src/ui/strings';
import { dismissToast, getToast } from '../../src/ui/toast';
import type { SettingsSnapshot } from '../../src/session/settings-session';

vi.mock('../../src/ui/a11y/announcer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ui/a11y/announcer')>()),
  announce: vi.fn(),
}));
vi.mock('../../src/ui/reload-or-explain', () => ({ reloadOrExplain: vi.fn() }));

// Story 5.6: the Tab screen's states from a mocked take session: loading, analysing (progress),
// the tab as <pre> systems, failed and missing.

const TAKE: Take = {
  id: 't1',
  title: 'Take 3',
  createdAt: '2026-10-04T10:00:00.000Z',
  status: 'analyzed',
  durationMs: 4_000,
  sampleRate: 48_000,
  tuning: 'EADGBE',
  micLabel: 'Mic',
  audioMime: 'audio/webm;codecs=opus',
  trimStartMs: 0,
  trimEndMs: null,
  settings: { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 },
  analysisVersion: '0.4.0',
  updatedAt: '2026-10-04T10:00:04.000Z',
};

const note = (i: number, string: Note['string'], fret: number): Note => ({
  id: `n${i}`,
  startMs: i * 250,
  endMs: i * 250 + 200,
  midi: 60,
  confidence: 0.9,
  string,
  fret,
  locked: false,
  lowConfidence: false,
});

/**
 * A snapshot; `selectedNoteId`, `lastFocusedNoteId`, `saveFailed`, `undoLabel`, `redoLabel` and
 * `reanalysis` default to null, `hasRaw` to false.
 */
type Snap = Omit<
  TakeSnapshot,
  | 'selectedNoteId'
  | 'lastFocusedNoteId'
  | 'saveFailed'
  | 'undoLabel'
  | 'redoLabel'
  | 'reanalysis'
  | 'hasRaw'
> & {
  selectedNoteId?: string | null;
  lastFocusedNoteId?: string | null;
  saveFailed?: TakeSnapshot['saveFailed'];
  undoLabel?: TakeSnapshot['undoLabel'];
  redoLabel?: TakeSnapshot['redoLabel'];
  reanalysis?: TakeSnapshot['reanalysis'];
  hasRaw?: boolean | null;
};

function mockSession(initial: Snap) {
  let snapshot: TakeSnapshot = {
    selectedNoteId: null,
    lastFocusedNoteId: null,
    saveFailed: null,
    undoLabel: null,
    redoLabel: null,
    reanalysis: null,
    hasRaw: false,
    ...initial,
  };
  const listeners = new Set<() => void>();
  const editListeners = new Set<(event: EditEvent) => void>();
  const session: TakeSession = {
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    getSnapshot: () => snapshot,
    dispose: vi.fn(),
    flush: () => Promise.resolve(),
    cancel: vi.fn(),
    analyse: vi.fn(),
    retryCommit: vi.fn(),
    select: vi.fn((id: string | null) => {
      snapshot = { ...snapshot, selectedNoteId: id };
      listeners.forEach((l) => l());
    }),
    focusNote: vi.fn((id: string) => {
      snapshot = { ...snapshot, lastFocusedNoteId: id };
      listeners.forEach((l) => l());
    }),
    selectNext: vi.fn(),
    selectPrev: vi.fn(),
    selectNextFlagged: vi.fn(),
    rename: vi.fn(() => Promise.resolve()),
    retrySave: vi.fn(),
    apply: vi.fn(() => Promise.resolve()),
    setFret: vi.fn(() => Promise.resolve()),
    typeDigit: vi.fn(),
    undo: vi.fn(() => Promise.resolve()),
    redo: vi.fn(() => Promise.resolve()),
    canUndo: () => false,
    canRedo: () => false,
    moveString: vi.fn(() => Promise.resolve()),
    moveStringBy: vi.fn(() => Promise.resolve()),
    deleteSelected: vi.fn(() => Promise.resolve()),
    insert: vi.fn(() => Promise.resolve()),
    confirm: vi.fn(() => Promise.resolve()),
    setSettings: vi.fn(() => Promise.resolve()),
    reanalyse: vi.fn(() => Promise.resolve()),
    trim: vi.fn(() => Promise.resolve()),
    resetTrim: vi.fn(() => Promise.resolve()),
    cancelReanalysis: vi.fn(),
    onEditEvent: vi.fn((listener: (event: EditEvent) => void) => {
      editListeners.add(listener);
      return () => {
        editListeners.delete(listener);
      };
    }),
  };
  /** Sends an edit outcome to the screen. */
  const edit = (event: EditEvent) => act(() => editListeners.forEach((l) => l(event)));
  /** Publishes a new snapshot to the screen. */
  const set = (next: Partial<TakeSnapshot>) =>
    act(() => {
      snapshot = { ...snapshot, ...next };
      listeners.forEach((l) => l());
    });
  return { session, create: vi.fn(() => session), set, edit };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Tab screen', () => {
  it('loading: the screen title, nothing else', () => {
    const { create } = mockSession({
      take: null,
      tab: null,
      loading: true,
      analysis: { kind: 'idle' },
    });
    const { container } = render(<Tab takeId="t1" createSession={create} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(strings['tab.title']);
    expect(container.querySelector('[data-take-id="t1"]')).not.toBeNull();
    expect(container.querySelector('pre')).toBeNull();
    expect(create).toHaveBeenCalledWith('t1');
  });

  it('analysing: the take title and a labelled progress bar', () => {
    const { create } = mockSession({
      take: { ...TAKE, status: 'recorded' },
      tab: null,
      loading: false,
      analysis: { kind: 'running', progress: 0.45 },
    });
    render(<Tab takeId="t1" createSession={create} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Take 3');
    const bar = screen.getByRole('progressbar', { name: strings['tab.analysing'] });
    expect(bar.getAttribute('max')).toBe('1');
    expect((bar as HTMLProgressElement).value).toBeCloseTo(0.45);
  });

  it('analysed: one <pre> per system, the six lines joined by newlines', () => {
    const notes = Array.from({ length: 40 }, (_, i) => note(i, 1, i % 13));
    const tab: TabRecord = { takeId: 't1', notes, updatedAt: TAKE.updatedAt, deletedStartMs: [] };
    const { create } = mockSession({ take: TAKE, tab, loading: false, analysis: { kind: 'idle' } });
    const { container } = render(<Tab takeId="t1" createSession={create} />);
    const pres = [...container.querySelectorAll('pre')];
    expect(pres.length).toBeGreaterThan(1);
    for (const pre of pres) {
      const lines = pre.textContent!.split('\n');
      expect(lines).toHaveLength(6);
      expect(lines[0]!.startsWith('e|')).toBe(true);
      expect(lines[5]!.startsWith('E|')).toBe(true);
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
    }
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('failed: the failure banner with Retry only, no progress', () => {
    const { create, session } = mockSession({
      take: { ...TAKE, status: 'recorded' },
      tab: null,
      loading: false,
      analysis: { kind: 'failed', code: 'analysis-failed' },
    });
    render(<Tab takeId="t1" createSession={create} />);
    expect(screen.getByText(strings['tab.analysisFailed'])).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    // Retry, and the header's Rename take: nothing else.
    expect(
      screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent),
    ).toEqual([strings['tab.retry'], strings['tab.rename']]);
    fireEvent.click(screen.getByRole('button', { name: strings['tab.retry'] }));
    expect(session.analyse).toHaveBeenCalledTimes(1);
  });

  it('missing: "Take not found"', () => {
    const { create } = mockSession({
      take: null,
      tab: null,
      loading: false,
      analysis: { kind: 'idle' },
      missing: true,
    });
    render(<Tab takeId="t1" createSession={create} />);
    expect(screen.getByText(strings['tab.notFound'])).toBeTruthy();
  });

  it('disposes its session on unmount', () => {
    const { session, create } = mockSession({
      take: null,
      tab: null,
      loading: true,
      analysis: { kind: 'idle' },
    });
    const { unmount } = render(<Tab takeId="t1" createSession={create} />);
    unmount();
    expect(session.dispose).toHaveBeenCalled();
  });
});

// Story 5.7 (US-4.5, EXPERIENCE.md Analysis progress and the Tab states).
describe('Tab screen analysis states', () => {
  const RECORDED: Take = { ...TAKE, status: 'recorded' };
  const runningAt = (progress: number): Snap => ({
    take: RECORDED,
    tab: null,
    loading: false,
    analysis: { kind: 'running', progress },
  });
  const failed = (code: AppErrorCode): Snap => ({
    take: RECORDED,
    tab: null,
    loading: false,
    analysis: { kind: 'failed', code },
  });

  it('analysing: the percentage beside the bar, and Cancel', () => {
    const { create, session } = mockSession(runningAt(0.456));
    render(<Tab takeId="t1" createSession={create} />);
    expect(screen.getByTestId('tab-analysis-percent').textContent).toBe('45%');
    const bar = screen.getByRole('progressbar', { name: strings['tab.analysing'] });
    expect(bar.getAttribute('aria-valuetext')).toBe('45%');
    expect(screen.getByText(strings['tab.analysing'])).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: strings['tab.cancel'] }));
    expect(session.cancel).toHaveBeenCalledTimes(1);
  });

  it('progress announcements: once per quarter crossed, per run', () => {
    const { create, set } = mockSession(runningAt(0));
    render(<Tab takeId="t1" createSession={create} />);
    for (const p of [0.1, 0.25, 0.3, 0.45, 0.5, 0.74, 0.75, 0.9, 1, 1]) set(runningAt(p));
    expect(vi.mocked(announce).mock.calls).toEqual([
      ['Analysing, 25%'],
      ['Analysing, 50%'],
      ['Analysing, 75%'],
      ['Analysing, 100%'],
    ]);
    // A new run (after a failure) announces again; a jump announces the highest quarter only.
    set(failed('analysis-failed'));
    set(runningAt(0));
    set(runningAt(0.6));
    // The failure banner's assertive announcement sits between the two runs.
    expect(vi.mocked(announce).mock.calls.slice(4)).toEqual([
      [strings['tab.analysisFailed'], 'assertive'],
      ['Analysing, 50%'],
    ]);
  });

  it('the bar shows the floor of the percentage', () => {
    const { create } = mockSession(runningAt(0.29));
    render(<Tab takeId="t1" createSession={create} />);
    expect(screen.getByTestId('tab-analysis-percent').textContent).toBe('29%');
  });

  it('cancelled: Analyse takes the focus; it analyses again', () => {
    const { create, session, set } = mockSession(runningAt(0.3));
    render(<Tab takeId="t1" createSession={create} />);
    screen.getByRole('button', { name: strings['tab.cancel'] }).focus();
    set({ analysis: { kind: 'cancelled' } });
    const analyse = screen.getByRole('button', { name: strings['tab.analyse'] });
    expect(document.activeElement).toBe(analyse);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByTestId('tab-analysis-failed')).toBeNull();
    fireEvent.click(analyse);
    expect(session.analyse).toHaveBeenCalledTimes(1);
  });

  it.each<AppErrorCode>(['analysis-failed', 'audio-missing', 'storage-failed'])(
    '%s: the Analysis failed banner, announced assertively, with Retry',
    (code) => {
      const { create, session } = mockSession(failed(code));
      render(<Tab takeId="t1" createSession={create} />);
      const banner = screen.getByTestId('tab-analysis-failed');
      expect(banner.textContent).toContain(strings['tab.analysisFailed']);
      // Not a live region (AD-18): the shared announcer speaks it, once.
      expect(banner.getAttribute('role')).toBeNull();
      expect(banner.getAttribute('aria-live')).toBeNull();
      expect(vi.mocked(announce).mock.calls).toEqual([
        [strings['tab.analysisFailed'], 'assertive'],
      ]);
      fireEvent.click(screen.getByRole('button', { name: strings['tab.retry'] }));
      expect(session.analyse).toHaveBeenCalledTimes(1);
      expect(session.retryCommit).not.toHaveBeenCalled();
    },
  );

  it('engine-unavailable: the engine banner with Reload, no Retry', () => {
    const { create, session } = mockSession(failed('engine-unavailable'));
    render(<Tab takeId="t1" createSession={create} />);
    expect(screen.getByTestId('tab-engine-failed').textContent).toContain(
      strings['global.engineFailed'],
    );
    expect(announce).toHaveBeenCalledWith(strings['global.engineFailed'], 'assertive');
    expect(screen.queryByRole('button', { name: strings['tab.retry'] })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: strings['global.reload'] }));
    expect(reloadOrExplain).toHaveBeenCalledTimes(1);
    expect(session.analyse).not.toHaveBeenCalled();
  });

  it('storage-full: the storage banner, a Library link and Retry, which retries the commit', () => {
    const { create, session } = mockSession(failed('storage-full'));
    render(<Tab takeId="t1" createSession={create} />);
    const alert = screen.getByTestId('tab-storage-full');
    expect(announce).toHaveBeenCalledWith(strings['tab.storageFull'], 'assertive');
    expect(alert.textContent).toContain(
      'Storage is full — delete takes or their audio, or back up and clear',
    );
    const link = screen.getByRole('link', { name: strings['global.goToLibrary'] });
    expect(link.getAttribute('href')).toBe('#/library');
    fireEvent.click(screen.getByRole('button', { name: strings['tab.retry'] }));
    expect(session.retryCommit).toHaveBeenCalledTimes(1);
    expect(session.analyse).not.toHaveBeenCalled();
  });

  // Story "Change a fret and undo it": an edit save that hit a full disk.
  describe('the edit-save storage-full banner', () => {
    const analysed = (saveFailed: TakeSnapshot['saveFailed']) => ({
      take: TAKE,
      tab: { takeId: 't1', notes: [note(0, 1, 0)], updatedAt: TAKE.updatedAt, deletedStartMs: [] },
      loading: false,
      analysis: { kind: 'idle' as const },
      saveFailed,
    });

    it('shows with the tab, announced once, with a Library link and Retry, which saves again', () => {
      const { create, session, set } = mockSession(analysed('storage-full'));
      render(<Tab takeId="t1" createSession={create} />);
      const alert = screen.getByTestId('tab-edit-storage-full');
      expect(alert.textContent).toContain(strings['tab.storageFull']);
      expect(screen.getByRole('link', { name: strings['global.goToLibrary'] })).toBeTruthy();
      expect(screen.getByRole('application', { name: 'Tab' })).toBeTruthy(); // the tab stays
      expect(vi.mocked(announce).mock.calls).toEqual([[strings['tab.storageFull'], 'assertive']]);
      fireEvent.click(screen.getByRole('button', { name: strings['tab.retry'] }));
      expect(session.retrySave).toHaveBeenCalledTimes(1);
      expect(session.retryCommit).not.toHaveBeenCalled();
      set({ saveFailed: null });
      expect(screen.queryByTestId('tab-edit-storage-full')).toBeNull();
    });

    it('is absent while saves succeed', () => {
      const { create } = mockSession(analysed(null));
      render(<Tab takeId="t1" createSession={create} />);
      expect(screen.queryByTestId('tab-edit-storage-full')).toBeNull();
    });
  });

  it('after undo or redo, focus on a note follows the selection to the step’s note', () => {
    const notes = [note(0, 1, 0), note(1, 2, 1)];
    const { create, session } = mockSession({
      take: TAKE,
      tab: { takeId: 't1', notes, updatedAt: TAKE.updatedAt, deletedStartMs: [] },
      loading: false,
      analysis: { kind: 'idle' },
    });
    const { container } = render(<Tab takeId="t1" createSession={create} />);
    const button = (id: string) =>
      container.querySelector<HTMLButtonElement>(`[data-note-id="${id}"]`)!;
    act(() => button('n0').focus());
    expect(document.activeElement).toBe(button('n0'));
    const listener = vi.mocked(session.onEditEvent).mock.calls.at(-1)![0];
    // The session selects the step's note and emits the undo, before the screen re-renders.
    act(() => {
      session.select('n1');
      listener({ kind: 'undo', label: { kind: 'setFret', fret: 5 } });
      expect(document.activeElement).toBe(button('n1'));
    });
    expect(document.activeElement).toBe(button('n1'));
    // Focus elsewhere (the body) is left where it is.
    act(() => (document.activeElement as HTMLElement).blur());
    act(() => listener({ kind: 'redo', label: { kind: 'setFret', fret: 5 } }));
    expect(document.activeElement).toBe(document.body);
  });

  it('announces edits politely, undo and redo with their label, a failed edit assertively', () => {
    const { create, edit } = mockSession({
      take: TAKE,
      tab: { takeId: 't1', notes: [note(0, 1, 0)], updatedAt: TAKE.updatedAt, deletedStartMs: [] },
      loading: false,
      analysis: { kind: 'idle' },
    });
    render(<Tab takeId="t1" createSession={create} />);
    vi.mocked(announce).mockClear();
    edit({ kind: 'edit', label: { kind: 'setFret', fret: 5 }, string: 3, fret: 5, refingered: [] });
    edit({ kind: 'undo', label: { kind: 'setFret', fret: 5 } });
    edit({ kind: 'redo', label: { kind: 'setFret', fret: 12 } });
    edit({ kind: 'failed' });
    expect(vi.mocked(announce).mock.calls).toEqual([
      ['Fret 5 on the G string', 'polite'],
      ['Undid Set fret 5', 'polite'],
      ['Redid Set fret 12', 'polite'],
      [strings['tab.editFailed'], 'assertive'],
    ]);
  });

  it('announces a string move, a delete, an insert and a confirm; undo names them', () => {
    const { create, edit } = mockSession({
      take: TAKE,
      tab: { takeId: 't1', notes: [note(0, 1, 0)], updatedAt: TAKE.updatedAt, deletedStartMs: [] },
      loading: false,
      analysis: { kind: 'idle' },
    });
    render(<Tab takeId="t1" createSession={create} />);
    vi.mocked(announce).mockClear();
    edit({
      kind: 'edit',
      label: { kind: 'moveString', string: 3, fret: 7 },
      string: 3,
      fret: 7,
      refingered: [],
    });
    edit({ kind: 'edit', label: { kind: 'delete' }, string: 2, fret: 1, refingered: [] });
    edit({ kind: 'edit', label: { kind: 'insert' }, string: 3, fret: 0, refingered: [] });
    edit({ kind: 'edit', label: { kind: 'confirm' }, string: 2, fret: 1, refingered: [] });
    edit({ kind: 'undo', label: { kind: 'moveString', string: 3, fret: 7 } });
    edit({ kind: 'undo', label: { kind: 'delete' } });
    edit({ kind: 'redo', label: { kind: 'insert' } });
    edit({ kind: 'redo', label: { kind: 'confirm' } });
    expect(vi.mocked(announce).mock.calls).toEqual([
      ['Moved to G string, fret 7', 'polite'],
      ['Note deleted', 'polite'],
      ['Note inserted on the G string, fret 0', 'polite'],
      ['Note confirmed', 'polite'],
      ['Undid Move to string 3', 'polite'],
      ['Undid Delete note', 'polite'],
      ['Redid Insert note', 'polite'],
      ['Redid Confirm note', 'polite'],
    ]);
  });

  // Story "Re-fit feedback": the re-fingered notes' outline, its timer, and the announcement.
  describe('re-fit feedback', () => {
    const tab: TabRecord = {
      takeId: 't1',
      notes: [note(0, 1, 0), note(1, 2, 1), note(2, 3, 2), note(3, 4, 3)],
      updatedAt: TAKE.updatedAt,
      deletedStartMs: [],
    };
    const moved = (refingered: string[], label: CommandLabel = { kind: 'setFret', fret: 5 }) =>
      ({ kind: 'edit', label, string: 3, fret: 5, refingered }) as const;
    const refitted = () =>
      [...document.querySelectorAll('[data-refit]')].map((el) => [
        el.getAttribute('data-note-id'),
        el.getAttribute('data-refit'),
      ]);
    const button = (id: string) => document.querySelector<HTMLElement>(`[data-note-id="${id}"]`)!;

    function setup(selectedNoteId: string | null = null) {
      vi.useFakeTimers();
      const mock = mockSession({
        take: TAKE,
        tab,
        loading: false,
        analysis: { kind: 'idle' },
        selectedNoteId,
      });
      const view = render(<Tab takeId="t1" createSession={mock.create} />);
      vi.mocked(announce).mockClear();
      return { ...mock, ...view };
    }

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it('two moved: both outlined 1.5 s, then fading, then gone; announced after the edit', () => {
      const { edit } = setup();
      edit(moved(['n1', 'n2']));
      expect(refitted()).toEqual([
        ['n1', 'true'],
        ['n2', 'true'],
      ]);
      expect(button('n1').className).toMatch(/refit/);
      expect(button('n0').className).not.toMatch(/refit/);
      expect(vi.mocked(announce).mock.calls).toEqual([
        ['Fret 5 on the G string', 'polite'],
        ['2 nearby notes re-fingered'],
      ]);
      act(() => vi.advanceTimersByTime(REFIT_HOLD_MS - 1));
      expect(refitted()).toEqual([
        ['n1', 'true'],
        ['n2', 'true'],
      ]);
      act(() => vi.advanceTimersByTime(1));
      expect(refitted()).toEqual([
        ['n1', 'fading'],
        ['n2', 'fading'],
      ]);
      expect(button('n1').className).toMatch(/refitFading/);
      act(() => vi.advanceTimersByTime(REFIT_FADE_MS));
      expect(refitted()).toEqual([]);
      expect(button('n1').className).not.toMatch(/refit/);
    });

    it('a trim committing clears the outline (story "Trim")', () => {
      const { edit } = setup();
      edit(moved(['n1']));
      expect(refitted()).toEqual([['n1', 'true']]);
      edit({ kind: 'trimmed', reset: false, notes: 4 });
      expect(refitted()).toEqual([]);
    });

    it('one moved: "1 nearby note re-fingered"', () => {
      const { edit } = setup();
      edit(moved(['n2']));
      expect(refitted()).toEqual([['n2', 'true']]);
      expect(vi.mocked(announce).mock.calls.at(-1)).toEqual(['1 nearby note re-fingered']);
    });

    it('none moved: no outline, no re-fit announcement', () => {
      const { edit } = setup();
      edit(moved([]));
      expect(refitted()).toEqual([]);
      expect(vi.mocked(announce).mock.calls).toEqual([['Fret 5 on the G string', 'polite']]);
    });

    it('a delete: its moved neighbours outlined and counted', () => {
      const { edit } = setup();
      edit(moved(['n0', 'n2'], { kind: 'delete' }));
      expect(refitted().map(([id]) => id)).toEqual(['n0', 'n2']);
      expect(vi.mocked(announce).mock.calls).toEqual([
        ['Note deleted', 'polite'],
        ['2 nearby notes re-fingered'],
      ]);
    });

    it('back to back: the second re-fit replaces the set and restarts the timer', () => {
      const { edit } = setup();
      edit(moved(['n1', 'n2']));
      act(() => vi.advanceTimersByTime(1000));
      edit(moved(['n3']));
      expect(refitted()).toEqual([['n3', 'true']]);
      act(() => vi.advanceTimersByTime(REFIT_HOLD_MS - 1));
      expect(refitted()).toEqual([['n3', 'true']]);
      act(() => vi.advanceTimersByTime(1 + REFIT_FADE_MS));
      expect(refitted()).toEqual([]);
    });

    it('a following edit that moves none clears the outline', () => {
      const { edit } = setup();
      edit(moved(['n1']));
      edit(moved([]));
      expect(refitted()).toEqual([]);
    });

    it('an edit that changed nothing (no re-fingered list) leaves the outline and its timer', () => {
      const { edit } = setup();
      edit(moved(['n1']));
      act(() => vi.advanceTimersByTime(1000));
      edit({ kind: 'edit', label: { kind: 'setFret', fret: 5 }, string: 3, fret: 5 });
      expect(refitted()).toEqual([['n1', 'true']]);
      expect(vi.mocked(announce).mock.calls.at(-1)).toEqual(['Fret 5 on the G string', 'polite']);
      act(() => vi.advanceTimersByTime(REFIT_HOLD_MS - 1000 + REFIT_FADE_MS));
      expect(refitted()).toEqual([]);
    });

    it('a failed edit clears the outline', () => {
      const { edit } = setup();
      edit(moved(['n1', 'n2']));
      edit({ kind: 'failed' });
      expect(refitted()).toEqual([]);
    });

    it('undo and redo clear the outline and outline nothing; the selection is the step’s note', () => {
      const { edit, session } = setup();
      edit(moved(['n1', 'n2']));
      act(() => session.select('n3'));
      edit({ kind: 'undo', label: { kind: 'setFret', fret: 5 } });
      expect(refitted()).toEqual([]);
      expect(button('n3').getAttribute('aria-pressed')).toBe('true');
      edit({ kind: 'redo', label: { kind: 'setFret', fret: 5 } });
      expect(refitted()).toEqual([]);
      expect(vi.mocked(announce).mock.calls.map(([m]) => m)).not.toContain(
        '1 nearby note re-fingered',
      );
      act(() => vi.advanceTimersByTime(REFIT_HOLD_MS + REFIT_FADE_MS));
      expect(refitted()).toEqual([]);
    });

    it('reduced motion: the outline disappears at 1.5 s without fading', () => {
      vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }));
      const { edit } = setup();
      edit(moved(['n1']));
      act(() => vi.advanceTimersByTime(REFIT_HOLD_MS - 1));
      expect(refitted()).toEqual([['n1', 'true']]);
      act(() => vi.advanceTimersByTime(1));
      expect(refitted()).toEqual([]);
    });

    it('a selected re-fingered note shows both the selection and the re-fit outline', () => {
      const { edit } = setup('n1');
      edit(moved(['n1']));
      expect(button('n1').getAttribute('aria-pressed')).toBe('true');
      expect(button('n1').getAttribute('data-refit')).toBe('true');
      expect(button('n1').className).toMatch(/refit/);
    });

    it('the label is unchanged by the outline', () => {
      const { edit } = setup();
      const before = button('n1').getAttribute('aria-label');
      edit(moved(['n1']));
      expect(button('n1').getAttribute('aria-label')).toBe(before);
    });

    it('the take going missing clears the outline; it does not come back', () => {
      const { edit, set } = setup();
      edit(moved(['n1']));
      set({ missing: true });
      set({ missing: undefined });
      expect(refitted()).toEqual([]);
    });

    it('unmounting with the outline shown leaves no timer behind', () => {
      // The timers the screen leaves anyway, without an outline.
      const plain = setup();
      plain.unmount();
      const baseline = vi.getTimerCount();
      vi.clearAllTimers();
      const { edit, unmount } = setup();
      edit(moved(['n1']));
      unmount();
      expect(vi.getTimerCount()).toBe(baseline);
    });
  });

  it('the banner sits above the title', () => {
    const { create } = mockSession(failed('analysis-failed'));
    render(<Tab takeId="t1" createSession={create} />);
    const alert = screen.getByTestId('tab-analysis-failed');
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(alert.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('no notes: "No notes found" and the three tips, no systems', () => {
    const tab: TabRecord = {
      takeId: 't1',
      notes: [],
      updatedAt: TAKE.updatedAt,
      deletedStartMs: [],
    };
    const { create } = mockSession({ take: TAKE, tab, loading: false, analysis: { kind: 'idle' } });
    const { container } = render(<Tab takeId="t1" createSession={create} />);
    expect(screen.getByRole('heading', { name: 'No notes found' })).toBeTruthy();
    const tips = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(tips).toEqual([
      'Check the input level',
      'Play single notes',
      'Raise sensitivity in Analysis settings',
    ]);
    expect(screen.queryByRole('link')).toBeNull();
    expect(container.querySelector('pre')).toBeNull();
  });
});

// Story 5.7 review: saving, and focus when the focused control goes away.
describe('Tab screen saving and focus', () => {
  const RECORDED: Take = { ...TAKE, status: 'recorded' };
  const base = { take: RECORDED, tab: null, loading: false } as const;

  it('saving: "Saving…", no bar, no Cancel, no announcement', () => {
    const { create, set } = mockSession({ ...base, analysis: { kind: 'running', progress: 0.9 } });
    render(<Tab takeId="t1" createSession={create} />);
    vi.mocked(announce).mockClear();
    set({ analysis: { kind: 'running', progress: 1, saving: true } });
    expect(screen.getByTestId('tab-saving').textContent).toBe(strings['tab.saving']);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('button', { name: strings['tab.cancel'] })).toBeNull();
    expect(announce).not.toHaveBeenCalled();
  });

  it('Retry pressed: when the banner goes, focus moves to the h1, not <body>', () => {
    const { create, set } = mockSession({
      ...base,
      analysis: { kind: 'failed', code: 'analysis-failed' },
    });
    render(<Tab takeId="t1" createSession={create} />);
    screen.getByRole('button', { name: strings['tab.retry'] }).focus();
    set({ analysis: { kind: 'running', progress: 0 } });
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
    expect(screen.getByRole('heading', { level: 1 }).getAttribute('tabindex')).toBe('-1');
  });

  it('Analyse pressed: when it goes, focus moves to the h1', () => {
    const { create, set } = mockSession({ ...base, analysis: { kind: 'cancelled' } });
    render(<Tab takeId="t1" createSession={create} />);
    screen.getByRole('button', { name: strings['tab.analyse'] }).focus();
    set({ analysis: { kind: 'running', progress: 0 } });
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
  });

  it('focus outside the screen is left alone', () => {
    const { create, set } = mockSession({ ...base, analysis: { kind: 'running', progress: 0 } });
    render(<Tab takeId="t1" createSession={create} />);
    set({ analysis: { kind: 'failed', code: 'analysis-failed' } });
    expect(document.activeElement).toBe(document.body);
  });
});

// Story "Tab screen, reflow and selection" (US-6.2, US-6.3, US-8.2).
describe('Tab screen tab area, header and selection', () => {
  /** 8 px per character (the probe is 100 characters wide). */
  const CHAR = 8;
  let measureWidth = 400;
  let resize: (() => void) | null = null;

  const rect = (width: number) =>
    ({ width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0 }) as DOMRect;

  beforeEach(() => {
    measureWidth = 400;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.tagName === 'SPAN' && this.textContent === '-'.repeat(100)) return rect(100 * CHAR);
      if (this.parentElement?.getAttribute('role') === 'application' && this.tagName === 'DIV') {
        if (this.getAttribute('aria-hidden') === 'true') return rect(measureWidth);
      }
      return rect(0);
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          resize = cb;
        }
        observe() {}
        disconnect() {
          resize = null;
        }
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // 40 notes, 250 ms apart, over the strings; the 12th in played order is note 11.
  const notes = Array.from({ length: 40 }, (_, i) =>
    i === 11
      ? { ...note(i, 2, 3), midi: 62, startMs: 4250, endMs: 4400 }
      : { ...note(i, ((i % 6) + 1) as Note['string'], i % 13), startMs: i * 375 },
  );
  const TAB40: TabRecord = { takeId: 't1', notes, updatedAt: TAKE.updatedAt, deletedStartMs: [] };
  const analysed = (selectedNoteId: string | null = null) =>
    mockSession({
      take: TAKE,
      tab: TAB40,
      loading: false,
      analysis: { kind: 'idle' },
      selectedNoteId,
    });

  const noteButton = (id: string) =>
    document.querySelector<HTMLButtonElement>(`[data-note-id="${id}"]`)!;

  it('lays the tab out to the measured width; each note button sits over its characters', () => {
    const { create } = analysed();
    render(<Tab takeId="t1" createSession={create} />);
    const area = screen.getByRole('application', { name: 'Tab' });
    // 400 px / 8 px per character (jsdom applies no padding).
    expect(area.getAttribute('data-width-chars')).toBe('50');
    const layout = layoutTab(notes, 50, TAKE.countInBpm);
    const groups = screen.getAllByRole('group', { name: /^Tab system/ });
    expect(groups).toHaveLength(layout.systems.length);
    layout.systems.forEach((system, i) => {
      const group = groups[i]!;
      expect(group.getAttribute('aria-label')).toBe(`Tab system ${i + 1} of ${groups.length}`);
      const pre = group.querySelector('pre')!;
      expect(pre.getAttribute('aria-hidden')).toBe('true');
      expect(pre.textContent).toBe(system.lines.join('\n'));
      for (const line of system.lines) expect(line.length).toBeLessThanOrEqual(50);
      for (const cell of system.cells) {
        const button = group.querySelector<HTMLButtonElement>(`[data-note-id="${cell.noteId}"]`)!;
        expect(parseFloat(button.style.left)).toBeCloseTo(cell.col * CHAR);
        expect(parseFloat(button.style.width)).toBeCloseTo(cell.width * CHAR);
        // No computed line height in jsdom: the 16 px × 1.35 fallback.
        expect(parseFloat(button.style.top)).toBeCloseTo((cell.string - 1) * 21.6);
      }
    });
  });

  it('a narrow area never goes below 20 characters', () => {
    measureWidth = 50;
    const { create } = analysed();
    render(<Tab takeId="t1" createSession={create} />);
    expect(screen.getByRole('application').getAttribute('data-width-chars')).toBe('20');
  });

  it('the area is described by its instructions; every note is labelled', () => {
    const { create } = analysed();
    render(<Tab takeId="t1" createSession={create} />);
    const area = screen.getByRole('application', { name: 'Tab' });
    const described = document.getElementById(area.getAttribute('aria-describedby')!)!;
    expect(described.textContent).toBe(strings['tab.areaInstructions']);
    expect(noteButton('n11').getAttribute('aria-label')).toBe(
      'Note 12: B string, fret 3, D4, at 4.25 seconds',
    );
    expect(noteButton('n0').getAttribute('aria-label')).toBe(
      'Note 1: high E string, fret 0, C4, at 0.00 seconds',
    );
    expect(noteButton('n5').getAttribute('aria-label')).toMatch(/^Note 6: low E string, fret 5, /);
    expect(screen.getAllByRole('button', { name: /^Note \d+:/ })).toHaveLength(40);
  });

  it('roving focus: one note in the tab order; a click selects; the selection is pressed', () => {
    const { create, session } = analysed();
    render(<Tab takeId="t1" createSession={create} />);
    const stops = [...document.querySelectorAll('[data-note-id]')].filter(
      (b) => b.getAttribute('tabindex') === '0',
    );
    expect(stops.map((b) => b.getAttribute('data-note-id'))).toEqual(['n0']);
    fireEvent.click(noteButton('n7'));
    expect(session.select).toHaveBeenCalledWith('n7');
    expect(noteButton('n7').getAttribute('aria-pressed')).toBe('true');
    expect(noteButton('n7').tabIndex).toBe(0);
    expect(noteButton('n0').tabIndex).toBe(-1);
    expect(noteButton('n0').getAttribute('aria-pressed')).toBe('false');
  });

  it('focusing a note selects it; a selection moved by the arrows moves focus', () => {
    const { create, session, set } = analysed();
    render(<Tab takeId="t1" createSession={create} />);
    act(() => noteButton('n0').focus());
    expect(session.select).toHaveBeenCalledWith('n0');
    set({ selectedNoteId: 'n1' });
    expect(document.activeElement).toBe(noteButton('n1'));
    // Cleared (Esc): focus stays where it is.
    set({ selectedNoteId: null });
    expect(document.activeElement).toBe(noteButton('n1'));
  });

  it('focus moved to the title field before a reflow stays there (no restore to the note)', () => {
    // Timers only: the blur's animation-frame check must not run before the reflow, as when a
    // resize lands in the frame after focus moved.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { create, session } = analysed();
    render(<Tab takeId="t1" createSession={create} />);
    const old = noteButton('n30');
    act(() => old.focus());
    fireEvent.click(screen.getByRole('button', { name: 'Rename take' }));
    const field = screen.getByRole('textbox', { name: 'Take title' });
    expect(document.activeElement).toBe(field);
    measureWidth = 200;
    act(() => resize?.());
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByRole('application').getAttribute('data-width-chars')).toBe('25');
    expect(old.isConnected).toBe(false); // the note's button was re-created
    expect(document.activeElement).toBe(field);
    expect(session.rename).not.toHaveBeenCalled();
  });

  it('after Esc the focused note keeps the tab stop; a reflow keeps focus on it, unselected', () => {
    vi.useFakeTimers();
    const { create, session, set } = analysed('n30');
    render(<Tab takeId="t1" createSession={create} />);
    act(() => noteButton('n30').focus());
    set({ selectedNoteId: null }); // Esc
    expect(noteButton('n30').tabIndex).toBe(0);
    expect(noteButton('n0').tabIndex).toBe(-1);
    vi.mocked(session.select).mockClear();
    measureWidth = 200;
    act(() => resize?.());
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByRole('application').getAttribute('data-width-chars')).toBe('25');
    expect(document.activeElement).toBe(noteButton('n30'));
    expect(session.select).not.toHaveBeenCalled();
    expect(session.getSnapshot().selectedNoteId).toBeNull();
    expect(noteButton('n30').tabIndex).toBe(0);
  });

  it('registers its session as the active one while mounted', () => {
    const { create, session } = analysed();
    const { unmount } = render(<Tab takeId="t1" createSession={create} />);
    expect(activeTakeSession()).toBe(session);
    unmount();
    expect(activeTakeSession()).toBeNull();
  });

  it('reflows on resize (debounced 100 ms) and keeps the selected note selected and focused', () => {
    vi.useFakeTimers();
    const { create } = analysed('n30');
    render(<Tab takeId="t1" createSession={create} />);
    act(() => noteButton('n30').focus());
    const area = screen.getByRole('application');
    const before = screen.getAllByRole('group').length;
    measureWidth = 200;
    act(() => resize?.());
    act(() => vi.advanceTimersByTime(99));
    expect(area.getAttribute('data-width-chars')).toBe('50');
    act(() => vi.advanceTimersByTime(1));
    expect(area.getAttribute('data-width-chars')).toBe('25');
    expect(screen.getAllByRole('group').length).toBeGreaterThan(before);
    for (const pre of area.querySelectorAll('pre')) {
      for (const line of pre.textContent!.split('\n')) expect(line.length).toBeLessThanOrEqual(25);
    }
    expect(noteButton('n30').getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(noteButton('n30'));
  });

  it('the header: title, Rename take, and the date with the duration', () => {
    const createdAt = new Date(2026, 8, 27, 21, 14).toISOString();
    const { create } = mockSession({
      take: { ...TAKE, createdAt, durationMs: 13_400 },
      tab: TAB40,
      loading: false,
      analysis: { kind: 'idle' },
    });
    render(<Tab takeId="t1" createSession={create} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Take 3');
    expect(screen.getByRole('button', { name: 'Rename take' })).toBeTruthy();
    expect(screen.getByTestId('tab-meta').textContent).toBe('Sun 27 Sep 2026, 21:14 · 0:13');
  });

  it('rename: Enter saves and focus returns to the pencil', () => {
    const { create, session } = analysed();
    render(<Tab takeId="t1" createSession={create} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename take' }));
    const field = screen.getByRole('textbox', { name: 'Take title' }) as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe('Take 3');
    fireEvent.change(field, { target: { value: 'Riff in A' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(session.rename).toHaveBeenCalledTimes(1);
    expect(session.rename).toHaveBeenCalledWith('Riff in A');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rename take' }));
  });

  it('rename: the field holds 100 code points, never half an emoji', () => {
    const { create } = analysed();
    render(<Tab takeId="t1" createSession={create} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename take' }));
    const field = screen.getByRole('textbox', { name: 'Take title' }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'x'.repeat(99) + '🎸🎸' } });
    expect(field.value).toBe('x'.repeat(99) + '🎸');
  });

  it('rename: an Enter that ends an IME composition does not save', () => {
    const { create, session } = analysed();
    render(<Tab takeId="t1" createSession={create} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename take' }));
    const field = screen.getByRole('textbox', { name: 'Take title' });
    fireEvent.change(field, { target: { value: 'にほ' } });
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true });
    expect(session.rename).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Take title' })).toBeTruthy();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(session.rename).toHaveBeenCalledWith('にほ');
  });

  it('rename: leaving the screen mid-edit saves the draft, once', () => {
    const { create, session } = analysed();
    const { unmount } = render(<Tab takeId="t1" createSession={create} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename take' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Take title' }), {
      target: { value: 'Half typed' },
    });
    unmount();
    expect(session.rename).toHaveBeenCalledTimes(1);
    expect(session.rename).toHaveBeenCalledWith('Half typed');
  });

  it('rename: Escape cancels, blur saves', () => {
    const { create, session } = analysed();
    render(<Tab takeId="t1" createSession={create} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename take' }));
    let field = screen.getByRole('textbox', { name: 'Take title' });
    fireEvent.change(field, { target: { value: 'Nope' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(session.rename).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rename take' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename take' }));
    field = screen.getByRole('textbox', { name: 'Take title' });
    fireEvent.change(field, { target: { value: 'Blurred' } });
    fireEvent.blur(field);
    expect(session.rename).toHaveBeenCalledWith('Blurred');
  });

  it('the skip link comes first and moves focus to the selected note, else the first', () => {
    const { create, set } = analysed();
    const { container } = render(<Tab takeId="t1" createSession={create} />);
    const focusable = container.querySelectorAll('a[href], button, input, [tabindex="0"]');
    const skip = screen.getByRole('link', { name: 'Skip to tab' });
    expect(focusable[0]).toBe(skip);
    fireEvent.click(skip);
    expect(document.activeElement).toBe(noteButton('n0'));
    act(() => noteButton('n0').blur());
    set({ selectedNoteId: 'n20' });
    act(() => (document.activeElement as HTMLElement).blur());
    fireEvent.click(skip);
    expect(document.activeElement).toBe(noteButton('n20'));
  });

  it('the toolbar under the header: Undo, Redo, Insert, and Delete (disabled with nothing selected)', () => {
    const { create, session, set } = analysed();
    render(<Tab takeId="t1" createSession={create} />);
    const toolbar = screen.getByRole('toolbar', { name: 'Tab tools' });
    const names = [...toolbar.querySelectorAll('button')].map((b) => b.textContent);
    expect(names).toEqual(['Undo', 'Redo', 'Insert', 'Delete', 'Trim', 'Analysis settings']);
    const insert = screen.getByRole('button', { name: 'Insert' }) as HTMLButtonElement;
    const del = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
    expect(insert.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(insert.disabled).toBe(false);
    expect(insert.parentElement!.hasAttribute('title')).toBe(false);
    expect(insert.hasAttribute('aria-describedby')).toBe(false);
    expect(del.disabled).toBe(true);
    fireEvent.click(insert);
    expect(session.insert).toHaveBeenCalledTimes(1);
    set({ selectedNoteId: 'n3' });
    expect(del.disabled).toBe(false);
    expect(del.parentElement!.hasAttribute('title')).toBe(false);
    fireEvent.click(del);
    expect(session.deleteSelected).toHaveBeenCalledTimes(1);
  });

  // Story "Undo and redo controls".
  describe('Undo and Redo', () => {
    const MOVE: CommandLabel = { kind: 'moveString', string: 3, fret: 5 };
    const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
    /** The button's tooltip, checked to be its accessible description too. */
    const tooltip = (b: HTMLButtonElement) => {
      const title = b.parentElement!.getAttribute('title');
      const id = b.getAttribute('aria-describedby');
      expect(id && document.getElementById(id)?.textContent).toBe(title);
      return title;
    };

    it('fresh tab: both disabled, "Nothing to undo" / "Nothing to redo"', () => {
      const { create } = analysed();
      render(<Tab takeId="t1" createSession={create} />);
      expect(button('Undo').disabled).toBe(true);
      expect(tooltip(button('Undo'))).toBe('Nothing to undo');
      expect(button('Redo').disabled).toBe(true);
      expect(tooltip(button('Redo'))).toBe('Nothing to redo');
      for (const name of ['Undo', 'Redo']) {
        expect(button(name).querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      }
    });

    it('after a move: Undo enabled "Undo move to string 3"; Redo disabled', () => {
      const { create, set } = analysed();
      render(<Tab takeId="t1" createSession={create} />);
      set({ undoLabel: MOVE });
      expect(button('Undo').disabled).toBe(false);
      expect(tooltip(button('Undo'))).toBe('Undo move to string 3');
      expect(button('Redo').disabled).toBe(true);
      expect(tooltip(button('Redo'))).toBe('Nothing to redo');
    });

    it('the tooltip names each command in lower case', () => {
      const { create, set } = analysed();
      render(<Tab takeId="t1" createSession={create} />);
      const cases: [CommandLabel, string][] = [
        [{ kind: 'setFret', fret: 5 }, 'Undo set fret 5'],
        [{ kind: 'setFret', fret: 12 }, 'Undo set fret 12'],
        [{ kind: 'delete' }, 'Undo delete note'],
        [{ kind: 'insert' }, 'Undo insert note'],
        [{ kind: 'confirm' }, 'Undo confirm note'],
      ];
      for (const [label, text] of cases) {
        set({ undoLabel: label });
        expect(tooltip(button('Undo'))).toBe(text);
      }
    });

    it('a click on Undo undoes; Undo disabled, Redo "Redo move to string 3", focus on Redo', () => {
      const { create, session, set } = analysed();
      render(<Tab takeId="t1" createSession={create} />);
      set({ undoLabel: MOVE });
      const undo = button('Undo');
      act(() => undo.focus());
      fireEvent.click(undo);
      expect(session.undo).toHaveBeenCalledTimes(1);
      set({ undoLabel: null, redoLabel: MOVE });
      expect(undo.disabled).toBe(true);
      expect(tooltip(undo)).toBe('Nothing to undo');
      expect(tooltip(button('Redo'))).toBe('Redo move to string 3');
      expect(document.activeElement).toBe(button('Redo'));
      // And back: a click on Redo leaves it disabled; focus returns to Undo.
      fireEvent.click(button('Redo'));
      expect(session.redo).toHaveBeenCalledTimes(1);
      set({ undoLabel: MOVE, redoLabel: null });
      expect(document.activeElement).toBe(undo);
    });

    it('a click that leaves the button enabled keeps focus on it', () => {
      const { create, set } = analysed();
      render(<Tab takeId="t1" createSession={create} />);
      set({ undoLabel: MOVE });
      const undo = button('Undo');
      act(() => undo.focus());
      fireEvent.click(undo);
      set({ undoLabel: { kind: 'confirm' }, redoLabel: MOVE });
      expect(document.activeElement).toBe(undo);
    });

    it('a hidden toolbar releases the held focus: a later undo with focus elsewhere moves none', () => {
      const { create, set } = analysed();
      render(<Tab takeId="t1" createSession={create} />);
      set({ undoLabel: MOVE });
      act(() => button('Undo').focus());
      set({ analysis: { kind: 'running', progress: 0.1 } }); // the toolbar goes
      set({ analysis: { kind: 'idle' } });
      act(() => (document.activeElement as HTMLElement | null)?.blur());
      set({ undoLabel: null, redoLabel: MOVE }); // an undo by shortcut
      expect(document.activeElement).toBe(document.body);
    });

    it('a reset that disables both releases the held focus', () => {
      const { create, set } = analysed();
      render(<Tab takeId="t1" createSession={create} />);
      set({ undoLabel: MOVE });
      act(() => button('Undo').focus());
      set({ undoLabel: null, redoLabel: null });
      set({ undoLabel: MOVE });
      set({ undoLabel: null, redoLabel: MOVE }); // a later undo by shortcut
      expect(document.activeElement).not.toBe(button('Redo'));
    });

    it('focus elsewhere is left alone when the history changes', () => {
      const { create, set } = analysed();
      render(<Tab takeId="t1" createSession={create} />);
      set({ undoLabel: MOVE });
      const insert = button('Insert');
      act(() => insert.focus());
      set({ undoLabel: null, redoLabel: MOVE });
      expect(document.activeElement).toBe(insert);
    });

    it('a new edit after an undo: Redo "Nothing to redo"', () => {
      const { create, set } = analysed();
      render(<Tab takeId="t1" createSession={create} />);
      set({ undoLabel: null, redoLabel: MOVE });
      expect(button('Redo').disabled).toBe(false);
      set({ undoLabel: { kind: 'setFret', fret: 12 }, redoLabel: null });
      expect(button('Redo').disabled).toBe(true);
      expect(tooltip(button('Redo'))).toBe('Nothing to redo');
      expect(tooltip(button('Undo'))).toBe('Undo set fret 12');
    });

    it('Delete with notes but nothing selected: "Select a note to delete"', () => {
      const { create } = analysed();
      render(<Tab takeId="t1" createSession={create} />);
      expect(button('Delete').disabled).toBe(true);
      expect(tooltip(button('Delete'))).toBe('Select a note to delete');
    });

    describe('No notes found', () => {
      const EMPTY: TabRecord = {
        takeId: 't1',
        notes: [],
        updatedAt: TAKE.updatedAt,
        deletedStartMs: [],
      };
      const empty = (over: Partial<TakeSnapshot> = {}) =>
        mockSession({
          take: TAKE,
          tab: EMPTY,
          loading: false,
          analysis: { kind: 'idle' },
          ...over,
        });

      it('analysed empty: Undo, Redo, Insert and Delete disabled with their reasons; no Bar lines', () => {
        const { create } = empty();
        render(<Tab takeId="t1" createSession={create} />);
        expect(screen.getByRole('heading', { name: 'No notes found' })).toBeTruthy();
        const toolbar = screen.getByRole('toolbar', { name: 'Tab tools' });
        const names = [...toolbar.querySelectorAll('button')].map((b) => b.textContent);
        expect(names).toEqual(['Undo', 'Redo', 'Insert', 'Delete', 'Trim', 'Analysis settings']);
        const expected: [string, string][] = [
          ['Undo', 'Nothing to undo'],
          ['Redo', 'Nothing to redo'],
          ['Insert', 'No notes yet'],
          ['Delete', 'No notes yet'],
        ];
        for (const [name, reason] of expected) {
          expect(button(name).disabled).toBe(true);
          expect(tooltip(button(name))).toBe(reason);
        }
      });

      it('deleted all: Undo enabled "Undo delete note"; a click undoes', () => {
        const { create, session } = empty({ undoLabel: { kind: 'delete' } });
        render(<Tab takeId="t1" createSession={create} />);
        expect(button('Undo').disabled).toBe(false);
        expect(tooltip(button('Undo'))).toBe('Undo delete note');
        expect(tooltip(button('Insert'))).toBe('No notes yet');
        expect(tooltip(button('Delete'))).toBe('No notes yet');
        fireEvent.click(button('Undo'));
        expect(session.undo).toHaveBeenCalledTimes(1);
      });
    });

    it('no toolbar while loading, analysing or missing', () => {
      const { create, set } = mockSession({
        take: null,
        tab: null,
        loading: true,
        analysis: { kind: 'idle' },
        undoLabel: MOVE,
      });
      render(<Tab takeId="t1" createSession={create} />);
      expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
      set({ take: TAKE, tab: TAB40, loading: false, analysis: { kind: 'running', progress: 0.3 } });
      expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
      set({ analysis: { kind: 'idle' }, missing: true });
      expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    });
  });

  // Story "String moves, delete, insert and confirm": the edit popover.
  // Story "Analysis settings and re-analysis" (US-4.6).
  describe('analysis settings and re-analysis', () => {
    const toggle = () =>
      [
        ...screen
          .getByRole('toolbar', { name: 'Tab tools' })
          .querySelectorAll<HTMLElement>('button[aria-expanded]'),
      ].find((b) => b.textContent === 'Analysis settings')!;
    const panel = () => screen.queryByRole('region', { name: 'Analysis settings' });
    const reanalyseButton = () =>
      screen.getByRole('button', { name: 'Re-analyse' }) as HTMLButtonElement;
    const openPanel = () => fireEvent.click(toggle());
    const lockedTab = (): TabRecord => ({
      ...TAB40,
      notes: TAB40.notes.map((n, i) => (i === 3 ? { ...n, locked: true } : n)),
    });

    it('the toolbar toggle (after Delete) opens and closes the inline panel; not a dialog', () => {
      const { create } = analysed();
      render(<Tab takeId="t1" createSession={create} />);
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
      expect(panel()).toBeNull();
      openPanel();
      expect(toggle().getAttribute('aria-expanded')).toBe('true');
      expect(toggle().getAttribute('aria-controls')).toBe(panel()!.id);
      expect(screen.getByRole('heading', { name: 'Analysis settings', level: 2 })).toBeTruthy();
      expect(screen.queryByRole('dialog')).toBeNull();
      const slider = screen.getByRole('slider', { name: 'Sensitivity' }) as HTMLInputElement;
      expect(slider.value).toBe('0.5');
      expect(slider.min).toBe('0');
      expect(slider.max).toBe('1');
      expect(slider.step).toBe('0.05');
      expect(slider.getAttribute('aria-valuetext')).toMatch(/^0\.50/);
      expect(panel()!.querySelector('output')!.textContent).toBe('0.50');
      expect(screen.getByText('Fewer notes')).toBeTruthy();
      expect(screen.getByText('More notes')).toBeTruthy();
      const min = screen.getByRole('spinbutton', {
        name: 'Minimum note length',
      }) as HTMLInputElement;
      expect([min.value, min.min, min.max]).toEqual(['40', '20', '100']);
      const fret = screen.getByRole('spinbutton', { name: 'Highest fret' }) as HTMLInputElement;
      expect([fret.value, fret.min, fret.max]).toEqual(['24', '12', '24']);
      // Re-analyse is the screen's only primary button.
      expect(reanalyseButton().className).toContain('primary');
      expect(document.querySelectorAll('button[class*="primary"]')).toHaveLength(1);
      openPanel();
      expect(panel()).toBeNull();
    });

    it('Esc inside the panel closes it and returns focus to the toggle', () => {
      const { create, session } = analysed('n3');
      render(<Tab takeId="t1" createSession={create} />);
      openPanel();
      const slider = screen.getByRole('slider', { name: 'Sensitivity' });
      act(() => slider.focus());
      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        slider.dispatchEvent(event);
      });
      expect(panel()).toBeNull();
      expect(document.activeElement).toBe(toggle());
      // The screen's Esc (clear the selection) did not run as well.
      expect(event.defaultPrevented).toBe(true);
      expect(session.select).not.toHaveBeenCalled();
    });

    it('Esc closing the panel commits a number typed but not yet committed', () => {
      const { create, session } = analysed();
      render(<Tab takeId="t1" createSession={create} />);
      openPanel();
      const min = screen.getByRole('spinbutton', { name: 'Minimum note length' });
      act(() => min.focus());
      fireEvent.change(min, { target: { value: '60' } });
      expect(session.setSettings).not.toHaveBeenCalled();
      fireEvent.keyDown(min, { key: 'Escape' });
      expect(panel()).toBeNull();
      expect(session.setSettings).toHaveBeenCalledWith({ minNoteMs: 60 });
    });

    it('a re-analysis starting closes the edit popover', () => {
      const { create, set } = analysed();
      render(<Tab takeId="t1" createSession={create} />);
      fireEvent.doubleClick(noteButton('n3'));
      expect(screen.getByTestId('edit-popover')).toBeTruthy();
      set({ reanalysis: { progress: 0 } });
      expect(screen.queryByTestId('edit-popover')).toBeNull();
    });

    it('the slider commits on change; number fields on Enter and blur (unclamped: the session clamps)', () => {
      const { create, session } = analysed();
      render(<Tab takeId="t1" createSession={create} />);
      openPanel();
      fireEvent.change(screen.getByRole('slider', { name: 'Sensitivity' }), {
        target: { value: '0.3' },
      });
      expect(session.setSettings).toHaveBeenCalledWith({ sensitivity: 0.3 });
      const min = screen.getByRole('spinbutton', { name: 'Minimum note length' });
      fireEvent.change(min, { target: { value: '5' } });
      expect(session.setSettings).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(min, { key: 'Enter' });
      expect(session.setSettings).toHaveBeenLastCalledWith({ minNoteMs: 5 });
      const fret = screen.getByRole('spinbutton', { name: 'Highest fret' });
      fireEvent.change(fret, { target: { value: '19' } });
      fireEvent.blur(fret);
      expect(session.setSettings).toHaveBeenLastCalledWith({ maxFret: 19 });
    });

    it('shows the take settings, and settings a restore brings', () => {
      const { create, set } = analysed();
      render(<Tab takeId="t1" createSession={create} />);
      openPanel();
      set({ take: { ...TAKE, settings: { sensitivity: 0.35, minNoteMs: 60, maxFret: 19 } } });
      expect((screen.getByRole('slider', { name: 'Sensitivity' }) as HTMLInputElement).value).toBe(
        '0.35',
      );
      expect(panel()!.querySelector('output')!.textContent).toBe('0.35');
      expect(
        (screen.getByRole('spinbutton', { name: 'Minimum note length' }) as HTMLInputElement).value,
      ).toBe('60');
    });

    it('no locked notes: Re-analyse runs at once, no dialog', () => {
      const { create, session } = analysed();
      render(<Tab takeId="t1" createSession={create} />);
      openPanel();
      fireEvent.click(reanalyseButton());
      expect(session.reanalyse).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    it('a locked note: the Confirm dialog, Cancel first and focused; Esc or Cancel runs nothing; Re-analyse runs', () => {
      const session = mockSession({
        take: TAKE,
        tab: lockedTab(),
        loading: false,
        analysis: { kind: 'idle' },
      });
      render(<Tab takeId="t1" createSession={session.create} />);
      openPanel();
      fireEvent.click(reanalyseButton());
      const dialog = screen.getByRole('alertdialog', { name: 'Re-analyse Take 3?' });
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(dialog.textContent).toContain(
        "Re-analysing replaces notes you haven't edited. Your edited notes are kept.",
      );
      const buttonsIn = [...dialog.querySelectorAll('button')].map((b) => b.textContent);
      expect(buttonsIn).toEqual(['Cancel', 'Re-analyse']);
      expect(document.activeElement).toBe(dialog.querySelector('button'));
      expect(dialog.querySelectorAll('button')[1]!.className).not.toContain('primary');
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(document.activeElement).toBe(reanalyseButton());
      fireEvent.click(reanalyseButton());
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(session.session.reanalyse).not.toHaveBeenCalled();
      fireEvent.click(reanalyseButton());
      const confirm = screen.getAllByRole('button', { name: 'Re-analyse' }).at(-1)!;
      fireEvent.click(confirm);
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(session.session.reanalyse).toHaveBeenCalledTimes(1);
    });

    it('no audio: Re-analyse disabled with "No audio to analyse"', () => {
      const { create } = mockSession({
        take: { ...TAKE, audioMime: null },
        tab: TAB40,
        loading: false,
        analysis: { kind: 'idle' },
      });
      render(<Tab takeId="t1" createSession={create} />);
      openPanel();
      const b = reanalyseButton();
      expect(b.disabled).toBe(true);
      expect(b.parentElement!.getAttribute('title')).toBe('No audio to analyse');
      expect(document.getElementById(b.getAttribute('aria-describedby')!)!.textContent).toBe(
        'No audio to analyse',
      );
    });

    it('a raw file but no compressed audio: Re-analyse enabled', () => {
      const { create } = mockSession({
        take: { ...TAKE, audioMime: null },
        tab: TAB40,
        loading: false,
        analysis: { kind: 'idle' },
        hasRaw: true,
      });
      render(<Tab takeId="t1" createSession={create} />);
      openPanel();
      expect(reanalyseButton().disabled).toBe(false);
    });

    it('while it runs: the tab stays, the panel shows progress and Cancel; edits disabled; focus to Cancel and back', () => {
      const { create, session, set } = analysed('n3');
      render(<Tab takeId="t1" createSession={create} />);
      openPanel();
      act(() => reanalyseButton().focus());
      set({ reanalysis: { progress: 0.45 } });
      expect(announce).toHaveBeenLastCalledWith('Analysing, 25%');
      expect(screen.getByRole('application', { name: 'Tab' })).toBeTruthy();
      const progress = screen.getByRole('progressbar', { name: 'Analysing…' });
      expect(progress.getAttribute('aria-valuetext')).toBe('45%');
      expect(reanalyseButton().disabled).toBe(true);
      expect(
        (screen.getByRole('slider', { name: 'Sensitivity' }) as HTMLInputElement).disabled,
      ).toBe(true);
      expect((screen.getByRole('button', { name: 'Insert' }) as HTMLButtonElement).disabled).toBe(
        true,
      );
      expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(
        true,
      );
      const cancel = screen.getByRole('button', { name: 'Cancel' });
      expect(document.activeElement).toBe(cancel);
      // The toggle does not close the panel while it runs: its progress and Cancel are there.
      openPanel();
      expect(panel()).not.toBeNull();
      fireEvent.click(cancel);
      expect(session.cancelReanalysis).toHaveBeenCalledTimes(1);
      set({ reanalysis: null });
      expect(screen.queryByRole('progressbar')).toBeNull();
      expect(document.activeElement).toBe(reanalyseButton());
    });

    it('announces the outcome: done, cancelled, failed by code', () => {
      const { create, edit } = analysed();
      render(<Tab takeId="t1" createSession={create} />);
      edit({ kind: 'reanalysed', notes: 12 });
      expect(announce).toHaveBeenLastCalledWith('Re-analysed: 12 notes', 'polite');
      edit({ kind: 'reanalyseCancelled' });
      expect(announce).toHaveBeenLastCalledWith('Re-analysis cancelled', 'polite');
      edit({ kind: 'reanalyseFailed', code: 'audio-missing' });
      expect(announce).toHaveBeenLastCalledWith('No audio to analyse', 'assertive');
      edit({ kind: 'reanalyseFailed', code: 'storage-full' });
      expect(announce).toHaveBeenLastCalledWith(strings['tab.storageFull'], 'assertive');
      edit({ kind: 'reanalyseFailed', code: 'analysis-failed' });
      expect(announce).toHaveBeenLastCalledWith('Re-analysis failed — try again', 'assertive');
      edit({ kind: 'undo', label: { kind: 'reanalyse' } });
      expect(announce).toHaveBeenLastCalledWith('Undid Re-analyse', 'polite');
    });

    it("Undo's tooltip names the re-analysis", () => {
      const { create } = mockSession({
        take: TAKE,
        tab: TAB40,
        loading: false,
        analysis: { kind: 'idle' },
        undoLabel: { kind: 'reanalyse' },
      });
      render(<Tab takeId="t1" createSession={create} />);
      expect(
        screen.getByRole('button', { name: 'Undo' }).parentElement!.getAttribute('title'),
      ).toBe('Undo re-analyse');
    });

    it('No notes found: the tip\'s "Analysis settings" opens the panel and focuses Sensitivity', () => {
      const { create } = mockSession({
        take: TAKE,
        tab: { ...TAB40, notes: [] },
        loading: false,
        analysis: { kind: 'idle' },
      });
      render(<Tab takeId="t1" createSession={create} />);
      const tips = screen.getAllByRole('listitem').map((li) => li.textContent);
      expect(tips.at(-1)).toBe('Raise sensitivity in Analysis settings');
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
      const link = screen
        .getAllByRole('button', { name: 'Analysis settings' })
        .find((b) => b.closest('li'))!;
      fireEvent.click(link);
      expect(panel()).not.toBeNull();
      expect(document.activeElement).toBe(screen.getByRole('slider', { name: 'Sensitivity' }));
      expect(reanalyseButton().disabled).toBe(false);
    });
  });

  // Story "Trim": the Trim toggle, the one-panel rule, the strip's commands, hidden notes.
  describe('trim', () => {
    const toolbarButton = (name: string) =>
      [...screen.getByRole('toolbar', { name: 'Tab tools' }).querySelectorAll('button')].find(
        (b) => b.textContent === name,
      )!;
    const trimToggle = () => toolbarButton('Trim');
    const strip = () => screen.queryByRole('region', { name: 'Trim' });
    const settingsPanel = () => screen.queryByRole('region', { name: 'Analysis settings' });
    const noPeaks = () => new Promise<never>(() => {});
    const open = (over: Partial<TakeSnapshot> = {}) =>
      mockSession({
        take: TAKE,
        tab: TAB40,
        loading: false,
        analysis: { kind: 'idle' },
        ...over,
      });

    it('the toggle sits before Bar lines, with the trim icon; it opens and closes the strip', () => {
      const { create } = open({ take: { ...TAKE, countInBpm: 100 } });
      render(<Tab takeId="t1" createSession={create} loadPeaks={noPeaks} />);
      const toolbar = screen.getByRole('toolbar', { name: 'Tab tools' });
      const names = [...toolbar.querySelectorAll('button')].map((b) => b.textContent);
      expect(names.slice(-3)).toEqual(['Trim', 'Bar lines', 'Analysis settings']);
      expect(trimToggle().querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      expect(trimToggle().className).toContain('toggle');
      expect(trimToggle().getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(trimToggle());
      expect(trimToggle().getAttribute('aria-expanded')).toBe('true');
      expect(strip()).toBeTruthy();
      expect(document.getElementById(trimToggle().getAttribute('aria-controls')!)).toBeTruthy();
      // Save is the screen's one primary button while the strip is open.
      expect(document.querySelectorAll('button[class*="primary"]')).toHaveLength(1);
      fireEvent.click(trimToggle());
      expect(strip()).toBeNull();
    });

    it('one panel at a time: opening one closes the other', () => {
      const { create } = open();
      render(<Tab takeId="t1" createSession={create} loadPeaks={noPeaks} />);
      fireEvent.click(toolbarButton('Analysis settings'));
      expect(settingsPanel()).toBeTruthy();
      fireEvent.click(trimToggle());
      expect(settingsPanel()).toBeNull();
      expect(strip()).toBeTruthy();
      fireEvent.click(toolbarButton('Analysis settings'));
      expect(strip()).toBeNull();
      expect(settingsPanel()).toBeTruthy();
    });

    it('no audio: disabled with "Audio deleted"; an unknown raw file counts as audio', () => {
      const { create, set } = open({ take: { ...TAKE, audioMime: null }, hasRaw: false });
      render(<Tab takeId="t1" createSession={create} loadPeaks={noPeaks} />);
      expect(trimToggle().disabled).toBe(true);
      expect(trimToggle().parentElement!.getAttribute('title')).toBe('Audio deleted');
      set({ hasRaw: null });
      expect(trimToggle().disabled).toBe(false);
    });

    it('disabled while a re-analysis runs; enabled in No notes found', () => {
      const { create, set } = open({ reanalysis: { progress: 0.2 } });
      render(<Tab takeId="t1" createSession={create} loadPeaks={noPeaks} />);
      expect(trimToggle().disabled).toBe(true);
      expect(trimToggle().parentElement!.getAttribute('title')).toBe('Busy re-analysing');
      set({ reanalysis: null, tab: { ...TAB40, notes: [] } });
      expect(screen.getByRole('heading', { name: 'No notes found' })).toBeTruthy();
      expect(trimToggle().disabled).toBe(false);
    });

    it('Save calls trim; a trim run shows in the strip (the settings toggle disabled); Cancel cancels', () => {
      const { create, session, set } = open();
      render(<Tab takeId="t1" createSession={create} loadPeaks={noPeaks} />);
      fireEvent.click(trimToggle());
      const start = screen.getByRole('slider', { name: 'Trim start' });
      fireEvent.keyDown(start, { key: 'ArrowRight', shiftKey: true });
      fireEvent.click(screen.getByRole('button', { name: strings['tab.trimSave'] }));
      expect(session.trim).toHaveBeenCalledWith(100, 4000);
      set({ reanalysis: { progress: 0.3, trim: true } });
      expect(strip()).toBeTruthy();
      expect(settingsPanel()).toBeNull();
      expect(screen.getByTestId('trim-progress')).toBeTruthy();
      expect(toolbarButton('Analysis settings').disabled).toBe(true);
      expect(toolbarButton('Analysis settings').parentElement!.getAttribute('title')).toBe(
        'Busy trimming',
      );
      expect(trimToggle().parentElement!.getAttribute('title')).toBe('Busy trimming');
      fireEvent.click(screen.getByRole('button', { name: strings['tab.cancel'] }));
      expect(session.cancelReanalysis).toHaveBeenCalledTimes(1);
    });

    it('a shown locked note: Save asks first with "Trim and re-analyse"', () => {
      const locked = {
        ...TAB40,
        notes: TAB40.notes.map((n, i) => (i === 3 ? { ...n, locked: true } : n)),
      };
      const { create, session } = open({ tab: locked });
      render(<Tab takeId="t1" createSession={create} loadPeaks={noPeaks} />);
      fireEvent.click(trimToggle());
      fireEvent.keyDown(screen.getByRole('slider', { name: 'Trim start' }), { key: 'End' });
      fireEvent.click(screen.getByRole('button', { name: strings['tab.trimSave'] }));
      expect(session.trim).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: strings['tab.trimConfirm'] }));
      expect(session.trim).toHaveBeenCalledWith(3500, 4000);
    });

    it('a locked note hidden by the trim does not ask; Reset trim calls resetTrim', () => {
      // Note 3 (1125 ms) is locked but before the 2 s trim start.
      const locked = {
        ...TAB40,
        notes: TAB40.notes.map((n, i) => (i === 3 ? { ...n, locked: true } : n)),
      };
      const { create, session } = open({ tab: locked, take: { ...TAKE, trimStartMs: 2000 } });
      render(<Tab takeId="t1" createSession={create} loadPeaks={noPeaks} />);
      fireEvent.click(trimToggle());
      fireEvent.keyDown(screen.getByRole('slider', { name: 'Trim start' }), { key: 'Home' });
      fireEvent.click(screen.getByRole('button', { name: strings['tab.trimSave'] }));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(session.trim).toHaveBeenCalledWith(0, 4000);
      fireEvent.click(screen.getByRole('button', { name: strings['tab.trimReset'] }));
      expect(session.resetTrim).toHaveBeenCalledTimes(1);
    });

    it('Esc in the strip closes it and returns focus to the toggle', () => {
      const { create } = open();
      render(<Tab takeId="t1" createSession={create} loadPeaks={noPeaks} />);
      fireEvent.click(trimToggle());
      const start = screen.getByRole('slider', { name: 'Trim start' });
      act(() => start.focus());
      fireEvent.keyDown(start, { key: 'Escape' });
      expect(strip()).toBeNull();
      expect(document.activeElement).toBe(trimToggle());
    });

    it('hidden notes are not rendered, counted or listed', () => {
      // Notes at 0, 375, … ms: a trim of 1000..3000 leaves 3 (1125) to 7 (2625) and the 12th
      // note (4250) out too.
      const { create } = open({ take: { ...TAKE, trimStartMs: 1000, trimEndMs: 3000 } });
      render(<Tab takeId="t1" createSession={create} loadPeaks={noPeaks} />);
      const shown = [...document.querySelectorAll('[data-note-id]')].map((b) =>
        b.getAttribute('data-note-id'),
      );
      expect(shown).toEqual(['n3', 'n4', 'n5', 'n6', 'n7']);
      expect(screen.getByTestId('tab-status-line').textContent).toContain('5 notes');
    });

    it('every note hidden: No notes found', () => {
      const { create } = open({ take: { ...TAKE, trimStartMs: 20_000 } });
      render(<Tab takeId="t1" createSession={create} loadPeaks={noPeaks} />);
      expect(screen.getByRole('heading', { name: 'No notes found' })).toBeTruthy();
    });

    it('the Analysis settings panel: a locked note hidden by the trim asks no Confirm', () => {
      // Note 3 (1125 ms) is the only locked note, before the 2 s trim start.
      const locked = {
        ...TAB40,
        notes: TAB40.notes.map((n, i) => (i === 3 ? { ...n, locked: true } : n)),
      };
      const { create, session } = open({ tab: locked, take: { ...TAKE, trimStartMs: 2000 } });
      render(<Tab takeId="t1" createSession={create} loadPeaks={noPeaks} />);
      fireEvent.click(toolbarButton('Analysis settings'));
      fireEvent.click(screen.getByRole('button', { name: 'Re-analyse' }));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(session.reanalyse).toHaveBeenCalledTimes(1);
    });

    it('Every note uncertain counts the visible notes only', () => {
      // Every note from 2 s on is flagged; the hidden earlier ones are not.
      const tab = {
        ...TAB40,
        notes: TAB40.notes.map((n) => ({ ...n, lowConfidence: n.startMs >= 2000 })),
      };
      const { create, set } = open({ tab, take: { ...TAKE, trimStartMs: 2000 } });
      render(<Tab takeId="t1" createSession={create} loadPeaks={noPeaks} />);
      expect(screen.getByText(strings['tab.allUncertain'])).toBeTruthy();
      set({ take: TAKE });
      expect(screen.queryByText(strings['tab.allUncertain'])).toBeNull();
    });

    it('a trim cancelled or failed is announced as a trim', () => {
      const { create, edit } = open();
      render(<Tab takeId="t1" createSession={create} loadPeaks={noPeaks} />);
      edit({ kind: 'reanalyseCancelled', trim: true });
      edit({ kind: 'reanalyseFailed', code: 'analysis-failed', trim: true });
      edit({ kind: 'reanalyseFailed', code: 'audio-missing', trim: true });
      expect(vi.mocked(announce).mock.calls).toEqual([
        ['Trim cancelled', 'polite'],
        ['Trim failed — try again', 'assertive'],
        [strings['tab.noAudioToAnalyse'], 'assertive'],
      ]);
    });

    it('announces a trim and a reset; Undo names the trim', () => {
      const { create, edit } = open({ undoLabel: { kind: 'trim' } });
      render(<Tab takeId="t1" createSession={create} loadPeaks={noPeaks} />);
      expect(toolbarButton('Undo').parentElement!.getAttribute('title')).toBe('Undo trim');
      edit({ kind: 'trimmed', reset: false, notes: 12 });
      edit({ kind: 'trimmed', reset: true, notes: 1 });
      edit({ kind: 'undo', label: { kind: 'resetTrim' } });
      expect(vi.mocked(announce).mock.calls).toEqual([
        ['Trimmed: 12 notes', 'polite'],
        ['Trim reset: 1 note', 'polite'],
        ['Undid Reset trim', 'polite'],
      ]);
    });
  });

  describe('the edit popover', () => {
    /** Opens the popover on note n11 (D4 on the B string, fret 3) by double-clicking it. */
    function openOn() {
      const mock = analysed('n11');
      render(<Tab takeId="t1" createSession={mock.create} />);
      const button = noteButton('n11');
      act(() => button.focus());
      fireEvent.doubleClick(button);
      return { ...mock, button };
    }

    it('a double-click opens a modal "Edit note" dialog with the fret field focused', () => {
      const { button } = openOn();
      const dialog = screen.getByRole('dialog', { name: 'Edit note' });
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      const field = screen.getByLabelText('Fret') as HTMLInputElement;
      expect(document.activeElement).toBe(field);
      expect(field.value).toBe('3');
      expect(field.max).toBe('24');
      // The other strings that play D4, then Confirm.
      expect([...dialog.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
        'String 3, fret 7',
        'String 4, fret 12',
        'String 5, fret 17',
        'String 6, fret 22',
        'Confirm',
      ]);
      expect(button.isConnected).toBe(true);
    });

    it('Tab cycles inside; Esc closes with no change and focus goes back to the note', () => {
      const { session, button } = openOn();
      const dialog = screen.getByRole('dialog');
      const confirm = screen.getByRole('button', { name: 'Confirm' });
      act(() => confirm.focus());
      fireEvent.keyDown(confirm, { key: 'Tab' });
      expect(document.activeElement).toBe(screen.getByLabelText('Fret'));
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(dialog.isConnected).toBe(false);
      expect(document.activeElement).toBe(button);
      expect(session.setFret).not.toHaveBeenCalled();
      expect(session.moveString).not.toHaveBeenCalled();
      expect(session.confirm).not.toHaveBeenCalled();
    });

    it('a position button moves the note there and closes', () => {
      const { session, button } = openOn();
      fireEvent.click(screen.getByRole('button', { name: 'String 3, fret 7' }));
      expect(session.moveString).toHaveBeenCalledWith('n11', 3);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(button);
    });

    it('Confirm confirms the note and closes', () => {
      const { session } = openOn();
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
      expect(session.confirm).toHaveBeenCalledWith('n11');
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('a fret and Enter sets it and closes; out of range or empty does nothing', () => {
      const { session } = openOn();
      const field = screen.getByLabelText('Fret') as HTMLInputElement;
      fireEvent.change(field, { target: { value: '25' } });
      fireEvent.submit(field.form!);
      expect(session.setFret).not.toHaveBeenCalled();
      expect(field.getAttribute('aria-invalid')).toBe('true');
      fireEvent.change(field, { target: { value: '' } });
      fireEvent.submit(field.form!);
      expect(session.setFret).not.toHaveBeenCalled();
      fireEvent.change(field, { target: { value: '12' } });
      expect(field.getAttribute('aria-invalid')).toBeNull();
      fireEvent.submit(field.form!);
      expect(session.setFret).toHaveBeenCalledWith('n11', 12);
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('a pointer-down outside closes it', () => {
      openOn();
      fireEvent.pointerDown(screen.getByRole('heading', { level: 1 }));
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('no shortcut runs while it is open', () => {
      const { session } = openOn();
      window.location.hash = '#/tab/t1';
      const field = screen.getByLabelText('Fret');
      for (const key of ['n', ' ', 'Delete']) {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        Object.defineProperty(event, 'target', { value: document.body });
        expect(dispatchShortcut(event, 'tab')).toBe(false);
      }
      expect(session.selectNextFlagged).not.toHaveBeenCalled();
      expect(session.deleteSelected).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(field);
      window.location.hash = '';
    });

    it('a selection moved while it was open gets focus when it closes', () => {
      const { set } = openOn();
      set({ selectedNoteId: 'n12' });
      expect(document.activeElement).toBe(screen.getByLabelText('Fret')); // the popover keeps it
      fireEvent.keyDown(screen.getByLabelText('Fret'), { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(noteButton('n12'));
    });

    it('the tab area focuses a selection moved under any overlay once it closes', async () => {
      const { openOverlay } = await import('../../src/ui/a11y/overlays');
      const labels = noteLabels(notes);
      const { rerender } = render(
        <TabArea notes={notes} labels={labels} selectedNoteId="n1" onSelect={() => {}} />,
      );
      const other = document.body.appendChild(document.createElement('button'));
      const overlay = document.body.appendChild(document.createElement('div'));
      overlay.appendChild(document.createElement('input'));
      let release: () => void = () => {};
      act(() => {
        release = openOverlay({ element: overlay, opener: other, onDismiss() {} });
      });
      rerender(<TabArea notes={notes} labels={labels} selectedNoteId="n5" onSelect={() => {}} />);
      expect(document.activeElement).toBe(overlay.querySelector('input'));
      act(() => release());
      expect(document.activeElement).toBe(noteButton('n5'));
    });

    it('closes when its note goes away', () => {
      const { set } = openOn();
      set({ tab: { ...TAB40, notes: notes.filter((n) => n.id !== 'n11') }, selectedNoteId: null });
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('Note list view: a toggle that shows the same labels in played order', () => {
    const { create } = analysed();
    render(<Tab takeId="t1" createSession={create} />);
    const toggle = screen.getByRole('button', { name: 'Note list view' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByTestId('tab-note-list')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    const items = [...screen.getByTestId('tab-note-list').querySelectorAll('li')].map(
      (li) => li.textContent,
    );
    const ordered = [...notes].sort((a, b) => a.startMs - b.startMs);
    expect(items).toEqual(ordered.map((n) => noteButton(n.id).getAttribute('aria-label')));
    expect(items[11]).toBe('Note 12: B string, fret 3, D4, at 4.25 seconds');
  });
});

describe('Tab screen flags, warnings and bar lines', () => {
  afterEach(() => {
    dismissToast();
  });

  const flaggedNotes = (count: number, flagged: readonly number[]) =>
    Array.from({ length: count }, (_, i) => ({
      ...note(i, ((i % 6) + 1) as Note['string'], i % 10),
      lowConfidence: flagged.includes(i),
    }));
  const tabOf = (notes: Note[]): TabRecord => ({
    takeId: 't1',
    notes,
    updatedAt: TAKE.updatedAt,
    deletedStartMs: [],
  });
  const open = (take: Take, notes: Note[], selectedNoteId: string | null = null) =>
    mockSession({
      take,
      tab: tabOf(notes),
      loading: false,
      analysis: { kind: 'idle' },
      selectedNoteId,
    });

  /** A settings store with only prefs, starting with `barLines`. */
  function fakeSettings(barLines = true) {
    let snapshot: SettingsSnapshot = {
      engine: { state: 'loading' },
      prefs: { barLines, analysisDefaults: { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 } },
    };
    const listeners = new Set<() => void>();
    return {
      subscribePrefs: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      getSnapshot: () => snapshot,
      setBarLines: vi.fn((on: boolean) => {
        snapshot = { ...snapshot, prefs: { ...snapshot.prefs, barLines: on } };
        listeners.forEach((l) => l());
      }),
    };
  }

  const banners = () =>
    [...document.querySelectorAll('[data-testid^="tab-warning-"]')].map((b) =>
      b.getAttribute('data-testid'),
    );

  it('the status line: "<n> notes · <k> to check" under the toolbar; singular forms', () => {
    const { create, set } = open(TAKE, flaggedNotes(40, [3, 7, 20]));
    render(<Tab takeId="t1" createSession={create} />);
    const line = screen.getByTestId('tab-status-line');
    expect(line.querySelector('p')!.textContent).toBe('40 notes · 3 to check');
    expect(screen.getByRole('toolbar').nextElementSibling).toBe(line);
    set({ tab: tabOf(flaggedNotes(1, [0])) });
    expect(line.querySelector('p')!.textContent).toBe('1 note · 1 to check');
    // An update is announced politely through the announcer; the first line is not.
    expect(announce).toHaveBeenCalledWith('1 note · 1 to check');
    expect(announce).not.toHaveBeenCalledWith('40 notes · 3 to check');
    set({ tab: tabOf(flaggedNotes(2, [])) });
    expect(line.querySelector('p')!.textContent).toBe('2 notes · 0 to check');
    expect(line.querySelector('[aria-live]')).toBeNull();
  });

  it('Next to check selects the next flagged note and focuses it; disabled with a reason at 0', () => {
    const { create, session, set } = open(TAKE, flaggedNotes(10, [4]));
    vi.mocked(session.selectNextFlagged).mockImplementation(() => session.select('n4'));
    render(<Tab takeId="t1" createSession={create} />);
    const next = screen.getByRole('button', { name: 'Next to check' });
    expect((next as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(next);
    expect(session.selectNextFlagged).toHaveBeenCalled();
    expect(document.activeElement?.getAttribute('data-note-id')).toBe('n4');
    set({ tab: tabOf(flaggedNotes(10, [])) });
    expect((next as HTMLButtonElement).disabled).toBe(true);
    const reason = document.getElementById(next.getAttribute('aria-describedby')!);
    expect(reason?.textContent).toBe('No notes to check');
    expect(next.parentElement!.getAttribute('title')).toBe('No notes to check');
  });

  it('Next to check starts after the last focused note, as N does (after Esc cleared it)', () => {
    const { create, session } = open(TAKE, flaggedNotes(10, [1, 6]));
    render(<Tab takeId="t1" createSession={create} />);
    act(() => document.querySelector<HTMLButtonElement>('[data-note-id="n3"]')!.focus());
    expect(session.getSnapshot().selectedNoteId).toBe('n3');
    expect(session.getSnapshot().lastFocusedNoteId).toBe('n3');
    act(() => session.select(null)); // Esc
    fireEvent.click(screen.getByRole('button', { name: 'Next to check' }));
    // The session starts from its own record of the last focused note, as N does.
    expect(session.selectNextFlagged).toHaveBeenCalledWith();
  });

  it('Esc, then focus on Play: N and the Next to check button pick the same note', async () => {
    const readAudio = vi.fn(() => Promise.resolve(new Blob(['x'], { type: 'audio/webm' })));
    vi.stubGlobal(
      'URL',
      Object.assign(Object.create(URL), {
        createObjectURL: vi.fn(() => 'blob:take'),
        revokeObjectURL: vi.fn(),
      }),
    );
    try {
      const mock = open(TAKE, flaggedNotes(10, [1, 6]));
      // As the real session: after the selection, else after the last focused note, wrapping.
      vi.mocked(mock.session.selectNextFlagged).mockImplementation((from) => {
        const snap = mock.session.getSnapshot();
        const current = snap.selectedNoteId ?? from ?? snap.lastFocusedNoteId;
        const at = current === null ? -1 : Number(current.slice(1));
        mock.session.select(`n${[1, 6].find((i) => i > at) ?? 1}`);
      });
      render(<Tab takeId="t1" createSession={mock.create} readAudio={readAudio} />);
      await act(async () => {});
      act(() => document.querySelector<HTMLButtonElement>('[data-note-id="n3"]')!.focus());
      const play = screen.getByRole('button', { name: 'Play' });
      const pick = (how: () => void) => {
        act(() => mock.session.select(null)); // Esc
        act(() => play.focus());
        act(how);
        return mock.session.getSnapshot().selectedNoteId;
      };
      window.location.hash = '#/tab/t1';
      const byKey = pick(() => {
        const event = new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true });
        Object.defineProperty(event, 'target', { value: play });
        dispatchShortcut(event, 'tab');
      });
      // N focused n6; put the last focused note back to n3 for the button's turn.
      act(() => document.querySelector<HTMLButtonElement>('[data-note-id="n3"]')!.focus());
      const byButton = pick(() =>
        fireEvent.click(screen.getByRole('button', { name: 'Next to check' })),
      );
      expect(byKey).toBe('n6');
      expect(byButton).toBe(byKey);
    } finally {
      window.location.hash = '';
      vi.unstubAllGlobals();
    }
  });

  it('a re-analysis that changes the counts is announced when the status line comes back', () => {
    const { create, set } = open(TAKE, flaggedNotes(10, [1]));
    render(<Tab takeId="t1" createSession={create} />);
    set({ analysis: { kind: 'running', progress: 0 } });
    expect(screen.queryByTestId('tab-status-line')).toBeNull();
    set({ analysis: { kind: 'idle' }, tab: tabOf(flaggedNotes(8, [1, 2])) });
    expect(announce).toHaveBeenCalledWith('8 notes · 2 to check');
    vi.mocked(announce).mockClear();
    set({ analysis: { kind: 'running', progress: 0 } });
    set({ analysis: { kind: 'idle' }, tab: tabOf(flaggedNotes(8, [1, 2])) });
    expect(announce).not.toHaveBeenCalledWith('8 notes · 2 to check'); // unchanged
  });

  it('a flagged note: check class and ", check this note" in the area and the note list', () => {
    const { create } = open(TAKE, flaggedNotes(5, [2]));
    render(<Tab takeId="t1" createSession={create} />);
    const flagged = document.querySelector('[data-note-id="n2"]')!;
    const plain = document.querySelector('[data-note-id="n1"]')!;
    expect(flagged.getAttribute('aria-label')).toMatch(/^Note 3: .*, check this note$/);
    expect(plain.getAttribute('aria-label')).not.toMatch(/check this note/);
    expect(flagged.className).not.toBe(plain.className);
    fireEvent.click(screen.getByRole('button', { name: 'Note list view' }));
    const items = [...screen.getByTestId('tab-note-list').querySelectorAll('li')];
    expect(items[2]!.textContent).toBe(flagged.getAttribute('aria-label'));
  });

  it('a selected flagged note keeps its check class and is pressed', () => {
    const { create } = open(TAKE, flaggedNotes(5, [2]), 'n2');
    render(<Tab takeId="t1" createSession={create} />);
    const el = document.querySelector('[data-note-id="n2"]')!;
    const plain = document.querySelector('[data-note-id="n1"]')!;
    expect(el.getAttribute('aria-pressed')).toBe('true');
    expect(el.className).not.toBe(plain.className);
  });

  it.each([
    [-45.4, 'Your guitar seems about 45 cents flat — tune up and record again for accurate tab'],
    [40, 'Your guitar seems about 40 cents sharp — tune up and record again for accurate tab'],
  ])('tuning off at %d cents: the banner with an Open tuner link', (cents, text) => {
    const take = { ...TAKE, warnings: { tuningOffsetCents: cents, belowRangeNotes: 0 } };
    const { create } = open(take, flaggedNotes(5, []));
    render(<Tab takeId="t1" createSession={create} />);
    const b = screen.getByTestId('tab-warning-tuning');
    expect(b.textContent).toContain(text);
    expect(screen.getByRole('link', { name: 'Open tuner' }).getAttribute('href')).toBe('#/tuner');
    expect(announce).toHaveBeenCalledWith(text);
  });

  it('no tuning banner under 40 cents, nor drop tuning with no notes below range', () => {
    const take = { ...TAKE, warnings: { tuningOffsetCents: -39.6, belowRangeNotes: 0 } };
    const { create } = open(take, flaggedNotes(5, []));
    render(<Tab takeId="t1" createSession={create} />);
    expect(banners()).toEqual([]);
  });

  it('all four banners above the title, in order; each announced once', () => {
    const take = {
      ...TAKE,
      clipped: true,
      warnings: { tuningOffsetCents: 50, belowRangeNotes: 2 },
    };
    const { create, set } = open(take, flaggedNotes(3, [0, 1, 2]));
    render(<Tab takeId="t1" createSession={create} />);
    expect(banners()).toEqual([
      'tab-warning-tuning',
      'tab-warning-drop',
      'tab-warning-uncertain',
      'tab-warning-clipped',
    ]);
    const h1 = screen.getByRole('heading', { level: 1 });
    const last = screen.getByTestId('tab-warning-clipped');
    expect(last.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('tab-warning-drop').textContent).toContain(
      'Looks like drop tuning — not supported in v1',
    );
    expect(screen.getByTestId('tab-warning-uncertain').textContent).toContain(
      'Every note is uncertain — check the input level and room noise, then re-analyse',
    );
    expect(last.textContent).toContain(
      'This take clipped — move back or lower the input and record again',
    );
    // Clipping and every-note-uncertain cannot be dismissed.
    expect(last.querySelector('button')).toBeNull();
    expect(screen.getByTestId('tab-warning-uncertain').querySelector('button')).toBeNull();
    set({ tab: tabOf(flaggedNotes(3, [0, 1, 2])) });
    for (const text of [strings['tab.dropTuning'], strings['tab.clipped']]) {
      expect(vi.mocked(announce).mock.calls.filter(([t]) => t === text)).toHaveLength(1);
    }
  });

  it('Dismiss hides tuning or drop tuning for this visit; a new visit shows them again', () => {
    const take = { ...TAKE, warnings: { tuningOffsetCents: -45, belowRangeNotes: 1 } };
    const first = open(take, flaggedNotes(5, []));
    const { unmount } = render(<Tab takeId="t1" createSession={first.create} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss tuning warning' }));
    expect(banners()).toEqual(['tab-warning-drop']);
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss drop tuning warning' }));
    expect(banners()).toEqual([]);
    unmount();
    const again = open(take, flaggedNotes(5, []));
    render(<Tab takeId="t1" createSession={again.create} />);
    expect(banners()).toEqual(['tab-warning-tuning', 'tab-warning-drop']);
  });

  it.each([
    ['analysing', { kind: 'running', progress: 0.3 }],
    ['failed', { kind: 'failed', code: 'analysis-failed' }],
  ] as const)('%s: only the clipping banner, from the take alone', (_, analysis) => {
    const { create } = mockSession({
      take: {
        ...TAKE,
        status: 'recorded',
        clipped: true,
        warnings: { tuningOffsetCents: -50, belowRangeNotes: 2 },
      },
      tab: null,
      loading: false,
      analysis,
    });
    render(<Tab takeId="t1" createSession={create} />);
    expect(banners()).toEqual(['tab-warning-clipped']);
  });

  it('a re-analysis (new warnings) shows a dismissed banner again in the same visit', () => {
    const take = { ...TAKE, warnings: { tuningOffsetCents: -45, belowRangeNotes: 1 } };
    const { create, set } = open(take, flaggedNotes(5, []));
    render(<Tab takeId="t1" createSession={create} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss tuning warning' }));
    expect(banners()).toEqual(['tab-warning-drop']);
    set({ take: { ...take, title: 'Renamed' } }); // same warnings: still dismissed
    expect(banners()).toEqual(['tab-warning-drop']);
    set({ take: { ...take, warnings: { tuningOffsetCents: -44, belowRangeNotes: 1 } } });
    expect(banners()).toEqual(['tab-warning-tuning', 'tab-warning-drop']);
  });

  it('Maximum length reached: a toast when the take first loads recorded after a max-length stop', () => {
    const recorded = {
      ...TAKE,
      status: 'recorded' as const,
      stopReason: 'max-length' as const,
      updatedAt: new Date().toISOString(),
    };
    const { create, set } = mockSession({
      take: null,
      tab: null,
      loading: true,
      analysis: { kind: 'idle' },
    });
    render(<Tab takeId="t1" createSession={create} />);
    expect(getToast()).toBeNull();
    set({ take: recorded, loading: false, analysis: { kind: 'running', progress: 0 } });
    expect(getToast()?.message).toBe('Maximum length reached');
    dismissToast();
    set({ take: { ...recorded, status: 'analyzed' }, tab: tabOf(flaggedNotes(3, [])) });
    expect(getToast()).toBeNull(); // once per visit
  });

  it('no toast for a max-length take left recorded and reopened later (stale)', () => {
    const stale = mockSession({
      take: {
        ...TAKE,
        status: 'recorded',
        stopReason: 'max-length',
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
      },
      tab: null,
      loading: false,
      analysis: { kind: 'cancelled' },
    });
    render(<Tab takeId="t1" createSession={stale.create} />);
    expect(getToast()).toBeNull();
  });

  it('no toast for an analysed max-length take, or a user stop', () => {
    const analysed = open({ ...TAKE, stopReason: 'max-length' }, flaggedNotes(3, []));
    const { unmount } = render(<Tab takeId="t1" createSession={analysed.create} />);
    expect(getToast()).toBeNull();
    unmount();
    const user = mockSession({
      take: { ...TAKE, status: 'recorded', stopReason: 'user' },
      tab: null,
      loading: false,
      analysis: { kind: 'running', progress: 0 },
    });
    render(<Tab takeId="t1" createSession={user.create} />);
    expect(getToast()).toBeNull();
  });

  /** The shown systems' text. */
  const shown = () => [...document.querySelectorAll('pre')].map((p) => p.textContent);
  /** The systems `layoutTab` gives at the area's width, with or without the count-in tempo. */
  const expected = (notes: Note[], countInBpm?: number) => {
    const width = Number(screen.getByTestId('tab-systems').getAttribute('data-width-chars'));
    return layoutTab(notes, width, countInBpm).systems.map((sys) => sys.lines.join('\n'));
  };

  it('Bar lines: a pressed toggle with a count-in; off lays the tab out without bar lines', () => {
    const settings = fakeSettings(true);
    const notes = flaggedNotes(12, []).map((n, i) => ({ ...n, startMs: 1000 + i * 600 }));
    const { create } = open({ ...TAKE, countInBpm: 120 }, notes);
    render(<Tab takeId="t1" createSession={create} settings={settings} />);
    const toggle = screen.getByRole('button', { name: 'Bar lines' });
    expect(toggle.closest('[role="toolbar"]')).not.toBeNull();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(expected(notes, 120)).not.toEqual(expected(notes));
    expect(shown()).toEqual(expected(notes, 120));
    fireEvent.click(toggle);
    expect(settings.setBarLines).toHaveBeenCalledWith(false);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(shown()).toEqual(expected(notes));
    fireEvent.click(toggle);
    expect(settings.setBarLines).toHaveBeenLastCalledWith(true);
    expect(shown()).toEqual(expected(notes, 120));
  });

  it('focus moved from a note to Bar lines stays on the toggle when it re-lays the tab out', () => {
    const settings = fakeSettings(true);
    const notes = flaggedNotes(12, []).map((n, i) => ({ ...n, startMs: 1000 + i * 600 }));
    // A note whose system changes with the bar lines, so its button is re-created.
    const systemOf = (id: string, bpm?: number) =>
      layoutTab(notes, 20, bpm).systems.findIndex((sys) => sys.cells.some((c) => c.noteId === id));
    const moving = notes.find((n) => systemOf(n.id, 120) !== systemOf(n.id))!.id;
    const { create } = open({ ...TAKE, countInBpm: 120 }, notes);
    render(<Tab takeId="t1" createSession={create} settings={settings} />);
    const old = document.querySelector<HTMLButtonElement>(`[data-note-id="${moving}"]`)!;
    act(() => old.focus());
    const toggle = screen.getByRole('button', { name: 'Bar lines' });
    act(() => toggle.focus());
    fireEvent.click(toggle);
    expect(old.isConnected).toBe(false);
    expect(document.activeElement).toBe(toggle);
  });

  it('the take deleted elsewhere while a note has focus: focus goes to the h1, not <body>', () => {
    const { create, set } = open(TAKE, flaggedNotes(5, []));
    render(<Tab takeId="t1" createSession={create} />);
    act(() => document.querySelector<HTMLButtonElement>('[data-note-id="n2"]')!.focus());
    set({ take: null, tab: null, selectedNoteId: null, missing: true });
    expect(screen.getByText(strings['tab.notFound'])).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
  });

  it('no Bar lines button without a count-in, or with no notes', () => {
    const settings = fakeSettings(true);
    const plain = open(TAKE, flaggedNotes(5, []));
    const { unmount } = render(
      <Tab takeId="t1" createSession={plain.create} settings={settings} />,
    );
    expect(screen.queryByRole('button', { name: 'Bar lines' })).toBeNull();
    unmount();
    const empty = open({ ...TAKE, countInBpm: 120 }, []);
    render(<Tab takeId="t1" createSession={empty.create} settings={settings} />);
    expect(screen.getByRole('toolbar')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Bar lines' })).toBeNull();
    // No notes: Insert and Delete are there, disabled.
    expect((screen.getByRole('button', { name: 'Insert' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe('Tab screen playback', () => {
  const NOTES = Array.from({ length: 12 }, (_, i) => ({
    ...note(i, ((i % 6) + 1) as Note['string'], i % 10),
    startMs: 1000 + i * 250,
  }));
  const TAB12: TabRecord = {
    takeId: 't1',
    notes: NOTES,
    updatedAt: TAKE.updatedAt,
    deletedStartMs: [],
  };
  const open = (take: Take = TAKE) =>
    mockSession({ take, tab: TAB12, loading: false, analysis: { kind: 'idle' } });
  const readAudio = vi.fn(() => Promise.resolve(new Blob(['x'], { type: 'audio/webm' })));

  beforeEach(() => {
    vi.stubGlobal(
      'URL',
      Object.assign(Object.create(URL), {
        createObjectURL: vi.fn(() => 'blob:take'),
        revokeObjectURL: vi.fn(),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const playButton = () => screen.getByRole('button', { name: /^(Play|Pause)$/ });
  const audioEl = () => document.querySelector('audio')!;
  const noteButton = (id: string) =>
    document.querySelector<HTMLButtonElement>(`[data-note-id="${id}"]`)!;

  /** Renders an analysed take and lets its audio load. */
  async function renderLoaded(take: Take = TAKE) {
    const mock = open(take);
    const view = render(<Tab takeId="t1" createSession={mock.create} readAudio={readAudio} />);
    await act(async () => {});
    return { ...mock, ...view };
  }

  /** Makes the jsdom <audio> act as playing (jsdom has no media playback). */
  function startPlaying(el: HTMLAudioElement, seconds: number) {
    Object.defineProperty(el, 'paused', { configurable: true, writable: true, value: false });
    Object.defineProperty(el, 'currentTime', {
      configurable: true,
      writable: true,
      value: seconds,
    });
    act(() => void el.dispatchEvent(new Event('play')));
  }

  it('the group sits between the status line and the tab: Play, the speeds and the time', async () => {
    await renderLoaded();
    const group = screen.getByRole('group', { name: 'Playback' });
    expect(screen.getByTestId('tab-status-line').nextElementSibling).toBe(group);
    expect(
      group.compareDocumentPosition(screen.getByRole('application')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(playButton().getAttribute('aria-label')).toBe('Play');
    expect(playButton().hasAttribute('disabled')).toBe(false);
    const speeds = screen.getByRole('group', { name: 'Playback speed' });
    expect(
      [...speeds.querySelectorAll('button')].map((b) => [
        b.textContent,
        b.getAttribute('aria-label'),
        b.getAttribute('aria-pressed'),
      ]),
    ).toEqual([
      ['0.5×', '0.5 times speed', 'false'],
      ['0.75×', '0.75 times speed', 'false'],
      ['1×', '1 times speed', 'true'],
    ]);
    expect(screen.getByTestId('tab-playback-time').textContent).toBe('0:00 / 0:04');
    expect(audioEl().getAttribute('preload')).toBe('auto');
    expect(audioEl().hidden).toBe(true);
    expect(audioEl().getAttribute('src')).toBe('blob:take');
    expect(readAudio).toHaveBeenCalledWith('t1');
  });

  it('no audio: Play disabled with "Audio deleted" as tooltip and description; speed enabled', async () => {
    await renderLoaded({ ...TAKE, audioMime: null });
    const play = playButton();
    expect(play.hasAttribute('disabled')).toBe(true);
    expect(play.parentElement!.getAttribute('title')).toBe('Audio deleted');
    const reason = document.getElementById(play.getAttribute('aria-describedby')!);
    expect(reason?.textContent).toBe('Audio deleted');
    for (const b of screen
      .getByRole('group', { name: 'Playback speed' })
      .querySelectorAll('button')) {
      expect(b.hasAttribute('disabled')).toBe(false);
    }
    expect(activePlayback()?.available()).toBe(false);
  });

  it('unplayable audio (an element error): Play disabled with "Audio can\'t be played"', async () => {
    await renderLoaded();
    act(() => void audioEl().dispatchEvent(new Event('error')));
    const play = playButton();
    expect(play.hasAttribute('disabled')).toBe(true);
    expect(play.parentElement!.getAttribute('title')).toBe("Audio can't be played");
    const reason = document.getElementById(play.getAttribute('aria-describedby')!);
    expect(reason?.textContent).toBe("Audio can't be played");
    expect(activePlayback()?.available()).toBe(false);
  });

  it('no group while the tab is not shown (analysing)', async () => {
    const { create } = mockSession({
      take: TAKE,
      tab: null,
      loading: false,
      analysis: { kind: 'running', progress: 0.3 },
    });
    render(<Tab takeId="t1" createSession={create} readAudio={readAudio} />);
    await act(async () => {});
    expect(screen.queryByRole('group', { name: 'Playback' })).toBeNull();
    expect(readAudio).not.toHaveBeenCalled();
    expect(activePlayback()).toBeNull();
  });

  it('registers its playback for the shortcuts while shown; unmount clears it and revokes the URL', async () => {
    const { unmount } = await renderLoaded();
    expect(activePlayback()?.available()).toBe(true);
    unmount();
    expect(activePlayback()).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:take');
  });

  it('speed: the pressed segment and the element rate, pitch preserved', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: '0.75 times speed' }));
    expect(
      screen.getByRole('button', { name: '0.75 times speed' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByRole('button', { name: '1 times speed' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(audioEl().playbackRate).toBe(0.75);
    expect(audioEl().preservesPitch).toBe(true);
  });

  it('while playing: Pause, the playing outline on the current note; it never moves the selection', async () => {
    const { session } = await renderLoaded();
    startPlaying(audioEl(), 1.6);
    expect(playButton().getAttribute('aria-label')).toBe('Pause');
    await act(() => new Promise((r) => setTimeout(r, 50)));
    // Notes start at 1.0 s, 250 ms apart: 1.6 s is note 2.
    expect(noteButton('n2').getAttribute('data-playing')).toBe('true');
    expect(document.querySelectorAll('[data-playing]')).toHaveLength(1);
    expect(session.select).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it('a click on a note while playing selects it and seeks 100 ms before it; paused, it only selects', async () => {
    const { session } = await renderLoaded();
    const el = audioEl();
    Object.defineProperty(el, 'currentTime', { configurable: true, writable: true, value: 0 });
    fireEvent.click(noteButton('n4'));
    expect(session.select).toHaveBeenCalledWith('n4');
    expect(el.currentTime).toBe(0);
    startPlaying(el, 1.2);
    fireEvent.click(noteButton('n8'));
    expect(session.select).toHaveBeenCalledWith('n8');
    expect(el.currentTime).toBeCloseTo(2.9);
  });
});

describe('Tab area: keeping the playing note in view', () => {
  const NOTES = Array.from({ length: 6 }, (_, i) => note(i, ((i % 6) + 1) as Note['string'], i));
  let outside = new Set<string>();
  let now = 0;
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    outside = new Set();
    now = 10_000;
    scrollIntoView.mockClear();
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    Element.prototype.scrollIntoView = scrollIntoView;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const off = outside.has(this.getAttribute('data-note-id') ?? '');
      const top = off ? window.innerHeight + 100 : 10;
      return {
        width: 8,
        height: 20,
        top,
        left: 0,
        right: 8,
        bottom: top + 20,
        x: 0,
        y: top,
      } as DOMRect;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const area = (playingNoteId: string | null, playing = true) => (
    <TabArea
      notes={NOTES}
      labels={noteLabels(NOTES)}
      selectedNoteId={null}
      onSelect={() => {}}
      playingNoteId={playingNoteId}
      playing={playing}
    />
  );

  it('scrolls an out-of-view playing note into view, smoothly; an in-view one is left', () => {
    outside = new Set(['n1']);
    const { rerender } = render(area('n0'));
    expect(scrollIntoView).not.toHaveBeenCalled();
    rerender(area('n1'));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(document.querySelector('[data-note-id="n1"]'));
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
      inline: 'nearest',
      behavior: 'smooth',
    });
  });

  it('at most once per 500 ms: a later change waits, then scrolls if still out of view', () => {
    outside = new Set(['n1', 'n2', 'n3']);
    const { rerender } = render(area('n1'));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    now += 200;
    rerender(area('n2'));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    now += 300;
    act(() => vi.advanceTimersByTime(300));
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(scrollIntoView.mock.contexts[1]).toBe(document.querySelector('[data-note-id="n2"]'));
    // Back in view by the time the wait ends: no scroll.
    now += 100;
    rerender(area('n3'));
    outside = new Set();
    now += 400;
    act(() => vi.advanceTimersByTime(400));
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('paused (the cursor kept): a reflow or a note out of view never scrolls', () => {
    outside = new Set(['n1']);
    const { rerender } = render(area('n1', false));
    // A re-layout (here: bar lines on) re-creates the note buttons.
    rerender(
      <TabArea
        notes={NOTES}
        labels={noteLabels(NOTES)}
        countInBpm={120}
        selectedNoteId={null}
        onSelect={() => {}}
        playingNoteId="n1"
        playing={false}
      />,
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
    // Playing again: it scrolls.
    rerender(area('n1', true));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('reduced motion: scrolls without smooth behaviour', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }));
    outside = new Set(['n1']);
    render(area('n1'));
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
      inline: 'nearest',
      behavior: 'instant',
    });
  });

  it('the playing outline follows the note id across a re-render', () => {
    const { rerender } = render(area('n3'));
    expect(document.querySelector('[data-playing]')?.getAttribute('data-note-id')).toBe('n3');
    rerender(area(null));
    expect(document.querySelector('[data-playing]')).toBeNull();
  });
});
