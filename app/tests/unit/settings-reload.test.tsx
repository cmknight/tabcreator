import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ToastHost } from '../../src/ui/components/ToastHost';
import { Settings } from '../../src/ui/screens/Settings';
import { strings } from '../../src/ui/strings';
import { dismissToast } from '../../src/ui/toast';

// Story 5.2 (DS7), deferred to the refactor sweep: Settings with the engine failed. Its Reload is
// refused with a toast saying why while the app is busy (recording or analysing), and reloads
// when it is not.

const stores = vi.hoisted(() => ({
  settings: {
    engine: { state: 'unavailable' },
    prefs: {
      barLines: false,
      analysisDefaults: { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 },
      theme: 'system',
    },
  },
  recording: false,
  analysing: false,
}));
vi.mock('../../src/session/settings-session', () => ({
  settingsSession: {
    subscribe: () => () => {},
    getSnapshot: () => stores.settings,
    setAnalysisDefaults: () => {},
    setTheme: () => {},
  },
}));
vi.mock('../../src/session/recording-session', () => ({
  recordingSession: { isBusy: () => stores.recording },
}));
vi.mock('../../src/session/analysis', () => ({
  analysis: { isAnalysing: () => stores.analysing },
}));

afterEach(() => {
  cleanup();
  dismissToast();
  vi.unstubAllGlobals();
  stores.recording = false;
  stores.analysing = false;
});

/** Renders Settings and the toast host, clicks Reload; returns the stubbed `location.reload`. */
function clickReload() {
  const reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });
  render(
    <>
      <Settings />
      <ToastHost />
    </>,
  );
  expect(screen.getByText(strings['global.engineFailed'])).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: strings['global.reload'] }));
  return reload;
}

it('engine failed and a take recording: Reload is refused with the reloadBusy toast', async () => {
  stores.recording = true;
  const reload = clickReload();
  expect((await screen.findByTestId('toast')).textContent).toContain(strings['global.reloadBusy']);
  expect(reload).not.toHaveBeenCalled();
});

it('engine failed and a take analysing: Reload is refused with the reloadBusy toast', async () => {
  stores.analysing = true;
  const reload = clickReload();
  expect((await screen.findByTestId('toast')).textContent).toContain(strings['global.reloadBusy']);
  expect(reload).not.toHaveBeenCalled();
});

it('engine failed and the app not busy: Reload reloads (after the flush), with no toast', async () => {
  const reload = clickReload();
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(screen.queryByTestId('toast')).toBeNull();
});
