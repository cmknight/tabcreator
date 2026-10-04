import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppErrorCode } from '../../src/model/errors';
import type { Note, Tab as TabRecord, Take } from '../../src/model/types';
import type { TakeSession, TakeSnapshot } from '../../src/session/take-session';
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

function mockSession(initial: TakeSnapshot) {
  let snapshot = initial;
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
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([strings['tab.retry']]);
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
  const runningAt = (progress: number): TakeSnapshot => ({
    take: RECORDED,
    tab: null,
    loading: false,
    analysis: { kind: 'running', progress },
  });
  const failed = (code: AppErrorCode): TakeSnapshot => ({
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
