import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisSettings, ThemePref } from '../../src/model/types';
import type { SettingsSnapshot } from '../../src/session/settings-session';
import { Settings } from '../../src/ui/screens/Settings';

// Story "Analysis settings and re-analysis" (US-4.6; mockup settings.html): the Settings
// screen's "Defaults for new takes", before About, with the Tab panel's fields and no Re-analyse.

afterEach(cleanup);

function fakeSession(
  analysisDefaults: AnalysisSettings,
  storageProtected: boolean | null = true,
  theme: ThemePref = 'system',
) {
  let snapshot: SettingsSnapshot = {
    engine: { state: 'ready', version: '0.5.0' },
    prefs: { barLines: true, analysisDefaults, theme },
    storageProtected,
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
    setTheme: vi.fn((pref: ThemePref) => {
      snapshot = { ...snapshot, prefs: { ...snapshot.prefs, theme: pref } };
      listeners.forEach((l) => l());
    }),
  };
}

it('"Defaults for new takes" comes before Appearance, Storage and About, with the fields and no Re-analyse', () => {
  const session = fakeSession({ sensitivity: 0.5, minNoteMs: 40, maxFret: 24 });
  render(<Settings session={session} />);
  const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
  expect(headings).toEqual(['Defaults for new takes', 'Appearance', 'Storage', 'About']);
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

// Story "Storage protection and Library states" (6.7; mockup settings.html): the Storage panel.
const DEFAULTS = { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 };

it('Storage reads "protected" with no link when storage is persisted', () => {
  render(<Settings session={fakeSession(DEFAULTS, true)} />);
  const region = screen.getByRole('region', { name: 'Storage' });
  expect(region.textContent).toContain('Storage: protected');
  expect(region.textContent).not.toContain('may be cleared');
  expect(screen.queryByRole('link', { name: 'Back up library' })).toBeNull();
});

it('Storage warns and links to the Library when storage is not protected', () => {
  render(<Settings session={fakeSession(DEFAULTS, false)} />);
  const region = screen.getByRole('region', { name: 'Storage' });
  expect(region.textContent).toContain('Storage: may be cleared by the browser');
  expect(screen.getByRole('link', { name: 'Back up library' }).getAttribute('href')).toBe(
    '#/library',
  );
});

it('Storage shows no status before it is read', () => {
  render(<Settings session={fakeSession(DEFAULTS, null)} />);
  expect(screen.getByRole('region', { name: 'Storage' }).textContent).toBe('Storage');
});

// Story "Theme toggle": the Appearance panel's Theme segmented control.
describe('Appearance', () => {
  const pressed = () =>
    within(screen.getByRole('group', { name: 'Theme' }))
      .getAllByRole('button')
      .map((b) => [b.textContent, b.getAttribute('aria-pressed')]);

  it('shows Theme as System / Light / Dark with the stored pref pressed', () => {
    render(<Settings session={fakeSession(DEFAULTS, true, 'light')} />);
    const region = screen.getByRole('region', { name: 'Appearance' });
    expect(within(region).getByRole('group', { name: 'Theme' })).toBeTruthy();
    expect(pressed()).toEqual([
      ['System', 'false'],
      ['Light', 'true'],
      ['Dark', 'false'],
    ]);
  });

  it('a click calls setTheme and moves aria-pressed', () => {
    const session = fakeSession(DEFAULTS);
    render(<Settings session={session} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(session.setTheme).toHaveBeenCalledWith('dark');
    expect(pressed()).toEqual([
      ['System', 'false'],
      ['Light', 'false'],
      ['Dark', 'true'],
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'System' }));
    expect(session.setTheme).toHaveBeenLastCalledWith('system');
    // Settings no longer touches the page; followTheme does (theme-apply.test.ts).
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});
