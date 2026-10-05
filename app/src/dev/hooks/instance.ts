// Dev-only instance-lock hooks (stories 3.10, 5.3): the e2e tests' `window.__instanceTest` and
// the state behind it. session/instance-lock.ts calls these only inside `import.meta.env.DEV`,
// so production builds tree-shake this module.
// Every export also falls back to the production behaviour (no hook) outside dev builds, so a
// call missing its guard changes nothing in production.

import type { ConnectionState } from '../../storage/db';

/** One event noted for the e2e tests, with its wall-clock time. */
export interface InstanceTestEvent {
  event: 'released-posted' | 'released-heard' | 'scan';
  at: number;
}

/** The e2e hooks on `window.__instanceTest` (absent from production builds). */
export interface InstanceTestHooks {
  /** From now on this tab ignores `release-request`, so "Use here" elsewhere has to steal. */
  ignoreReleaseRequests(): void;
  /** Reports a database connection state to the lock, as `db.ts` would (`blocked`, `open`). */
  reportConnectionState(state: ConnectionState): void;
  /** The `released` messages posted and heard, and the recovery scans run, in order. */
  events(): InstanceTestEvent[];
}

declare global {
  interface Window {
    __instanceTest?: InstanceTestHooks;
  }
}

let ignoringReleaseRequests = false;
let connectionListener: ((state: ConnectionState) => void) | null = null;
const events: InstanceTestEvent[] = [];

/** Whether this tab ignores `release-request` (`ignoreReleaseRequests` was called). */
export function devIgnoreReleaseRequests(): boolean {
  if (!import.meta.env.DEV) return false;
  return ignoringReleaseRequests;
}

/** Keeps the lock's connection-state listener, for `reportConnectionState`. */
export function devKeepConnectionListener(listener: (state: ConnectionState) => void): void {
  if (!import.meta.env.DEV) return;
  connectionListener = listener;
}

/** Notes an event for `events()`, with the time now. */
export function devTraceInstance(event: InstanceTestEvent['event']): void {
  if (!import.meta.env.DEV) return;
  events.push({ event, at: Date.now() });
}

/** Installs `window.__instanceTest`. */
export function installInstanceTestHooks(): void {
  if (!import.meta.env.DEV) return;
  window.__instanceTest = {
    ignoreReleaseRequests() {
      ignoringReleaseRequests = true;
    },
    reportConnectionState(state) {
      connectionListener?.(state);
    },
    events: () => [...events],
  };
}
