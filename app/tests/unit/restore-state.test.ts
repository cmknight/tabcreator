import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginRestore,
  isRestoreRunning,
  resetRestoreStateForTests,
  subscribeRestore,
} from '../../src/storage/restore-state';

afterEach(() => resetRestoreStateForTests());

// Story "Streaming restore and restore races": storage's "a restore is running" signal.
describe('restore-state', () => {
  it('is on from beginRestore until its end call, which runs once', () => {
    expect(isRestoreRunning()).toBe(false);
    const end = beginRestore();
    expect(isRestoreRunning()).toBe(true);
    end();
    expect(isRestoreRunning()).toBe(false);
    const other = beginRestore();
    end();
    expect(isRestoreRunning()).toBe(true);
    other();
    expect(isRestoreRunning()).toBe(false);
  });

  it('notifies listeners when it turns on and off, until unsubscribed', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeRestore(listener);
    const first = beginRestore();
    const second = beginRestore();
    expect(listener).toHaveBeenCalledTimes(1);
    second();
    first();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    beginRestore()();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('a throwing listener is logged; the signal still turns on and off, others still hear it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    subscribeRestore(() => {
      throw new Error('listener');
    });
    const other = vi.fn();
    subscribeRestore(other);
    const end = beginRestore();
    expect(isRestoreRunning()).toBe(true);
    expect(() => end()).not.toThrow();
    expect(isRestoreRunning()).toBe(false);
    expect(other).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
