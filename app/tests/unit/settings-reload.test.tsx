import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ToastHost } from '../../src/ui/components/ToastHost';
import { Settings } from '../../src/ui/screens/Settings';
import { strings } from '../../src/ui/strings';
import { dismissToast } from '../../src/ui/toast';

// Story 5.2 (DS7), deferred to the refactor sweep: Settings with the engine failed. Its Reload is
// refused with a toast saying why while the app is busy (recording or analysing), and reloads
// when it is not.

const stores = vi.hoisted(() => ({
  settings: { engine: { state: 'unavailable' }, prefs: { barLines: false } },
  recording: false,
  analysing: false,
}));
vi.mock('../../src/session/settings-session', () => ({
  settingsSession: { subscribe: () => () => {}, getSnapshot: () => stores.settings },
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

it('engine failed and a take recording: Reload is refused with the reloadBusy toast', () => {
  stores.recording = true;
  const reload = clickReload();
  expect(reload).not.toHaveBeenCalled();
  expect(screen.getByTestId('toast').textContent).toContain(strings['global.reloadBusy']);
});

it('engine failed and a take analysing: Reload is refused with the reloadBusy toast', () => {
  stores.analysing = true;
  const reload = clickReload();
  expect(reload).not.toHaveBeenCalled();
  expect(screen.getByTestId('toast').textContent).toContain(strings['global.reloadBusy']);
});

it('engine failed and the app not busy: Reload reloads, with no toast', () => {
  const reload = clickReload();
  expect(reload).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId('toast')).toBeNull();
});
