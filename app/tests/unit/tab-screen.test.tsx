import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Note, Tab as TabRecord, Take } from '../../src/model/types';
import type { TakeSession, TakeSnapshot } from '../../src/session/take-session';
import { Tab } from '../../src/ui/screens/Tab';
import { strings } from '../../src/ui/strings';

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

function mockSession(snapshot: TakeSnapshot) {
  const session: TakeSession = {
    subscribe: vi.fn(() => () => {}),
    getSnapshot: () => snapshot,
    dispose: vi.fn(),
    flush: () => Promise.resolve(),
  };
  return { session, create: vi.fn(() => session) };
}

afterEach(cleanup);

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

  it('failed: the plain failure line, no progress', () => {
    const { create } = mockSession({
      take: { ...TAKE, status: 'recorded' },
      tab: null,
      loading: false,
      analysis: { kind: 'failed', code: 'analysis-failed' },
    });
    render(<Tab takeId="t1" createSession={create} />);
    expect(screen.getByText(strings['tab.analysisFailed'])).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
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
