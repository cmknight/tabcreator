import { describe, expect, it, vi } from 'vitest';
import {
  CONTROLLING_TIMEOUT_MS,
  createAppUpdate,
  UPDATE_CHECK_MS,
  type AppUpdateDeps,
} from '../../src/session/app-update';

// Story "Update available prompt" (CAP-20, spine AD-19): the waiting worker's state, the update
// checks, and Reload's hand-over to the waiting worker.

function setup() {
  const timeouts: { run: () => void; ms: number; cleared: boolean }[] = [];
  const intervals: { run: () => void; ms: number; cleared: boolean }[] = [];
  const visibles = new Set<() => void>();
  const deps: AppUpdateDeps = {
    setTimeout: (run, ms) => {
      const handle = { run, ms, cleared: false };
      timeouts.push(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    setInterval: (run, ms) => {
      const handle = { run, ms, cleared: false };
      intervals.push(handle);
      return handle;
    },
    clearInterval: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    onVisible: (listener) => {
      visibles.add(listener);
      return () => {
        visibles.delete(listener);
      };
    },
  };
  const update = createAppUpdate(deps);
  const registration = (waiting: boolean) =>
    ({
      waiting: waiting ? {} : null,
      update: vi.fn(() => Promise.resolve()),
    }) as unknown as ServiceWorkerRegistration & { update: ReturnType<typeof vi.fn> };
  /** Runs the pending (not cleared) timeouts. */
  const fireTimeouts = () => timeouts.filter((t) => !t.cleared).forEach((t) => t.run());
  return {
    update,
    timeouts,
    intervals,
    visibles,
    visible: () => [...visibles].forEach((l) => l()),
    registration,
    fireTimeouts,
  };
}

const idle = () => false;

describe('app update', () => {
  it('markAvailable is idempotent: listeners hear it once', () => {
    const { update } = setup();
    const listener = vi.fn();
    update.subscribe(listener);
    expect(update.isUpdateAvailable()).toBe(false);
    update.markAvailable();
    update.markAvailable(); // the plugin's second call for the same worker
    expect(update.isUpdateAvailable()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('checks for a new version when the page becomes visible and hourly; stops on removal', () => {
    const { update, intervals, visible, registration } = setup();
    const reg = registration(false);
    const stop = update.setRegistration(reg);
    expect(reg.update).not.toHaveBeenCalled();
    visible();
    expect(reg.update).toHaveBeenCalledTimes(1);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]!.ms).toBe(UPDATE_CHECK_MS);
    intervals[0]!.run();
    expect(reg.update).toHaveBeenCalledTimes(2);
    stop();
    expect(intervals[0]!.cleared).toBe(true);
    visible();
    expect(reg.update).toHaveBeenCalledTimes(2);
  });

  it('setRegistration twice keeps one set of checks', () => {
    const { update, intervals, visibles, visible, registration } = setup();
    const reg = registration(false);
    update.setRegistration(reg);
    update.setRegistration(reg);
    expect(intervals).toHaveLength(1);
    expect(visibles.size).toBe(1);
    visible();
    expect(reg.update).toHaveBeenCalledTimes(1);
  });

  it('the checks stop once an update is available', () => {
    const { update, intervals, visibles, visible, registration } = setup();
    const reg = registration(false);
    update.setRegistration(reg);
    update.markAvailable();
    expect(intervals[0]!.cleared).toBe(true);
    expect(visibles.size).toBe(0);
    visible();
    expect(reg.update).not.toHaveBeenCalled();
    // Registered after it is available: no checks start.
    update.setRegistration(reg);
    expect(intervals).toHaveLength(1);
  });

  it('a failed check (offline) is swallowed', async () => {
    const { update, visible, registration } = setup();
    const reg = registration(false);
    reg.update.mockReturnValueOnce(Promise.reject(new Error('offline')));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      update.setRegistration(reg);
      visible();
      expect(reg.update).toHaveBeenCalledTimes(1);
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('activate with a waiting worker: posts SKIP_WAITING, with a plain reload after 3 s', async () => {
    const { update, timeouts, registration, fireTimeouts } = setup();
    const updateSW = vi.fn(() => Promise.resolve());
    update.setUpdater(updateSW);
    update.setRegistration(registration(true));
    const reload = vi.fn();
    await update.activate(reload, idle);
    expect(updateSW).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    expect(timeouts.map((t) => t.ms)).toEqual([CONTROLLING_TIMEOUT_MS]);
    fireTimeouts(); // `controlling` never came
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('the fallback reload is skipped when the app turned busy meanwhile', async () => {
    const { update, registration, fireTimeouts } = setup();
    update.setUpdater(() => Promise.resolve());
    update.setRegistration(registration(true));
    const reload = vi.fn();
    await update.activate(reload, () => true);
    fireTimeouts();
    expect(reload).not.toHaveBeenCalled();
  });

  it('controlling clears the fallback timer', async () => {
    const { update, timeouts, registration } = setup();
    update.setUpdater(() => Promise.resolve());
    update.setRegistration(registration(true));
    const reload = vi.fn();
    await update.activate(reload, idle);
    update.controlling();
    expect(timeouts[0]!.cleared).toBe(true);
  });

  it('activate with no waiting worker (another tab activated it): a plain reload at once', async () => {
    const { update, timeouts, registration } = setup();
    const updateSW = vi.fn(() => Promise.resolve());
    update.setUpdater(updateSW);
    update.setRegistration(registration(false));
    const reload = vi.fn();
    await update.activate(reload, idle);
    expect(updateSW).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(timeouts).toEqual([]);
  });

  it('activate before registration: a plain reload', async () => {
    const { update } = setup();
    const reload = vi.fn();
    await update.activate(reload, idle);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
