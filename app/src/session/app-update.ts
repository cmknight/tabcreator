// The service worker's update state (story "Update available prompt"; CAP-20, CAP-25, spine
// AD-19). `main.tsx` registers the worker with `registerType: 'prompt'` and hands this module the
// plugin's `updateSW` and the registration: a new version installs and then waits, and
// `onNeedRefresh` marks an update available here. The update prompt (ui/update-prompt.ts) shows
// "Update available — Reload" while it is and the app is idle; Reload goes through
// `session/app-reload.ts` (`reloadToUpdate`), which flushes and only then calls `activate` below.
// Nothing else tells the waiting worker to take over: there is no skipWaiting outside Reload.

/** The plugin's `updateSW`: posts `SKIP_WAITING` to the waiting worker, if any. */
export type UpdateServiceWorker = (reloadPage?: boolean) => Promise<void>;

/** How long Reload waits for the new worker to take control before a plain reload. */
export const CONTROLLING_TIMEOUT_MS = 3000;
/** How often a running app checks for a new version (besides each time it becomes visible). */
export const UPDATE_CHECK_MS = 60 * 60 * 1000;

export interface AppUpdate {
  /** Whether a new version is waiting for the player's Reload. */
  isUpdateAvailable(): boolean;
  subscribe(listener: () => void): () => void;
  /** `registerSW`'s `onNeedRefresh`: a new worker is waiting. Idempotent; stops the checks. */
  markAvailable(): void;
  /** Hands over `registerSW`'s returned `updateSW`. */
  setUpdater(update: UpdateServiceWorker): void;
  /**
   * The registration, once registered (registering checked once already): checks for a new
   * version each time the page becomes visible and every `UPDATE_CHECK_MS`, until an update is
   * available; returns the removal of those checks. Idempotent: a second call keeps the one set
   * of checks.
   */
  setRegistration(registration: ServiceWorkerRegistration): () => void;
  /**
   * Tells the waiting worker to take over. Its `controlling` event reloads the page (main.tsx's
   * `onNeedReload`, which calls `controlling`); if no worker is waiting, `reload` runs at once,
   * and if control has not changed within `CONTROLLING_TIMEOUT_MS`, `reload` runs then unless
   * `isBusy()` (the player started recording or editing meanwhile). Call only after the app was
   * flushed and found idle (`reloadToUpdate`).
   */
  activate(reload: () => void, isBusy: () => boolean): Promise<void>;
  /** The new worker took control (`onNeedReload`): the fallback reload is no longer needed. */
  controlling(): void;
}

export interface AppUpdateDeps {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** Calls `listener` when the page becomes visible; returns the removal. */
  onVisible(listener: () => void): () => void;
}

const browserDeps: AppUpdateDeps = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (run, ms) => setInterval(run, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  onVisible(listener) {
    const onChange = () => {
      if (document.visibilityState === 'visible') listener();
    };
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  },
};

export function createAppUpdate(deps: AppUpdateDeps = browserDeps): AppUpdate {
  let available = false;
  let updater: UpdateServiceWorker | null = null;
  let registration: ServiceWorkerRegistration | null = null;
  /** Removes the running update checks; null when none run. */
  let stopChecks: (() => void) | null = null;
  /** The pending fallback reload's timer. */
  let fallback: unknown = null;
  const listeners = new Set<() => void>();

  /** Asks the server for a new worker; a failure (offline) is retried by the next check. */
  function check() {
    registration?.update().catch(() => {});
  }

  function stop() {
    stopChecks?.();
    stopChecks = null;
  }

  return {
    isUpdateAvailable: () => available,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    markAvailable() {
      // The plugin can call it twice for one worker (`waiting`, then an external `installed`).
      if (available) return;
      available = true;
      stop(); // nothing newer to look for until this one is applied
      for (const listener of [...listeners]) listener();
    },
    setUpdater(update) {
      updater = update;
    },
    setRegistration(next) {
      registration = next;
      if (stopChecks === null && !available) {
        const removeVisible = deps.onVisible(check);
        const timer = deps.setInterval(check, UPDATE_CHECK_MS);
        stopChecks = () => {
          removeVisible();
          deps.clearInterval(timer);
        };
      }
      return stop;
    },
    async activate(reload, isBusy) {
      // None waiting: another tab already activated the new version (or the worker went).
      if (!updater || !registration?.waiting) {
        reload();
        return;
      }
      if (fallback !== null) deps.clearTimeout(fallback);
      fallback = deps.setTimeout(() => {
        fallback = null;
        if (!isBusy()) reload();
      }, CONTROLLING_TIMEOUT_MS);
      // A failed post leaves the timer's plain reload.
      await updater().catch(() => {});
    },
    controlling() {
      if (fallback === null) return;
      deps.clearTimeout(fallback);
      fallback = null;
    },
  };
}

export const appUpdate: AppUpdate = createAppUpdate();
