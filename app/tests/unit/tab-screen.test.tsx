import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppErrorCode } from '../../src/model/errors';
import type { Note, Tab as TabRecord, Take } from '../../src/model/types';
import { layoutTab } from '../../src/model/tab-render';
import {
  activeTakeSession,
  type TakeSession,
  type TakeSnapshot,
} from '../../src/session/take-session';
import { Tab } from '../../src/ui/screens/Tab';
import { announce } from '../../src/ui/a11y/announcer';
import { reloadOrExplain } from '../../src/ui/reload-or-explain';
import { strings } from '../../src/ui/strings';

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

/** A snapshot; `selectedNoteId` defaults to null. */
type Snap = Omit<TakeSnapshot, 'selectedNoteId'> & { selectedNoteId?: string | null };

function mockSession(initial: Snap) {
  let snapshot: TakeSnapshot = { selectedNoteId: null, ...initial };
  const listeners = new Set<() => void>();
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
    selectNext: vi.fn(),
    selectPrev: vi.fn(),
    rename: vi.fn(() => Promise.resolve()),
  };
  /** Publishes a new snapshot to the screen. */
  const set = (next: Partial<TakeSnapshot>) =>
    act(() => {
      snapshot = { ...snapshot, ...next };
      listeners.forEach((l) => l());
    });
  return { session, create: vi.fn(() => session), set };
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
    const link = screen.getByRole('link', { name: strings['tab.storageFullLibrary'] });
    expect(link.getAttribute('href')).toBe('#/library');
    fireEvent.click(screen.getByRole('button', { name: strings['tab.retry'] }));
    expect(session.retryCommit).toHaveBeenCalledTimes(1);
    expect(session.analyse).not.toHaveBeenCalled();
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

  it('an empty toolbar under the header', () => {
    const { create } = analysed();
    render(<Tab takeId="t1" createSession={create} />);
    const toolbar = screen.getByRole('toolbar', { name: 'Tab tools' });
    expect(toolbar.children).toHaveLength(0);
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
