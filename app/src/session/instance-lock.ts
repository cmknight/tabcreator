// One active app instance (story 3.10, US-8.5, CAP-29, spine AD-2, AD-6, AD-16). The only code
// that touches Web Locks and BroadcastChannel. The app holds the Web Lock `tabcreator-instance`
// before any screen that can write storage mounts; read the state with useSyncExternalStore.
//
// Start: the lock is requested with `ifAvailable`; granted → `held` (kept until a handover),
// else `other-tab`. "Use here" (`useHere`, from `other-tab` or `lost`) posts `release-request`
// on the channel, requests the lock normally and, when it is not granted within 3 s, aborts that
// request and steals it. A tab whose writes were fenced reloads once granted, for a clean start.
//
// The holder runs the release sequence once when it receives `release-request`, when its lock is
// stolen, or on the database's `versionchange`: the recording store's handover, the engine's
// cancelAll, the database close, the write fence, the lock released, then `lost`. A step that
// fails does not stop the later ones. The recording store's handover is waited for at most 3 s
// (a stolen tab must not keep running the app): a save still going then is cut off by the close
// and the fence, and its take stays `recording` for recovery (story 3.11). The database's
// `blocked` shows `upgrade-blocked`.
//
// Every grant this tab runs the app under (the start's, or Use here's without a reload) calls
// `onHeld(ready)`; the app-wide lock runs the recovery scan (story 3.11) once `ready` resolves.
// Only a steal can leave an old holder still saving its take (a cooperative grant comes after
// the holder's sequence has fenced its writes; a start's `ifAvailable` grant means no one held
// the lock), so only then does `ready` wait (story 5.3): the stealing tab posts `release-query`,
// and `ready` resolves when a `released` message arrives, or after `RELEASED_FALLBACK_MS` (a
// crashed or frozen old holder). A tab posts `released` (with the time its release sequence
// ended) when that sequence ends, and answers a `release-query` with it once the sequence is
// done; a tab that never held the lock, or holds it still, stays quiet. A waiter counts only a
// `released` that ended at or after its steal, so a tab lost in an earlier handover cannot end it. A fenced tab that steals reloads: it leaves a sessionStorage
// marker, and the reloaded page's start grant waits the same way (for what is left of the
// fallback).

import { engineClient } from '../engine/engine-client';
import { db, type ConnectionState } from '../storage/db';
import { HANDOVER_WAIT_MS, recordingSession } from './recording-session';

export const INSTANCE_LOCK_NAME = 'tabcreator-instance';
/**
 * How long "Use here" waits for the holder to release before stealing the lock, ms. Defined by
 * the recording store, whose unload guard disarms at the same deadline.
 */
export { HANDOVER_WAIT_MS };
/**
 * How long a grant by steal waits for the old holder's `released` before the recovery scan runs
 * anyway, ms: far past the old holder's own `HANDOVER_WAIT_MS`, for a background tab whose
 * timers are throttled, or a crashed or frozen one that never answers.
 */
export const RELEASED_FALLBACK_MS = 30_000;
/** The sessionStorage key carrying a steal across the reload of a fenced tab (`takeOver`). */
export const STEAL_MARKER_KEY = 'tabcreator.instance.stolenAt';

/** The app-wide `onHeld`: runs `scan` once the grant's `ready` resolves. */
export function scanWhenReady(scan: () => unknown): (ready: Promise<void>) => void {
  return (ready) => {
    void ready.then(() => scan());
  };
}

/**
 * `acquiring`: the first request is pending. `held`: this tab runs the app. `other-tab`: another
 * tab holds the lock. `handing-over`: this tab is acquiring after "Use here". `lost`: this tab
 * released the lock or had it stolen. `upgrade-blocked`: a database upgrade waits for other tabs.
 * `unsupported`: no Web Locks.
 */
export type InstanceState =
  'acquiring' | 'held' | 'other-tab' | 'handing-over' | 'lost' | 'upgrade-blocked' | 'unsupported';

/** The message "Use here" posts to the holder. */
export interface ReleaseRequest {
  type: 'release-request';
}

/** Posted by a tab whose release sequence has ended, and in answer to a `ReleaseQuery`. */
export interface ReleasedMessage {
  type: 'released';
  /** When the sender's release sequence ended (`now()`, ms): a waiter ignores an older one. */
  at: number;
}

/** Posted by a tab granted the lock by steal: asks the old holder to say when it is done. */
export interface ReleaseQuery {
  type: 'release-query';
}

/** The part of `sessionStorage` used here (the steal marker). */
export interface MarkerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The part of `navigator.locks` used here, so tests can fake it. */
export interface LocksLike {
  request(
    name: string,
    options: { ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<void> | void,
  ): Promise<unknown>;
}

/** The part of `BroadcastChannel` used here. */
export interface ChannelLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

export interface InstanceLockDeps {
  /** `navigator.locks`; undefined when the browser has no Web Locks. */
  locks: LocksLike | undefined;
  createChannel: (name: string) => ChannelLike;
  /** The recording store's handover: saves a take as `instance-lost`, releases the mic. */
  releaseForHandover: () => Promise<void>;
  /** The engine client's cancelAll. */
  cancelAll: () => void;
  /** Closes the IndexedDB connection (`db.close`). */
  closeDb: () => void;
  fenceWrites: () => void;
  onConnectionState: (listener: (state: ConnectionState) => void) => () => void;
  /** Reloads the page (`location.reload`). */
  reload: () => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /**
   * Called on every grant this tab runs the app under (the start's, or Use here's). `ready`
   * resolves once no old holder can still be saving: at once, or (after a steal) on its
   * `released` message or after `RELEASED_FALLBACK_MS`. It never rejects.
   */
  onHeld: (ready: Promise<void>) => void;
  /** `sessionStorage`, for the steal marker; undefined (or throwing) means no marker. */
  storage: MarkerStorage | undefined;
  /** Wall-clock time, ms (`Date.now`), for the steal marker's age. */
  now: () => number;
  /** Dev only: true while this tab ignores `release-request` (forcing the steal path). */
  ignoreReleaseRequests?: () => boolean;
  /** Dev only: notes `released` posted or heard, for the e2e tests. */
  trace?: (event: 'released-posted' | 'released-heard') => void;
}

export interface InstanceLock {
  subscribe(listener: () => void): () => void;
  getSnapshot(): InstanceState;
  /** Requests the lock (`ifAvailable`). Runs once; later calls do nothing. */
  start(): void;
  /** "Use here": takes the app over from the holder; from `other-tab` or `lost` only. */
  useHere(): void;
  /** Closes the channel (a dev hot update replacing this module). */
  dispose(): void;
}

type Message = ReleaseRequest | ReleasedMessage | ReleaseQuery;

const messageType = (data: unknown): Message['type'] | undefined => {
  const type = typeof data === 'object' && data !== null ? (data as { type?: unknown }).type : null;
  return type === 'release-request' || type === 'released' || type === 'release-query'
    ? type
    : undefined;
};

export function createInstanceLock(deps: InstanceLockDeps): InstanceLock {
  let state: InstanceState = 'acquiring';
  const listeners = new Set<() => void>();
  let started = false;
  let channel: ChannelLike | null = null;
  /** This tab holds the lock (whatever screen shows, e.g. `upgrade-blocked`). */
  let holding = false;
  /** Resolves the held lock's callback promise, releasing it. */
  let releaseHeld: (() => void) | null = null;
  /** The release sequence has run (or runs) for the current hold. */
  let releasing = false;
  /** Writes are fenced: a fenced tab cannot unfence, so it reloads to take the app back. */
  let fenced = false;
  /** When this tab's release sequence ended (it answers a `release-query`); null before. */
  let releasedAt: number | null = null;
  /**
   * Grants waiting for an old holder's `released`, by their steal time: a `released` from a tab
   * that lost the lock before then (an earlier handover) does not count.
   */
  const releaseWaiters = new Map<() => void, number>();

  function set(next: InstanceState) {
    if (next === state) return;
    state = next;
    for (const l of [...listeners]) l();
  }

  function post(message: Message) {
    try {
      channel?.postMessage(message);
    } catch {
      // A closed channel: nothing to tell.
    }
  }

  /**
   * Resolves on the next `released` message whose sequence ended at or after `since` (the steal),
   * or after `ms`; posts `release-query` first, so an old holder that has already finished
   * answers.
   */
  function waitForRelease(since: number, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        releaseWaiters.delete(done);
        deps.clearTimeout(timer);
        resolve();
      };
      const timer = deps.setTimeout(done, Math.max(0, ms));
      releaseWaiters.set(done, since);
      post({ type: 'release-query' });
    });
  }

  /**
   * The steal marker, read and removed: its steal time and remaining wait, ms; null when there
   * is none fresh.
   */
  function takeStealMarker(): { since: number; left: number } | null {
    try {
      const value = deps.storage?.getItem(STEAL_MARKER_KEY) ?? null;
      if (value === null) return null;
      deps.storage?.removeItem(STEAL_MARKER_KEY);
      const since = Number(value);
      const age = deps.now() - since;
      return Number.isFinite(age) && age >= 0 && age < RELEASED_FALLBACK_MS
        ? { since, left: RELEASED_FALLBACK_MS - age }
        : null;
    } catch {
      // No sessionStorage: no wait.
      return null;
    }
  }

  /** Leaves the steal marker for the page this tab reloads into; best-effort. */
  function leaveStealMarker() {
    try {
      deps.storage?.setItem(STEAL_MARKER_KEY, String(deps.now()));
    } catch {
      // No sessionStorage: the reloaded page scans at once.
    }
  }

  /** The lock is granted: hold it until the release sequence lets it go. */
  function hold(ready: Promise<void>): Promise<void> {
    holding = true;
    releasing = false;
    releasedAt = null;
    set('held');
    try {
      deps.onHeld(ready);
    } catch {
      // The app runs regardless (the recovery scan waits for the next start).
    }
    return new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
  }

  /** Runs `step`; a failure (thrown or rejected) does not stop the steps after it. */
  async function attempt(step: () => unknown): Promise<void> {
    try {
      await step();
    } catch {
      // The later steps run regardless (a take that could not be saved stays for recovery).
    }
  }

  /** Settles when `step` does, or after `HANDOVER_WAIT_MS`, whichever comes first. */
  function withDeadline(step: () => Promise<unknown>): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = deps.setTimeout(resolve, HANDOVER_WAIT_MS);
      void attempt(step).then(() => {
        deps.clearTimeout(timer);
        resolve();
      });
    });
  }

  /** The release sequence (spine AD-6): once per hold. */
  async function releaseSequence() {
    if (!holding || releasing) return;
    releasing = true;
    await withDeadline(deps.releaseForHandover);
    await attempt(deps.cancelAll);
    await attempt(deps.closeDb);
    await attempt(deps.fenceWrites);
    fenced = true;
    holding = false;
    const release = releaseHeld;
    releaseHeld = null;
    release?.();
    releasedAt = deps.now();
    post({ type: 'released', at: releasedAt });
    deps.trace?.('released-posted');
    set('lost');
  }

  /**
   * Requests the lock with `options`; `onGranted` runs inside the lock callback. A held lock
   * whose request ends with a rejection was stolen: the release sequence runs. A request that
   * fails without a grant (aborted, or refused by the browser) calls `onRefused`.
   */
  function request(
    options: { ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal },
    onGranted: (lock: unknown) => Promise<void> | void,
    onRefused: (error: unknown) => void = () => {},
  ) {
    let granted = false;
    const locks = deps.locks;
    if (!locks) return;
    let pending: Promise<unknown>;
    try {
      pending = locks.request(INSTANCE_LOCK_NAME, options, (lock) => {
        if (lock) granted = true;
        return onGranted(lock);
      });
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending.catch((err: unknown) => {
      if (!granted) onRefused(err);
      else if (holding) void releaseSequence();
    });
  }

  function onMessage(event: { data: unknown }) {
    switch (messageType(event.data)) {
      case 'release-request':
        if (holding && !deps.ignoreReleaseRequests?.()) void releaseSequence();
        break;
      case 'release-query':
        // A sequence still running posts `released` when it ends.
        if (releasedAt !== null) post({ type: 'released', at: releasedAt });
        break;
      case 'released': {
        const at = (event.data as { at?: unknown }).at;
        if (typeof at !== 'number') break;
        const ready = [...releaseWaiters].filter(([, since]) => at >= since);
        if (ready.length > 0) deps.trace?.('released-heard');
        for (const [done] of ready) done();
        break;
      }
    }
  }

  function onConnection(next: ConnectionState) {
    if (next === 'versionchange') {
      void releaseSequence();
    } else if (next === 'blocked') {
      set('upgrade-blocked');
    } else if (state === 'upgrade-blocked' && holding) {
      set('held');
    }
  }

  function start() {
    if (started) return;
    started = true;
    if (!deps.locks) {
      set('unsupported');
      return;
    }
    try {
      channel = deps.createChannel(INSTANCE_LOCK_NAME);
    } catch {
      // No BroadcastChannel: no handover is possible, so the browser cannot run the app.
      set('unsupported');
      return;
    }
    channel.onmessage = onMessage;
    deps.onConnectionState(onConnection);
    request(
      { ifAvailable: true },
      (lock) => {
        if (!lock) {
          // A reloaded page that did not get the lock drops its marker: it never waits now.
          takeStealMarker();
          set('other-tab');
          return;
        }
        // A page reloaded right after stealing the lock waits as the steal's grant would have.
        const marker = takeStealMarker();
        return hold(
          marker === null ? Promise.resolve() : waitForRelease(marker.since, marker.left),
        );
      },
      (err) => {
        // A SecurityError means this document may never use Web Locks (an opaque origin, a
        // sandboxed frame): as good as having none. Any other refusal may be passing, so show
        // `other-tab`, whose Use here asks again; the app never runs without the lock.
        const name = err && typeof err === 'object' && 'name' in err ? err.name : undefined;
        set(name === 'SecurityError' ? 'unsupported' : 'other-tab');
      },
    );
  }

  /**
   * Granted after "Use here": run the app, or reload when this tab's writes are fenced. A grant
   * by `steal` waits for the old holder's `released` before it is ready; a fenced tab carries
   * that wait across its reload in the steal marker.
   */
  function takeOver(stolen: boolean): Promise<void> | void {
    if (!fenced) {
      return hold(stolen ? waitForRelease(deps.now(), RELEASED_FALLBACK_MS) : Promise.resolve());
    }
    if (stolen) leaveStealMarker();
    // Released before the reload, so the new page's first request gets it.
    queueMicrotask(deps.reload);
  }

  function useHere() {
    if (state !== 'other-tab' && state !== 'lost') return;
    const before = state;
    set('handing-over');
    post({ type: 'release-request' });
    const abort = new AbortController();
    let done = false;
    const timer = deps.setTimeout(() => {
      if (done) return;
      done = true;
      abort.abort();
      request(
        { steal: true },
        () => takeOver(true),
        () => {
          // Not granted: back to the notice this tab showed, so Use here works again.
          if (state === 'handing-over') set(before);
        },
      );
    }, HANDOVER_WAIT_MS);
    request({ signal: abort.signal }, () => {
      if (done) return;
      done = true;
      deps.clearTimeout(timer);
      return takeOver(false);
    });
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => state,
    start,
    useHere,
    dispose() {
      channel?.close();
      channel = null;
    },
  };
}

/** Dev only: the e2e hooks' state (`window.__instanceTest`). */
let devIgnoreReleaseRequests = false;
let devConnectionListener: ((state: ConnectionState) => void) | null = null;
const devEvents: InstanceTestEvent[] = [];

/** The app-wide lock; `main.tsx` starts it before the first render. */
export const instanceLock: InstanceLock = createInstanceLock({
  locks: typeof navigator !== 'undefined' ? navigator.locks : undefined,
  createChannel: (name) => new BroadcastChannel(name) as unknown as ChannelLike,
  releaseForHandover: () => recordingSession.releaseForHandover(),
  cancelAll: () => engineClient.cancelAll(),
  closeDb: () => db.close(),
  fenceWrites: () => db.fenceWrites(),
  onConnectionState: (listener) => {
    if (import.meta.env.DEV) devConnectionListener = listener;
    return db.onConnectionState(listener);
  },
  reload: () => location.reload(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  // The scan is a no-op once the store has been handed over (this tab lost the lock meanwhile).
  onHeld: scanWhenReady(() => {
    if (import.meta.env.DEV) devEvents.push({ event: 'scan', at: Date.now() });
    return recordingSession.scanForRecovery();
  }),
  storage: (() => {
    try {
      return typeof sessionStorage !== 'undefined' ? sessionStorage : undefined;
    } catch {
      // A document denied storage access: no marker.
      return undefined;
    }
  })(),
  now: () => Date.now(),
  // Production builds replace the conditions with `false`, so the hooks tree-shake out.
  ...(import.meta.env.DEV
    ? {
        ignoreReleaseRequests: () => devIgnoreReleaseRequests,
        trace: (event: InstanceTestEvent['event']) => devEvents.push({ event, at: Date.now() }),
      }
    : {}),
});

/** Dev only: one event noted for the e2e tests, with its wall-clock time. */
export interface InstanceTestEvent {
  event: 'released-posted' | 'released-heard' | 'scan';
  at: number;
}

/** Dev only: the e2e hooks on `window.__instanceTest` (absent from production builds). */
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

if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__instanceTest = {
    ignoreReleaseRequests() {
      devIgnoreReleaseRequests = true;
    },
    reportConnectionState(state) {
      devConnectionListener?.(state);
    },
    events: () => [...devEvents],
  };
}

// Dev only. main.tsx imports this module, so Vite turns an edit here or in anything it imports
// into a full reload already; this is the backstop should a hot update ever re-run it in place.
// A new copy of the module would never be started (the page would stay blank) and the old copy
// would keep the lock, so close the channel and reload the page instead.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    instanceLock.dispose();
    location.reload();
  });
}
