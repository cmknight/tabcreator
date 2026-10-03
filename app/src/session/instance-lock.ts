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

import { engineClient } from '../engine/engine-client';
import { db, type ConnectionState } from '../storage/db';
import { recordingSession } from './recording-session';

export const INSTANCE_LOCK_NAME = 'tabcreator-instance';
/** How long "Use here" waits for the holder to release before stealing the lock, ms. */
export const HANDOVER_WAIT_MS = 3000;

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

const isReleaseRequest = (data: unknown): data is ReleaseRequest =>
  typeof data === 'object' &&
  data !== null &&
  (data as { type?: unknown }).type === 'release-request';

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

  function set(next: InstanceState) {
    if (next === state) return;
    state = next;
    for (const l of [...listeners]) l();
  }

  /** The lock is granted: hold it until the release sequence lets it go. */
  function hold(): Promise<void> {
    holding = true;
    releasing = false;
    set('held');
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
    if (isReleaseRequest(event.data) && holding) void releaseSequence();
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
          set('other-tab');
          return;
        }
        return hold();
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

  /** Granted after "Use here": run the app, or reload when this tab's writes are fenced. */
  function takeOver(): Promise<void> | void {
    if (!fenced) return hold();
    // Released before the reload, so the new page's first request gets it.
    queueMicrotask(deps.reload);
  }

  function useHere() {
    if (state !== 'other-tab' && state !== 'lost') return;
    const before = state;
    set('handing-over');
    channel?.postMessage({ type: 'release-request' } satisfies ReleaseRequest);
    const abort = new AbortController();
    let done = false;
    const timer = deps.setTimeout(() => {
      if (done) return;
      done = true;
      abort.abort();
      request(
        { steal: true },
        () => takeOver(),
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
      return takeOver();
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

/** The app-wide lock; `main.tsx` starts it before the first render. */
export const instanceLock: InstanceLock = createInstanceLock({
  locks: typeof navigator !== 'undefined' ? navigator.locks : undefined,
  createChannel: (name) => new BroadcastChannel(name) as unknown as ChannelLike,
  releaseForHandover: () => recordingSession.releaseForHandover(),
  cancelAll: () => engineClient.cancelAll(),
  closeDb: () => db.close(),
  fenceWrites: () => db.fenceWrites(),
  onConnectionState: (listener) => db.onConnectionState(listener),
  reload: () => location.reload(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

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
