import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/App';
import { instanceLock, type InstanceState } from '../../src/session/instance-lock';
import { recordingSession } from '../../src/session/recording-session';
import { strings } from '../../src/ui/strings';

// Story 5.3 (Recording retro DS9): a database upgrade blocked while a take is busy keeps the shell
// (and so Stop) mounted with an alert banner; the full-screen notice follows once it is not busy.

describe('App: upgrade blocked during a take', () => {
  let state: InstanceState;
  let busy: boolean;
  let lockListeners: Array<() => void>;
  let storeListeners: Array<() => void>;

  beforeEach(() => {
    window.location.hash = '#/library';
    state = 'held';
    busy = false;
    lockListeners = [];
    storeListeners = [];
    vi.spyOn(instanceLock, 'getSnapshot').mockImplementation(() => state);
    vi.spyOn(instanceLock, 'subscribe').mockImplementation((l) => {
      lockListeners.push(l);
      return () => (lockListeners = lockListeners.filter((x) => x !== l));
    });
    vi.spyOn(recordingSession, 'isBusy').mockImplementation(() => busy);
    vi.spyOn(recordingSession, 'subscribe').mockImplementation((l) => {
      storeListeners.push(l);
      return () => (storeListeners = storeListeners.filter((x) => x !== l));
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.location.hash = '';
  });

  const notifyLock = () => act(() => lockListeners.forEach((l) => l()));
  const notifyStore = () => act(() => storeListeners.forEach((l) => l()));
  const nav = () => screen.queryByRole('navigation', { name: strings['global.navLabel'] });

  it('busy: the shell stays mounted, with the alert banner at the top of main', () => {
    render(<App />);
    const heading = screen.getByRole('heading', { level: 1 });
    busy = true;
    notifyStore();
    state = 'upgrade-blocked';
    notifyLock();
    expect(nav()).not.toBeNull();
    // The same screen element: not remounted.
    expect(screen.getByRole('heading', { level: 1 })).toBe(heading);
    const alert = screen.getByTestId('upgrade-blocked-banner');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toBe(strings['global.instanceUpgradeBlocked']);
    expect(screen.getByRole('main').firstElementChild).toBe(alert);

    // Not busy any more (the take is saved): the full-screen notice.
    busy = false;
    notifyStore();
    expect(nav()).toBeNull();
    expect(
      screen.getByRole('heading', { name: strings['global.instanceUpgradeBlocked'] }),
    ).toBeTruthy();
    expect(screen.queryByTestId('upgrade-blocked-banner')).toBeNull();
  });

  it('not busy: the full-screen notice at once, as before', () => {
    state = 'upgrade-blocked';
    render(<App />);
    expect(nav()).toBeNull();
    expect(
      screen.getByRole('heading', { name: strings['global.instanceUpgradeBlocked'] }),
    ).toBeTruthy();
  });

  it('held: no banner', () => {
    render(<App />);
    expect(nav()).not.toBeNull();
    expect(screen.queryByTestId('upgrade-blocked-banner')).toBeNull();
  });
});
