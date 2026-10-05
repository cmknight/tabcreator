import { afterEach, describe, expect, it, vi } from 'vitest';
import { appBusy, isAppBusy, reloadApp, reloadUnlessBusy } from '../../src/session/app-reload';
import { dismissToast, getToast } from '../../src/ui/toast';
import { strings } from '../../src/ui/strings';

// Story 3.7 (spine AD-16, AD-19): an app reload is refused while the recording store is busy.
// Story 5.2 (DS7): busy is the store's one `isBusy()`, the same answer as its unload guard (the
// guard's cases are tested in recording-take.test.ts); a refused Settings Reload says why.

const session = (busy: boolean) => ({ isBusy: () => busy });

// The app's stores, for reloadApp itself: recording idle, analysing as set by each test.
const stores = vi.hoisted(() => ({ analysing: false, recording: false, unsavedEdits: false }));
vi.mock('../../src/session/take-session', () => ({
  hasUnsavedEdits: () => stores.unsavedEdits,
}));
vi.mock('../../src/session/analysis', () => ({
  analysis: { isAnalysing: () => stores.analysing },
}));
vi.mock('../../src/session/recording-session', () => ({
  recordingSession: { isBusy: () => stores.recording },
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

// Story 5.7 (spine AD-16): one busy answer for every app reload.
describe('isAppBusy', () => {
  afterEach(() => {
    stores.analysing = false;
    stores.recording = false;
  });

  it('is false when nothing is busy, true while recording or analysing', () => {
    expect(isAppBusy()).toBe(false);
    stores.recording = true;
    expect(isAppBusy()).toBe(true);
    stores.recording = false;
    stores.analysing = true;
    expect(isAppBusy()).toBe(true);
  });

  // Story "Change a fret and undo it": an edit save pending, in flight or failed is busy too.
  it('is true while a Tab edit is unsaved', () => {
    stores.unsavedEdits = true;
    expect(isAppBusy()).toBe(true);
    stores.unsavedEdits = false;
    expect(isAppBusy()).toBe(false);
  });
});

describe('reloadApp', () => {
  afterEach(() => {
    stores.analysing = false;
    stores.recording = false;
    vi.unstubAllGlobals();
  });

  it('refuses while an analysis is in flight, with the recording store idle', () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    stores.analysing = true;
    expect(reloadApp()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('refuses while recording', () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    stores.recording = true;
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

// Settings' and the Tab screen's engine banners share reloadOrExplain (story 5.7).
describe('reloadOrExplain (Settings and Tab Reload)', () => {
  afterEach(() => dismissToast());

  it('refused: a toast says why', async () => {
    const { reloadOrExplain } = await import('../../src/ui/reload-or-explain');
    reloadOrExplain(() => false);
    expect(getToast()?.message).toBe(strings['global.reloadBusy']);
  });

  it('while analysing: the default Reload is refused with the toast', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    stores.analysing = true;
    try {
      const { reloadOrExplain } = await import('../../src/ui/reload-or-explain');
      reloadOrExplain();
      expect(reload).not.toHaveBeenCalled();
      expect(getToast()?.message).toBe(strings['global.reloadBusy']);
    } finally {
      stores.analysing = false;
      vi.unstubAllGlobals();
    }
  });

  it('reloaded: no toast', async () => {
    const { reloadOrExplain } = await import('../../src/ui/reload-or-explain');
    const reload = vi.fn(() => true);
    reloadOrExplain(reload);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(getToast()).toBeNull();
  });
});
