// The update prompt (story "Update available prompt"; EXPERIENCE.md "Update available", spine
// AD-19): while a new version waits (session/app-update.ts) and the app is idle (`isAppBusy`),
// the persistent toast "Update available — Reload". Persistent rather than DESIGN.md's 4 s
// auto-dismiss, because AD-19 makes the prompt wait for idle and be offered again: it hides
// while the app is busy and returns once idle, and returns when a toast that replaced it goes.
// Busy has no change event across its sources, so while an update waits it is polled once a
// second (`BUSY_POLL_MS`). Reload goes through `reloadToUpdate` (flush, re-check, then the
// waiting worker takes over); a refusal says why (`global.reloadBusy`), and the prompt comes back
// when that toast goes and the app is idle; a Reload that resolved but left the page in place
// (a cancelled unload) offers it again after `RELOAD_SETTLE_MS`. Its close (×) button hides it
// until the page next becomes visible. It is announced on its first showing only; offers after
// that are silent. Started once by the shell (`UpdatePrompt`).

import { useEffect } from 'react';
import { reloadToUpdate, isAppBusy } from '../session/app-reload';
import { appUpdate, type AppUpdate } from '../session/app-update';
import { strings } from './strings';
import { dismissToast, getToast, showToast, subscribeToast, type ShownToast } from './toast';

/** How often busy is re-read while an update waits. */
export const BUSY_POLL_MS = 1000;
/**
 * How long after a Reload that went ahead the prompt stays away; if the page is still here then
 * (the unload was cancelled), it is offered again. Longer than the update's 3 s fallback.
 */
export const RELOAD_SETTLE_MS = 5000;

export interface UpdatePromptDeps {
  update: Pick<AppUpdate, 'isUpdateAvailable' | 'subscribe'>;
  isBusy(): boolean;
  /** Resolves whether it reloaded (false: refused, busy). */
  reload(): Promise<boolean>;
  toast: {
    show(toast: Parameters<typeof showToast>[0]): void;
    dismiss(): void;
    get(): ShownToast | null;
    subscribe(listener: () => void): () => void;
  };
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Calls `listener` when the page becomes visible; returns the removal. */
  onVisible(listener: () => void): () => void;
}

const appDeps: UpdatePromptDeps = {
  update: appUpdate,
  isBusy: isAppBusy,
  reload: () => reloadToUpdate(),
  toast: { show: showToast, dismiss: dismissToast, get: getToast, subscribe: subscribeToast },
  setInterval: (run, ms) => setInterval(run, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  onVisible(listener) {
    const onChange = () => {
      if (document.visibilityState === 'visible') listener();
    };
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  },
};

/** Starts the prompt; returns its stop (which removes a shown prompt). */
export function startUpdatePrompt(deps: UpdatePromptDeps = appDeps): () => void {
  /** The shown prompt's toast id; null when it is not the current toast. */
  let shownId: number | null = null;
  /** A Reload is being tried: the prompt stays away until it is refused or settles. */
  let reloading = false;
  /** Closed with ×: hidden until the page next becomes visible. */
  let closed = false;
  /** Announced once already: offers after the first are silent. */
  let announced = false;
  let poll: unknown = null;
  let settle: unknown = null;
  let stopped = false;

  const isShown = () => shownId !== null && deps.toast.get()?.id === shownId;

  function onReload() {
    reloading = true;
    deps.reload().then(
      (reloaded) => {
        if (reloaded) {
          // The page should be going; if it is still here later, offer the update again.
          settle = deps.setTimeout(() => {
            settle = null;
            reloading = false;
            sync();
          }, RELOAD_SETTLE_MS);
          return;
        }
        reloading = false;
        deps.toast.show({ message: strings['global.reloadBusy'] });
      },
      () => {
        reloading = false;
        sync();
      },
    );
  }

  function sync() {
    if (stopped) return;
    const available = deps.update.isUpdateAvailable();
    if (available && poll === null) poll = deps.setInterval(sync, BUSY_POLL_MS);
    if (!available || reloading || closed) return;
    if (deps.isBusy()) {
      if (isShown()) deps.toast.dismiss();
      return;
    }
    // Another toast is up (it replaced the prompt, or came first): the prompt waits for it.
    if (deps.toast.get() !== null) return;
    deps.toast.show({
      message: strings['global.updateAvailable'],
      action: { label: strings['global.reload'], run: onReload },
      persistent: true,
      close: {
        label: strings['global.updateDismiss'],
        run: () => {
          closed = true;
        },
      },
      silent: announced,
    });
    announced = true;
    shownId = deps.toast.get()?.id ?? null;
  }

  const unsubscribeUpdate = deps.update.subscribe(sync);
  // After the toast change has finished: the prompt's own Reload and close dismiss it before
  // their handlers run, and it must not be offered again in between.
  const unsubscribeToast = deps.toast.subscribe(() => queueMicrotask(sync));
  const removeVisible = deps.onVisible(() => {
    closed = false;
    sync();
  });
  sync();
  return () => {
    stopped = true;
    unsubscribeUpdate();
    unsubscribeToast();
    removeVisible();
    if (poll !== null) deps.clearInterval(poll);
    if (settle !== null) deps.clearTimeout(settle);
    if (isShown()) deps.toast.dismiss();
  };
}

/** Runs the update prompt while mounted. Mount exactly once, in the shell. */
export function UpdatePrompt(): null {
  useEffect(() => startUpdatePrompt(), []);
  return null;
}
