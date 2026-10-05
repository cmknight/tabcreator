import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ToastHost } from '../../src/ui/components/ToastHost';
import { Settings } from '../../src/ui/screens/Settings';
import { strings } from '../../src/ui/strings';
import { dismissToast } from '../../src/ui/toast';

// Story 5.2 (DS7), deferred to the refactor sweep: Settings with the engine failed and the app
// busy; its Reload is refused and the toast says why.

const stores = vi.hoisted(() => ({
  settings: { engine: { state: 'unavailable' }, prefs: { barLines: false } },
}));
vi.mock('../../src/session/settings-session', () => ({
  settingsSession: { subscribe: () => () => {}, getSnapshot: () => stores.settings },
}));
// Busy: a take is recording.
vi.mock('../../src/session/recording-session', () => ({
  recordingSession: { isBusy: () => true },
}));
vi.mock('../../src/session/analysis', () => ({
  analysis: { isAnalysing: () => false },
}));

afterEach(() => {
  cleanup();
  dismissToast();
  vi.unstubAllGlobals();
});

it('engine failed and the app busy: Reload is refused with the reloadBusy toast', () => {
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
  expect(reload).not.toHaveBeenCalled();
  expect(screen.getByTestId('toast').textContent).toContain(strings['global.reloadBusy']);
});
