import { afterEach, describe, expect, it, vi } from 'vitest';
import { appBusy, reloadApp, reloadUnlessBusy } from '../../src/session/app-reload';
import { dismissToast, getToast } from '../../src/ui/toast';
import { strings } from '../../src/ui/strings';

// Story 3.7 (spine AD-16, AD-19): an app reload is refused while the recording store is busy.
// Story 5.2 (DS7): busy is the store's one `isBusy()`, the same answer as its unload guard (the
// guard's cases are tested in recording-take.test.ts); a refused Settings Reload says why.

const session = (busy: boolean) => ({ isBusy: () => busy });

// The app's stores, for reloadApp itself: recording idle, analysing as set by each test.
const stores = vi.hoisted(() => ({ analysing: false }));
vi.mock('../../src/session/analysis', () => ({
  analysis: { isAnalysing: () => stores.analysing },
}));
vi.mock('../../src/session/recording-session', () => ({
  recordingSession: { isBusy: () => false },
}));

describe('reloadApp guard', () => {
  it('does not reload while the store is busy, and returns false', () => {
    const reload = vi.fn();
    expect(reloadUnlessBusy(session(true), reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads when not busy, and returns true', () => {
    const reload = vi.fn();
    expect(reloadUnlessBusy(session(false), reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

// Story 5.6 (spine AD-16): a reload is also refused while any take is being analysed.
describe('reload while analysing', () => {
  it('is refused while an analysis is in flight, and allowed once none is', () => {
    const reload = vi.fn();
    let analysing = true;
    const busy = appBusy(session(false), { isAnalysing: () => analysing });
    expect(reloadUnlessBusy(busy, reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    analysing = false;
    expect(reloadUnlessBusy(busy, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('is refused while recording, whatever the analysis', () => {
    const busy = appBusy(session(true), { isAnalysing: () => false });
    expect(reloadUnlessBusy(busy, vi.fn())).toBe(false);
  });
});

describe('reloadApp', () => {
  afterEach(() => {
    stores.analysing = false;
    vi.unstubAllGlobals();
  });

  it('refuses while an analysis is in flight, with the recording store idle', () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    stores.analysing = true;
    expect(reloadApp()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads when nothing is busy', () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    expect(reloadApp()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('Settings Reload', () => {
  afterEach(() => dismissToast());

  it('refused: a toast says why', async () => {
    const { reloadOrExplain } = await import('../../src/ui/screens/Settings');
    reloadOrExplain(() => false);
    expect(getToast()?.message).toBe(strings['settings.reloadBusy']);
  });

  it('reloaded: no toast', async () => {
    const { reloadOrExplain } = await import('../../src/ui/screens/Settings');
    const reload = vi.fn(() => true);
    reloadOrExplain(reload);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(getToast()).toBeNull();
  });
});
