import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/model/errors';
import {
  createInstanceLock,
  HANDOVER_WAIT_MS,
  INSTANCE_LOCK_NAME,
  RELEASED_FALLBACK_MS,
  scanWhenReady,
  STEAL_MARKER_KEY,
  type ChannelLike,
  type InstanceLock,
  type InstanceLockDeps,
  type LocksLike,
  type MarkerStorage,
} from '../../src/session/instance-lock';
import type { ConnectionState } from '../../src/storage/db';
import { assertWritable, fenceWrites, resetFenceForTests } from '../../src/storage/write-guard';

// Story 3.10: the instance lock with a fake Web Locks manager and a fake BroadcastChannel bus
// shared by several "tabs" (instances), and fake timers for the 3 s handover wait.

type Options = { ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal };

interface Req {
  options: Options;
  callback: (lock: unknown) => Promise<void> | void;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

const abortError = () => new DOMException('aborted', 'AbortError');

/** One origin's lock manager: one lock name, granted in request order; supports steal. */
class FakeLocks {
  holder: Req | null = null;
  waiting: Req[] = [];
  requests: Options[] = [];

  manager(): LocksLike {
    return {
      request: (name, options, callback) => {
        expect(name).toBe(INSTANCE_LOCK_NAME);
        this.requests.push(options);
        return new Promise((resolve, reject) => {
          const req: Req = { options, callback, resolve, reject };
          if (options.signal?.aborted) return reject(abortError());
          if (options.steal) {
            const stolen = this.holder;
            this.holder = null;
            stolen?.reject(abortError());
            this.grant(req);
          } else if (!this.holder) {
            this.grant(req);
          } else if (options.ifAvailable) {
            Promise.resolve(callback(null)).then(resolve, reject);
          } else {
            this.waiting.push(req);
            options.signal?.addEventListener('abort', () => {
              const i = this.waiting.indexOf(req);
              if (i >= 0) {
                this.waiting.splice(i, 1);
                reject(abortError());
              }
            });
          }
        });
      },
    };
  }

  private grant(req: Req) {
    this.holder = req;
    Promise.resolve(req.callback({ name: INSTANCE_LOCK_NAME })).then(
      (value) => {
        if (this.holder === req) this.release();
        req.resolve(value);
      },
      (err: unknown) => {
        if (this.holder === req) this.release();
        req.reject(err);
      },
    );
  }

  private release() {
    this.holder = null;
    const next = this.waiting.shift();
    if (next) this.grant(next);
  }
}

/** A BroadcastChannel bus: a message reaches every other open channel, asynchronously. */
class FakeBus {
  channels = new Set<ChannelLike>();

  create = (): ChannelLike => {
    const channel: ChannelLike = {
      onmessage: null,
      postMessage: (message) => {
        for (const other of this.channels) {
          if (other !== channel) queueMicrotask(() => other.onmessage?.({ data: message }));
        }
      },
      close: () => {
        this.channels.delete(channel);
      },
    };
    this.channels.add(channel);
    return channel;
  };
}

interface Tab {
  lock: InstanceLock;
  deps: InstanceLockDeps;
  log: string[];
  states: string[];
  connection: (state: ConnectionState) => void;
}

let locks: FakeLocks;
let bus: FakeBus;

function tab(overrides: Partial<InstanceLockDeps> = {}): Tab {
  const log: string[] = [];
  let connection: (state: ConnectionState) => void = () => {};
  const deps: InstanceLockDeps = {
    locks: locks.manager(),
    createChannel: bus.create,
    releaseForHandover: vi.fn(async () => {
      log.push('releaseForHandover');
    }),
    cancelAll: vi.fn(() => log.push('cancelAll')),
    closeDb: vi.fn(() => log.push('closeDb')),
    fenceWrites: vi.fn(() => log.push('fenceWrites')),
    onConnectionState: vi.fn((listener: (state: ConnectionState) => void) => {
      connection = listener;
      return () => {};
    }),
    reload: vi.fn(() => log.push('reload')),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    onHeld: vi.fn(),
    storage: undefined,
    now: () => Date.now(),
    ...overrides,
  };
  const lock = createInstanceLock(deps);
  const states: string[] = [];
  lock.subscribe(() => states.push(lock.getSnapshot()));
  return { lock, deps, log, states, connection: (s) => connection(s) };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

async function started(overrides: Partial<InstanceLockDeps> = {}): Promise<Tab> {
  const t = tab(overrides);
  t.lock.start();
  await settle();
  return t;
}

const SEQUENCE = ['releaseForHandover', 'cancelAll', 'closeDb', 'fenceWrites'];

beforeEach(() => {
  vi.useFakeTimers();
  locks = new FakeLocks();
  bus = new FakeBus();
  resetFenceForTests();
});

afterEach(() => {
  vi.useRealTimers();
  resetFenceForTests();
});

describe('instance lock', () => {
  it('first tab: acquiring, then held', async () => {
    const t = tab();
    expect(t.lock.getSnapshot()).toBe('acquiring');
    t.lock.start();
    await settle();
    expect(t.lock.getSnapshot()).toBe('held');
    expect(locks.requests).toEqual([{ ifAvailable: true }]);
    // Started once only.
    t.lock.start();
    expect(locks.requests).toHaveLength(1);
  });

  it('second tab: other-tab, with one request and no polling; the first keeps held', async () => {
    const first = await started();
    const second = await started();
    expect(second.lock.getSnapshot()).toBe('other-tab');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(locks.requests).toHaveLength(2);
    expect(first.lock.getSnapshot()).toBe('held');
    expect(first.log).toEqual([]);
  });

  it('Use here, idle: the holder runs the release sequence in order; the second holds at once', async () => {
    const first = await started();
    const second = await started();
    second.lock.useHere();
    expect(second.lock.getSnapshot()).toBe('handing-over');
    await settle();
    expect(first.log).toEqual(SEQUENCE);
    expect(first.lock.getSnapshot()).toBe('lost');
    expect(second.lock.getSnapshot()).toBe('held');
    expect(locks.requests.at(-1)).toMatchObject({ signal: expect.any(AbortSignal) });
    expect(locks.requests.some((o) => o.steal)).toBe(false);
    // The 3 s timer is cleared: no steal later.
    await vi.advanceTimersByTimeAsync(HANDOVER_WAIT_MS * 2);
    expect(locks.requests.some((o) => o.steal)).toBe(false);
    expect(second.lock.getSnapshot()).toBe('held');
    expect(second.deps.reload).not.toHaveBeenCalled();
  });

  it('a slow save is waited for, within the 3 s', async () => {
    let finish!: () => void;
    const first = await started({
      releaseForHandover: vi.fn(() => new Promise<void>((resolve) => (finish = resolve))),
    });
    const second = await started();
    second.lock.useHere();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(first.deps.closeDb).not.toHaveBeenCalled();
    expect(second.lock.getSnapshot()).toBe('handing-over');
    finish();
    await settle();
    expect(first.log).toEqual(['cancelAll', 'closeDb', 'fenceWrites']);
    expect(first.lock.getSnapshot()).toBe('lost');
    expect(second.lock.getSnapshot()).toBe('held');
  });

  it('unresponsive holder: after 3 s the requester steals; the holder runs the sequence on steal', async () => {
    // The holder never hears the release request.
    const deaf = (): ChannelLike => ({ onmessage: null, postMessage() {}, close() {} });
    const first = await started({ createChannel: deaf });
    const second = await started();
    second.lock.useHere();
    await vi.advanceTimersByTimeAsync(HANDOVER_WAIT_MS - 1);
    expect(second.lock.getSnapshot()).toBe('handing-over');
    expect(first.lock.getSnapshot()).toBe('held');
    await vi.advanceTimersByTimeAsync(1);
    expect(locks.requests.at(-1)).toEqual({ steal: true });
    expect(second.lock.getSnapshot()).toBe('held');
    expect(first.log).toEqual(SEQUENCE);
    expect(first.lock.getSnapshot()).toBe('lost');
    // The aborted normal request never grants later.
    expect(locks.waiting).toEqual([]);
  });

  it('a steal while the holder is mid-sequence does not run it twice', async () => {
    const first = await started({ releaseForHandover: vi.fn(() => new Promise<void>(() => {})) });
    const second = await started();
    second.lock.useHere();
    await vi.advanceTimersByTimeAsync(HANDOVER_WAIT_MS);
    expect(second.lock.getSnapshot()).toBe('held');
    expect(first.deps.releaseForHandover).toHaveBeenCalledTimes(1);
  });

  it('a stolen holder whose save never settles is lost after 3 s: db closed, writes fenced', async () => {
    const deaf = (): ChannelLike => ({ onmessage: null, postMessage() {}, close() {} });
    const first = await started({
      createChannel: deaf,
      releaseForHandover: vi.fn(() => new Promise<void>(() => {})),
      fenceWrites: vi.fn(() => {
        first.log.push('fenceWrites');
        fenceWrites();
      }),
    });
    const second = await started();
    second.lock.useHere();
    // The steal at 3 s starts the holder's sequence.
    await vi.advanceTimersByTimeAsync(HANDOVER_WAIT_MS);
    expect(second.lock.getSnapshot()).toBe('held');
    expect(first.deps.releaseForHandover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HANDOVER_WAIT_MS - 1);
    expect(first.lock.getSnapshot()).toBe('held');
    expect(first.deps.closeDb).not.toHaveBeenCalled();
    expect(() => assertWritable()).not.toThrow();
    await vi.advanceTimersByTimeAsync(1);
    expect(first.log).toEqual(['cancelAll', 'closeDb', 'fenceWrites']);
    expect(first.lock.getSnapshot()).toBe('lost');
    expect(() => assertWritable()).toThrow(AppError);
  });

  it('a steal that is refused returns to the notice, and Use here works again', async () => {
    const deaf = (): ChannelLike => ({ onmessage: null, postMessage() {}, close() {} });
    await started({ createChannel: deaf });
    const manager = locks.manager();
    let refuse = true;
    const second = await started({
      locks: {
        request: (name, options, callback) =>
          options.steal && refuse
            ? Promise.reject(new DOMException('refused', 'NotSupportedError'))
            : manager.request(name, options, callback),
      },
    });
    second.lock.useHere();
    await vi.advanceTimersByTimeAsync(HANDOVER_WAIT_MS);
    expect(second.lock.getSnapshot()).toBe('other-tab');
    refuse = false;
    second.lock.useHere();
    expect(second.lock.getSnapshot()).toBe('handing-over');
    await vi.advanceTimersByTimeAsync(HANDOVER_WAIT_MS);
    expect(second.lock.getSnapshot()).toBe('held');
  });

  it('a failing step does not stop the later steps', async () => {
    const first = await started({
      releaseForHandover: vi.fn(() => Promise.reject(new AppError('storage-failed', 'x'))),
      cancelAll: vi.fn(() => {
        throw new Error('boom');
      }),
    });
    const second = await started();
    second.lock.useHere();
    await settle();
    expect(first.deps.closeDb).toHaveBeenCalledTimes(1);
    expect(first.deps.fenceWrites).toHaveBeenCalledTimes(1);
    expect(first.lock.getSnapshot()).toBe('lost');
    expect(second.lock.getSnapshot()).toBe('held');
  });

  it('writes after handover reject instance-taken', async () => {
    await started({ fenceWrites });
    const second = await started();
    expect(() => assertWritable()).not.toThrow();
    second.lock.useHere();
    await settle();
    let caught: unknown;
    try {
      assertWritable();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('instance-taken');
  });

  it('take back: the fenced tab reloads once granted; the other shows lost', async () => {
    const first = await started();
    const second = await started();
    second.lock.useHere();
    await settle();
    first.lock.useHere();
    expect(first.lock.getSnapshot()).toBe('handing-over');
    await settle();
    expect(second.log).toEqual(SEQUENCE);
    expect(second.lock.getSnapshot()).toBe('lost');
    expect(first.deps.reload).toHaveBeenCalledTimes(1);
    // It released the lock before reloading, so the reloaded page gets it at once.
    expect(locks.holder).toBeNull();
    const reloaded = await started();
    expect(reloaded.lock.getSnapshot()).toBe('held');
  });

  it('a tab that never held mounts the app on Use here, with no reload', async () => {
    await started();
    const second = await started();
    second.lock.useHere();
    await settle();
    expect(second.deps.reload).not.toHaveBeenCalled();
    expect(second.states).toEqual(['other-tab', 'handing-over', 'held']);
  });

  it('Use here does nothing while held, acquiring or handing over', async () => {
    const t = tab();
    t.lock.useHere();
    expect(t.lock.getSnapshot()).toBe('acquiring');
    t.lock.start();
    await settle();
    t.lock.useHere();
    expect(t.lock.getSnapshot()).toBe('held');
    expect(locks.requests).toHaveLength(1);

    // A second tab clicking twice while handing over: one request and one release request.
    const posts: unknown[] = [];
    const second = await started({
      createChannel: (name) => {
        const channel = bus.create();
        const post = channel.postMessage;
        channel.postMessage = (message) => {
          posts.push(message);
          post(message);
        };
        expect(name).toBe(INSTANCE_LOCK_NAME);
        return channel;
      },
    });
    expect(locks.requests).toHaveLength(2);
    second.lock.useHere();
    second.lock.useHere();
    expect(second.lock.getSnapshot()).toBe('handing-over');
    expect(locks.requests).toHaveLength(3);
    expect(posts).toEqual([{ type: 'release-request' }]);
    await settle();
    expect(second.lock.getSnapshot()).toBe('held');
  });

  it('a release request reaching a tab that does not hold the lock is ignored', async () => {
    await started();
    const second = await started();
    const third = await started();
    third.lock.useHere();
    await settle();
    expect(second.log).toEqual([]);
    expect(second.lock.getSnapshot()).toBe('other-tab');
  });

  it('versionchange: the release sequence, then lost', async () => {
    const t = await started();
    t.connection('versionchange');
    await settle();
    expect(t.log).toEqual(SEQUENCE);
    expect(t.lock.getSnapshot()).toBe('lost');
    expect(locks.holder).toBeNull();
  });

  it('blocked: upgrade-blocked, and back to held once the database opens', async () => {
    const t = await started();
    t.connection('blocked');
    expect(t.lock.getSnapshot()).toBe('upgrade-blocked');
    t.connection('open');
    expect(t.lock.getSnapshot()).toBe('held');
  });

  it('a first request refused by the browser shows other-tab; a SecurityError, unsupported', async () => {
    const refusing = (name: string): LocksLike => ({
      request: () => Promise.reject(new DOMException('refused', name)),
    });
    const t = await started({ locks: refusing('AbortError') });
    expect(t.lock.getSnapshot()).toBe('other-tab');
    const insecure = await started({ locks: refusing('SecurityError') });
    expect(insecure.lock.getSnapshot()).toBe('unsupported');
    const throwing = await started({
      locks: {
        request: () => {
          throw new DOMException('refused', 'SecurityError');
        },
      },
    });
    expect(throwing.lock.getSnapshot()).toBe('unsupported');
  });

  it('no BroadcastChannel: unsupported, with no lock request', async () => {
    const t = tab({
      createChannel: () => {
        throw new ReferenceError('BroadcastChannel is not defined');
      },
    });
    expect(() => t.lock.start()).not.toThrow();
    await settle();
    expect(t.lock.getSnapshot()).toBe('unsupported');
    expect(locks.requests).toEqual([]);
  });

  it('dispose closes the channel', async () => {
    const close = vi.fn();
    const t = await started({
      createChannel: () => ({ onmessage: null, postMessage() {}, close }),
    });
    t.lock.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('onHeld: called once on the start grant, not for a tab that is refused', async () => {
    const first = await started();
    expect(first.deps.onHeld).toHaveBeenCalledTimes(1);
    const second = await started();
    expect(second.deps.onHeld).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first.deps.onHeld).toHaveBeenCalledTimes(1);
  });

  it('onHeld: called on the Use here grant (released or stolen), never on the holder that lost', async () => {
    const first = await started();
    const second = await started();
    second.lock.useHere();
    await settle();
    expect(second.deps.onHeld).toHaveBeenCalledTimes(1);
    expect(first.deps.onHeld).toHaveBeenCalledTimes(1);

    const deaf = (): ChannelLike => ({ onmessage: null, postMessage() {}, close() {} });
    locks = new FakeLocks();
    bus = new FakeBus();
    await started({ createChannel: deaf });
    const stealer = await started();
    stealer.lock.useHere();
    await vi.advanceTimersByTimeAsync(HANDOVER_WAIT_MS);
    expect(stealer.lock.getSnapshot()).toBe('held');
    expect(stealer.deps.onHeld).toHaveBeenCalledTimes(1);
  });

  it('onHeld: a take-back that reloads is not a grant the app runs under', async () => {
    const first = await started();
    const second = await started();
    second.lock.useHere();
    await settle();
    first.lock.useHere();
    await settle();
    expect(first.deps.reload).toHaveBeenCalledTimes(1);
    expect(first.deps.onHeld).toHaveBeenCalledTimes(1);
  });

  it('onHeld: a throw does not stop the hold', async () => {
    const t = await started({
      onHeld: vi.fn(() => {
        throw new Error('boom');
      }),
    });
    expect(t.lock.getSnapshot()).toBe('held');
  });

  it('no Web Locks: unsupported, with no channel', async () => {
    const createChannel = vi.fn(bus.create);
    const t = tab({ locks: undefined, createChannel });
    t.lock.start();
    await settle();
    expect(t.lock.getSnapshot()).toBe('unsupported');
    expect(createChannel).not.toHaveBeenCalled();
  });
});

// Story 5.3: a grant by steal waits for the old holder's `released` (or the fallback) before the
// recovery scan; every other grant is ready at once. Replaces story 3.11's fixed 3.5 s delay
// test ("the app-wide onHeld scans once, RECOVERY_SCAN_DELAY_MS after the grant").

/** A sessionStorage stand-in shared by the pages of one tab. */
class FakeStorage implements MarkerStorage {
  items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

/** `onHeld` that records when each grant's `ready` resolved (fake-timer ms after `t0`). */
function readyLog() {
  const t0 = Date.now();
  const readyAt: (number | null)[] = [];
  const onHeld = vi.fn((ready: Promise<void>) => {
    const i = readyAt.push(null) - 1;
    void ready.then(() => (readyAt[i] = Date.now() - t0));
  });
  return { onHeld, readyAt };
}

/** A channel on the bus that logs what it posts. */
function loggingChannel(posts: unknown[]) {
  return () => {
    const channel = bus.create();
    const post = channel.postMessage;
    channel.postMessage = (message) => {
      posts.push(message);
      post(message);
    };
    return channel;
  };
}

describe('released and the scan wait (story 5.3)', () => {
  it('plain start: ready at once, with no release-query', async () => {
    const posts: unknown[] = [];
    const ready = readyLog();
    await started({ onHeld: ready.onHeld, createChannel: loggingChannel(posts) });
    expect(ready.readyAt).toEqual([0]);
    expect(posts).toEqual([]);
  });

  it('cooperative Use here: ready at once on the grant', async () => {
    await started();
    const posts: unknown[] = [];
    const ready = readyLog();
    const second = await started({ onHeld: ready.onHeld, createChannel: loggingChannel(posts) });
    second.lock.useHere();
    await settle();
    expect(second.lock.getSnapshot()).toBe('held');
    expect(ready.readyAt).toEqual([0]);
    expect(posts).toEqual([{ type: 'release-request' }]);
  });

  it('the holder posts released once its release sequence ends', async () => {
    const posts: unknown[] = [];
    const first = await started({ createChannel: loggingChannel(posts) });
    const second = await started();
    second.lock.useHere();
    await settle();
    expect(first.lock.getSnapshot()).toBe('lost');
    expect(posts).toEqual([{ type: 'released', at: Date.now() }]);
  });

  it('steal: the scan waits for released, posted when the old sequence ends (2.5 s later)', async () => {
    const posts: unknown[] = [];
    const first = await started({
      ignoreReleaseRequests: () => true,
      releaseForHandover: vi.fn(() => new Promise<void>((r) => setTimeout(r, 2_500))),
      createChannel: loggingChannel(posts),
    });
    const ready = readyLog();
    const second = await started({ onHeld: ready.onHeld });
    second.lock.useHere();
    await vi.advanceTimersByTimeAsync(HANDOVER_WAIT_MS);
    // The release request was ignored: stolen at 3 s.
    expect(locks.requests.at(-1)).toEqual({ steal: true });
    expect(second.lock.getSnapshot()).toBe('held');
    expect(first.deps.releaseForHandover).toHaveBeenCalledTimes(1);
    expect(ready.readyAt).toEqual([null]);
    await vi.advanceTimersByTimeAsync(2_499);
    expect(ready.readyAt).toEqual([null]);
    expect(posts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.lock.getSnapshot()).toBe('lost');
    expect(posts).toEqual([{ type: 'released', at: Date.now() }]);
    expect(ready.readyAt).toEqual([HANDOVER_WAIT_MS + 2_500]);
  });

  it('steal: the stealer posts release-query; a tab whose sequence is done answers it', async () => {
    const first = await started({ ignoreReleaseRequests: () => true });
    const posts: unknown[] = [];
    const ready = readyLog();
    const second = await started({ onHeld: ready.onHeld, createChannel: loggingChannel(posts) });
    second.lock.useHere();
    await vi.advanceTimersByTimeAsync(HANDOVER_WAIT_MS);
    expect(posts).toEqual([{ type: 'release-request' }, { type: 'release-query' }]);
    await settle();
    expect(first.lock.getSnapshot()).toBe('lost');
    expect(ready.readyAt).toEqual([HANDOVER_WAIT_MS]);
    // A query after the sequence has ended is answered at once.
    const heard = vi.fn();
    const probe = bus.create();
    probe.onmessage = heard;
    probe.postMessage({ type: 'release-query' });
    await settle();
    expect(heard).toHaveBeenCalledWith({ data: { type: 'released', at: Date.now() } });
  });

  it('a tab lost in an earlier handover answers first: its older released is not the one waited for', async () => {
    // A held, B took over (A lost, released long ago); now C steals from a slow B.
    const a = await started();
    const b = await started({
      ignoreReleaseRequests: () => true,
      releaseForHandover: vi.fn(() => new Promise<void>((r) => setTimeout(r, 2_000))),
    });
    b.lock.useHere();
    await settle();
    expect(a.lock.getSnapshot()).toBe('lost');
    expect(b.lock.getSnapshot()).toBe('held');
    await vi.advanceTimersByTimeAsync(10_000);
    const ready = readyLog();
    const c = await started({ onHeld: ready.onHeld });
    c.lock.useHere();
    await vi.advanceTimersByTimeAsync(HANDOVER_WAIT_MS);
    expect(c.lock.getSnapshot()).toBe('held');
    // A answers C's query at once, with its old time: not counted.
    await settle();
    expect(ready.readyAt).toEqual([null]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(b.lock.getSnapshot()).toBe('lost');
    expect(ready.readyAt).toEqual([HANDOVER_WAIT_MS + 2_000]);
  });

  it('a released without a time is ignored', async () => {
    const deaf = (): ChannelLike => ({ onmessage: null, postMessage() {}, close() {} });
    await started({ createChannel: deaf });
    const ready = readyLog();
    const second = await started({ onHeld: ready.onHeld });
    second.lock.useHere();
    await vi.advanceTimersByTimeAsync(HANDOVER_WAIT_MS);
    bus.create().postMessage({ type: 'released' });
    await settle();
    expect(ready.readyAt).toEqual([null]);
  });

  it('a tab that never held, or holds still, does not answer release-query', async () => {
    const holder = await started();
    const waiting = await started();
    const heard = vi.fn();
    const probe = bus.create();
    probe.onmessage = heard;
    probe.postMessage({ type: 'release-query' });
    await settle();
    expect(heard).not.toHaveBeenCalled();
    expect(holder.lock.getSnapshot()).toBe('held');
    expect(waiting.lock.getSnapshot()).toBe('other-tab');
  });

  it('fallback: a steal with no released ever runs the scan at 30 s', async () => {
    const deaf = (): ChannelLike => ({ onmessage: null, postMessage() {}, close() {} });
    await started({ createChannel: deaf });
    const ready = readyLog();
    const second = await started({ onHeld: ready.onHeld });
    second.lock.useHere();
    await vi.advanceTimersByTimeAsync(HANDOVER_WAIT_MS);
    expect(second.lock.getSnapshot()).toBe('held');
    await vi.advanceTimersByTimeAsync(RELEASED_FALLBACK_MS - 1);
    expect(ready.readyAt).toEqual([null]);
    await vi.advanceTimersByTimeAsync(1);
    expect(ready.readyAt).toEqual([HANDOVER_WAIT_MS + RELEASED_FALLBACK_MS]);
  });

  it('steal then reload: the reloaded page queries, hears released and scans; no 30 s wait', async () => {
    const storage = new FakeStorage();
    const first = await started({ storage });
    const second = await started({ ignoreReleaseRequests: () => true });
    second.lock.useHere();
    await settle();
    // The cooperative handover fenced the first; the second ignores release requests.
    expect(first.lock.getSnapshot()).toBe('lost');
    first.lock.useHere();
    await vi.advanceTimersByTimeAsync(HANDOVER_WAIT_MS);
    expect(first.deps.reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem(STEAL_MARKER_KEY)).toBe(String(Date.now()));
    await settle();
    expect(second.lock.getSnapshot()).toBe('lost');

    // The reloaded page: same sessionStorage, a new instance.
    first.lock.dispose();
    await vi.advanceTimersByTimeAsync(200);
    const posts: unknown[] = [];
    const ready = readyLog();
    const reloaded = await started({
      storage,
      onHeld: ready.onHeld,
      createChannel: loggingChannel(posts),
    });
    expect(reloaded.lock.getSnapshot()).toBe('held');
    expect(posts).toEqual([{ type: 'release-query' }]);
    expect(ready.readyAt).toEqual([0]);
    // The marker is read once.
    expect(storage.getItem(STEAL_MARKER_KEY)).toBeNull();
  });

  it('steal then reload: with no answer the reloaded page waits what is left of 30 s', async () => {
    const storage = new FakeStorage();
    storage.setItem(STEAL_MARKER_KEY, String(Date.now() - 10_000));
    const ready = readyLog();
    await started({ storage, onHeld: ready.onHeld });
    await vi.advanceTimersByTimeAsync(RELEASED_FALLBACK_MS - 10_000 - 1);
    expect(ready.readyAt).toEqual([null]);
    await vi.advanceTimersByTimeAsync(1);
    expect(ready.readyAt).toEqual([RELEASED_FALLBACK_MS - 10_000]);
  });

  it('a stale marker, an unreadable one or a throwing sessionStorage: no wait', async () => {
    const stale = new FakeStorage();
    stale.setItem(STEAL_MARKER_KEY, String(Date.now() - RELEASED_FALLBACK_MS));
    const a = readyLog();
    await started({ storage: stale, onHeld: a.onHeld });
    expect(a.readyAt).toEqual([0]);
    expect(stale.getItem(STEAL_MARKER_KEY)).toBeNull();

    locks = new FakeLocks();
    const junk = new FakeStorage();
    junk.setItem(STEAL_MARKER_KEY, 'x');
    const b = readyLog();
    await started({ storage: junk, onHeld: b.onHeld });
    expect(b.readyAt).toEqual([0]);

    locks = new FakeLocks();
    const throwing: MarkerStorage = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      removeItem: () => {},
    };
    const c = readyLog();
    await started({ storage: throwing, onHeld: c.onHeld });
    expect(c.readyAt).toEqual([0]);
  });

  it('a reloaded page that is not granted the lock drops the steal marker', async () => {
    await started();
    const storage = new FakeStorage();
    storage.setItem(STEAL_MARKER_KEY, String(Date.now()));
    const t = await started({ storage });
    expect(t.lock.getSnapshot()).toBe('other-tab');
    expect(storage.getItem(STEAL_MARKER_KEY)).toBeNull();
  });

  it('steal then reload with a throwing sessionStorage: the reload still happens', async () => {
    const throwing: MarkerStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
      removeItem: () => {},
    };
    const first = await started({ storage: throwing });
    const second = await started({ ignoreReleaseRequests: () => true });
    second.lock.useHere();
    await settle();
    first.lock.useHere();
    await vi.advanceTimersByTimeAsync(HANDOVER_WAIT_MS);
    expect(first.deps.reload).toHaveBeenCalledTimes(1);
  });

  it('a cooperative take-back that reloads leaves no marker', async () => {
    const storage = new FakeStorage();
    const first = await started({ storage });
    const second = await started();
    second.lock.useHere();
    await settle();
    first.lock.useHere();
    await settle();
    expect(first.deps.reload).toHaveBeenCalledTimes(1);
    expect(storage.items.size).toBe(0);
  });

  it('the app-wide onHeld (scanWhenReady) scans once, when ready resolves', async () => {
    const scan = vi.fn();
    let release!: () => void;
    const ready = new Promise<void>((r) => (release = r));
    scanWhenReady(scan)(ready);
    await settle();
    expect(scan).not.toHaveBeenCalled();
    release();
    await settle();
    expect(scan).toHaveBeenCalledTimes(1);
    // Wired through a lock: a plain start scans at once.
    const atStart = vi.fn();
    await started({ onHeld: scanWhenReady(atStart) });
    expect(atStart).toHaveBeenCalledTimes(1);
  });
});
