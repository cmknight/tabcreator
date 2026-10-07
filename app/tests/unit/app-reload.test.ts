import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appBusy,
  FLUSH_TIMEOUT_MS,
  flushThenReload,
  isAppBusy,
  isBusyAfterFlush,
  reloadApp,
  reloadToUpdate,
  reloadUnlessBusy,
} from '../../src/session/app-reload';
import { dismissToast, getToast } from '../../src/ui/toast';
import { strings } from '../../src/ui/strings';

// Story 3.7 (spine AD-16, AD-19): an app reload is refused while the recording store is busy.
// Story 5.2 (DS7): busy is the store's one `isBusy()`, the same answer as its unload guard (the
// guard's cases are tested in recording-take.test.ts); a refused Settings Reload says why.
// Story "Update available prompt": a running backup or restore is busy too; every reload awaits
// `flushAll()` and checks busy again after it.

const session = (busy: boolean) => ({ isBusy: () => busy });

// The app's stores, for reloadApp itself: everything idle unless a test sets it.
const stores = vi.hoisted(() => ({
  analysing: false,
  recording: false,
  unsavedEdits: false,
  heldTabs: false,
  library: false,
  flushAll: null as unknown as () => Promise<void>,
}));
vi.mock('../../src/session/take-session', () => ({
  hasUnsavedEdits: () => stores.unsavedEdits,
  hasHeldTabs: () => stores.heldTabs,
}));
vi.mock('../../src/session/analysis', () => ({
  analysis: { isAnalysing: () => stores.analysing },
}));
vi.mock('../../src/session/recording-session', () => ({
  recordingSession: { isBusy: () => stores.recording },
}));
vi.mock('../../src/session/library-session', () => ({
  librarySession: { isBusy: () => stores.library },
}));
vi.mock('../../src/session/flush', () => ({
  flushAll: () => stores.flushAll(),
}));

function reset() {
  stores.analysing = false;
  stores.recording = false;
  stores.unsavedEdits = false;
  stores.heldTabs = false;
  stores.library = false;
  stores.flushAll = () => Promise.resolve();
}
reset();

/** Stubs `location.reload`; returns the stub. */
function stubReload() {
  const reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });
  return reload;
}

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
  afterEach(reset);

  it('is false when nothing is busy, true while recording or analysing', () => {
    expect(isAppBusy()).toBe(false);
    stores.recording = true;
    expect(isAppBusy()).toBe(true);
    stores.recording = false;
    stores.analysing = true;
    expect(isAppBusy()).toBe(true);
  });

  // Unsaved edits are judged after the flush, which saves or retries them.
  it('unsaved or held Tab edits: not busy before the flush, busy after it', () => {
    stores.unsavedEdits = true;
    expect(isAppBusy()).toBe(false);
    expect(isBusyAfterFlush()).toBe(true);
    stores.unsavedEdits = false;
    stores.heldTabs = true;
    expect(isAppBusy()).toBe(false);
    expect(isBusyAfterFlush()).toBe(true);
  });

  it('is true while a library backup or restore runs', () => {
    stores.library = true;
    expect(isAppBusy()).toBe(true);
  });
});

describe('flushThenReload', () => {
  it('refuses at once while busy, without flushing', async () => {
    const flushAll = vi.fn(() => Promise.resolve());
    const reload = vi.fn();
    expect(await flushThenReload({ isBusy: () => true, flushAll, reload })).toBe(false);
    expect(flushAll).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads only after the flush has settled', async () => {
    const order: string[] = [];
    let release!: () => void;
    const flushAll = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            order.push('flushed');
            resolve();
          };
        }),
    );
    const reload = vi.fn(() => {
      order.push('reload');
    });
    const done = flushThenReload({ isBusy: () => false, flushAll, reload });
    await Promise.resolve();
    expect(reload).not.toHaveBeenCalled();
    release();
    expect(await done).toBe(true);
    expect(order).toEqual(['flushed', 'reload']);
  });

  it('refuses when the app became busy during the flush', async () => {
    let busy = false;
    const reload = vi.fn();
    const result = await flushThenReload({
      isBusy: () => busy,
      flushAll: async () => {
        busy = true;
      },
      reload,
    });
    expect(result).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('refuses when the flush has not settled within its time limit', async () => {
    vi.useFakeTimers();
    try {
      const reload = vi.fn();
      const result = flushThenReload({
        isBusy: () => false,
        flushAll: () => new Promise<void>(() => {}),
        reload,
      });
      await vi.advanceTimersByTimeAsync(FLUSH_TIMEOUT_MS);
      expect(await result).toBe(false);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-checks with isBusyAfterFlush when given', async () => {
    const reload = vi.fn();
    const result = await flushThenReload({
      isBusy: () => false,
      isBusyAfterFlush: () => true,
      flushAll: () => Promise.resolve(),
      reload,
    });
    expect(result).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('reloadApp', () => {
  afterEach(() => {
    reset();
    vi.unstubAllGlobals();
  });

  it('refuses while an analysis is in flight, with the recording store idle', async () => {
    const reload = stubReload();
    stores.analysing = true;
    expect(await reloadApp()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('refuses while recording', async () => {
    const reload = stubReload();
    stores.recording = true;
    expect(await reloadApp()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('refuses while a backup or restore runs', async () => {
    const reload = stubReload();
    stores.library = true;
    expect(await reloadApp()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads when nothing is busy', async () => {
    const reload = stubReload();
    expect(await reloadApp()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // The I/O matrix's Settings Reload row: idle with an unsaved (pending) edit, flushed first.
  it('with an edit pending: flushes it, then reloads', async () => {
    const reload = stubReload();
    stores.unsavedEdits = true;
    stores.flushAll = async () => {
      expect(reload).not.toHaveBeenCalled();
      stores.unsavedEdits = false;
    };
    expect(await reloadApp()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('refuses when the edit is still unsaved after the flush (its save failed)', async () => {
    const reload = stubReload();
    stores.unsavedEdits = true;
    stores.flushAll = async () => {};
    expect(await reloadApp()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('refuses when a storage-full edit is held for Retry', async () => {
    const reload = stubReload();
    stores.heldTabs = true;
    expect(await reloadApp()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('single-flight: a second call during the flush gets the same promise; one flush, one reload', async () => {
    const reload = stubReload();
    let release!: () => void;
    const flushAll = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    stores.flushAll = flushAll;
    const first = reloadApp();
    const second = reloadApp();
    const third = reloadToUpdate({ activate: vi.fn(() => Promise.resolve()) });
    expect(second).toBe(first);
    expect(third).toBe(first);
    release();
    expect(await first).toBe(true);
    expect(flushAll).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    // Settled: the next call runs again.
    stores.recording = true;
    expect(await reloadApp()).toBe(false);
  });

  it('refuses when a recording starts during the flush', async () => {
    const reload = stubReload();
    stores.flushAll = async () => {
      stores.recording = true;
    };
    expect(await reloadApp()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('reloadToUpdate', () => {
  afterEach(() => {
    reset();
    vi.unstubAllGlobals();
  });

  it('flushes, then activates the waiting worker with a plain reload as its fallback', async () => {
    const reload = stubReload();
    const order: string[] = [];
    stores.flushAll = async () => {
      order.push('flush');
    };
    const activate = vi.fn(async (fallback: () => void, isBusy: () => boolean) => {
      order.push('activate');
      expect(isBusy()).toBe(false);
      fallback();
    });
    expect(await reloadToUpdate({ activate })).toBe(true);
    expect(order).toEqual(['flush', 'activate']);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("the fallback's busy check sees a recording started after Reload", async () => {
    stubReload();
    let isBusy!: () => boolean;
    const activate = vi.fn(async (_fallback: () => void, busy: () => boolean) => {
      isBusy = busy;
    });
    expect(await reloadToUpdate({ activate })).toBe(true);
    stores.recording = true;
    expect(isBusy()).toBe(true);
  });

  it('refused while busy: never activates', async () => {
    stubReload();
    stores.recording = true;
    const activate = vi.fn(() => Promise.resolve());
    expect(await reloadToUpdate({ activate })).toBe(false);
    expect(activate).not.toHaveBeenCalled();
  });

  it('refused when the app becomes busy during the flush: never activates', async () => {
    stubReload();
    stores.flushAll = async () => {
      stores.analysing = true;
    };
    const activate = vi.fn(() => Promise.resolve());
    expect(await reloadToUpdate({ activate })).toBe(false);
    expect(activate).not.toHaveBeenCalled();
  });
});

// Settings' and the Tab screen's engine banners share reloadOrExplain (story 5.7).
describe('reloadOrExplain (Settings and Tab Reload)', () => {
  afterEach(() => {
    dismissToast();
    reset();
    vi.unstubAllGlobals();
  });

  it('refused: a toast says why', async () => {
    const { reloadOrExplain } = await import('../../src/ui/reload-or-explain');
    await reloadOrExplain(() => false);
    expect(getToast()?.message).toBe(strings['global.reloadBusy']);
  });

  it('while analysing: the default Reload is refused with the toast', async () => {
    const reload = stubReload();
    stores.analysing = true;
    const { reloadOrExplain } = await import('../../src/ui/reload-or-explain');
    await reloadOrExplain();
    expect(reload).not.toHaveBeenCalled();
    expect(getToast()?.message).toBe(strings['global.reloadBusy']);
  });

  it('reloaded: no toast', async () => {
    const { reloadOrExplain } = await import('../../src/ui/reload-or-explain');
    const reload = vi.fn(() => Promise.resolve(true));
    await reloadOrExplain(reload);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(getToast()).toBeNull();
  });
});
