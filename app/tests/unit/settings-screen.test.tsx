import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AnalysisSettings } from '../../src/model/types';
import type { SettingsSnapshot } from '../../src/session/settings-session';
import { Settings } from '../../src/ui/screens/Settings';

// Story "Analysis settings and re-analysis" (US-4.6; mockup settings.html): the Settings
// screen's "Defaults for new takes", before About, with the Tab panel's fields and no Re-analyse.

afterEach(cleanup);

function fakeSession(analysisDefaults: AnalysisSettings) {
  let snapshot: SettingsSnapshot = {
    engine: { state: 'ready', version: '0.5.0' },
    prefs: { barLines: true, analysisDefaults },
  };
  const listeners = new Set<() => void>();
  return {
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSnapshot: () => snapshot,
    setAnalysisDefaults: vi.fn((patch: Partial<AnalysisSettings>) => {
      snapshot = {
        ...snapshot,
        prefs: { ...snapshot.prefs, analysisDefaults: { ...analysisDefaults, ...patch } },
      };
      listeners.forEach((l) => l());
    }),
  };
}

it('"Defaults for new takes" comes before About, with the three fields and no Re-analyse', () => {
  const session = fakeSession({ sensitivity: 0.5, minNoteMs: 40, maxFret: 24 });
  render(<Settings session={session} />);
  const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
  expect(headings).toEqual(['Defaults for new takes', 'About']);
  const region = screen.getByRole('region', { name: 'Defaults for new takes' });
  expect(region.textContent).toContain(
    'New takes start with these values. Each take keeps its own copy in its Analysis settings.',
  );
  expect((screen.getByRole('slider', { name: 'Sensitivity' }) as HTMLInputElement).value).toBe(
    '0.5',
  );
  expect(region.querySelector('output')!.textContent).toBe('0.50');
  expect(
    (screen.getByRole('spinbutton', { name: 'Minimum note length' }) as HTMLInputElement).value,
  ).toBe('40');
  expect((screen.getByRole('spinbutton', { name: 'Highest fret' }) as HTMLInputElement).value).toBe(
    '24',
  );
  expect(screen.queryByRole('button', { name: 'Re-analyse' })).toBeNull();
});

it('saves each change: sensitivity 0.7 on change, a number on Enter', () => {
  const session = fakeSession({ sensitivity: 0.5, minNoteMs: 40, maxFret: 24 });
  render(<Settings session={session} />);
  fireEvent.change(screen.getByRole('slider', { name: 'Sensitivity' }), {
    target: { value: '0.7' },
  });
  expect(session.setAnalysisDefaults).toHaveBeenCalledWith({ sensitivity: 0.7 });
  const fret = screen.getByRole('spinbutton', { name: 'Highest fret' });
  fireEvent.change(fret, { target: { value: '15' } });
  fireEvent.keyDown(fret, { key: 'Enter' });
  expect(session.setAnalysisDefaults).toHaveBeenLastCalledWith({ maxFret: 15 });
  expect((fret as HTMLInputElement).value).toBe('15');
});
