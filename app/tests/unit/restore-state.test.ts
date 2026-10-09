import { afterEach, describe, expect, it } from 'vitest';
import {
  beginRestore,
  isRestoreRunning,
  resetRestoreStateForTests,
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
});
