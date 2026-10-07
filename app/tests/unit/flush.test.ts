import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushAll, registerFlush, registeredFlushCount } from '../../src/session/flush';
import { deferred } from './helpers';

// Story "Update available prompt" (spine AD-16): the app-wide flush an app reload awaits.

describe('flushAll', () => {
  const removals: (() => void)[] = [];
  const register = (flush: () => Promise<unknown> | void) => {
    const remove = registerFlush(flush);
    removals.push(remove);
    return remove;
  };
  afterEach(() => {
    for (const remove of removals.splice(0)) remove();
  });

  it('runs every registered flush at once and resolves when all have settled', async () => {
    const before = registeredFlushCount();
    const one = deferred<void>();
    const two = deferred<void>();
    const a = vi.fn(() => one.promise);
    const b = vi.fn(() => two.promise);
    register(a);
    register(b);
    expect(registeredFlushCount()).toBe(before + 2);
    let done = false;
    const all = flushAll().then(() => {
      done = true;
    });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    one.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    two.resolve();
    await all;
    expect(done).toBe(true);
  });

  it('never rejects: a failing or throwing flush does not stop the others', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ok = vi.fn(async () => {});
    register(() => Promise.reject(new Error('boom')));
    register(() => {
      throw new Error('sync boom');
    });
    register(ok);
    await expect(flushAll()).resolves.toBeUndefined();
    expect(ok).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('a removed flush no longer runs; the same function registered twice runs twice', async () => {
    const fn = vi.fn(async () => {});
    const first = register(fn);
    register(fn);
    await flushAll();
    expect(fn).toHaveBeenCalledTimes(2);
    first();
    first(); // again: nothing
    await flushAll();
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
