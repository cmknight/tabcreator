import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/model/errors';
import type { Prefs } from '../../src/model/types';
import { createSettingsSession } from '../../src/session/settings-session';
import { DEFAULT_PREFS, loadPrefs, PREFS_KEY } from '../../src/storage/prefs';

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

describe('settings session prefs (Bar lines)', () => {
  const version = () => new Promise<string>(() => {});

  afterEach(() => {
    localStorage.clear();
  });

  it('loads the stored prefs into the snapshot; bar lines default on', () => {
    expect(createSettingsSession({ version }).getSnapshot().prefs.barLines).toBe(true);
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...DEFAULT_PREFS, barLines: false }));
    expect(createSettingsSession({ version }).getSnapshot().prefs.barLines).toBe(false);
  });

  it('setBarLines writes prefs.barLines, publishes, and survives a reload (a new session)', () => {
    const session = createSettingsSession({ version });
    const listener = vi.fn();
    session.subscribePrefs(listener);
    session.setBarLines(false);
    expect(session.getSnapshot().prefs.barLines).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(loadPrefs().barLines).toBe(false);
    expect(createSettingsSession({ version }).getSnapshot().prefs.barLines).toBe(false);
    session.setBarLines(false); // unchanged: nothing written or published
    expect(listener).toHaveBeenCalledTimes(1);
    session.setBarLines(true);
    expect(loadPrefs().barLines).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps other writers' fields: only barLines is patched", () => {
    const session = createSettingsSession({ version });
    // recording-session writes the count-in after this store loaded its snapshot.
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ ...DEFAULT_PREFS, countIn: { on: true, bpm: 90 } }),
    );
    session.setBarLines(false);
    expect(loadPrefs()).toMatchObject({ barLines: false, countIn: { on: true, bpm: 90 } });
  });

  it('a failed write still changes the setting for this session', () => {
    const prefs: Prefs = { ...DEFAULT_PREFS };
    const session = createSettingsSession(
      { version },
      {
        loadPrefs: () => prefs,
        updatePrefs: () => {
          throw new AppError('storage-full', 'full');
        },
      },
    );
    session.setBarLines(false);
    expect(session.getSnapshot().prefs.barLines).toBe(false);
  });

  it('subscribePrefs does not ask the engine for its version', () => {
    const v = vi.fn(version);
    const session = createSettingsSession({ version: v });
    session.subscribePrefs(() => {});
    expect(v).not.toHaveBeenCalled();
    session.subscribe(() => {});
    expect(v).toHaveBeenCalledTimes(1);
  });
});
