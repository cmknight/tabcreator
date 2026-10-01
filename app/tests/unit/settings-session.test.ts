import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/model/errors';
import { createSettingsSession } from '../../src/session/settings-session';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('settings session', () => {
  it('asks for the version on first subscribe and reports ready', async () => {
    const version = vi.fn(() => Promise.resolve('0.1.0'));
    const session = createSettingsSession({ version });
    expect(version).not.toHaveBeenCalled();
    expect(session.getSnapshot().engine).toEqual({ state: 'loading' });

    const listener = vi.fn();
    session.subscribe(listener);
    session.subscribe(() => {});
    expect(version).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().engine).toEqual({ state: 'loading' });
    await flush();
    expect(session.getSnapshot().engine).toEqual({ state: 'ready', version: '0.1.0' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reports unavailable when the engine fails', async () => {
    const session = createSettingsSession({
      version: () => Promise.reject(new AppError('engine-unavailable', 'fetch failed')),
    });
    session.subscribe(() => {});
    await flush();
    expect(session.getSnapshot().engine).toEqual({ state: 'unavailable' });
  });

  it('stops notifying after unsubscribe', async () => {
    let resolve: (v: string) => void = () => {};
    const session = createSettingsSession({
      version: () => new Promise<string>((r) => (resolve = r)),
    });
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);
    unsubscribe();
    resolve('0.1.0');
    await flush();
    expect(listener).not.toHaveBeenCalled();
    expect(session.getSnapshot().engine).toEqual({ state: 'ready', version: '0.1.0' });
  });
});
