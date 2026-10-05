// Settings store (spine AD-3): the engine status shown in About, and the prefs the screens read
// from it (story "Flags, warnings and bar lines on screen": the Tab screen's Bar lines toggle,
// `prefs.barLines`). Read it with useSyncExternalStore. `recording-session` keeps its own
// `updatePrefs` calls for the mic and count-in fields; `updatePrefs` patches only the fields it
// is given, so the two never overwrite each other.

import { engineClient, type EngineClient } from '../engine/engine-client';
import type { Prefs } from '../model/types';
import { loadPrefs, updatePrefs, type PrefsPatch } from '../storage/prefs';

export type EngineStatus =
  { state: 'loading' } | { state: 'ready'; version: string } | { state: 'unavailable' };

export interface SettingsSnapshot {
  engine: EngineStatus;
  /**
   * The prefs this store handles, loaded at start and kept with its own changes. So far only
   * `barLines`; the other prefs belong to their writers (recording-session) and are not mirrored.
   */
  prefs: SettingsPrefs;
}

/** The prefs fields settings-session handles. */
export type SettingsPrefs = Pick<Prefs, 'barLines'>;

export interface SettingsSession {
  /** Subscribes, asking the engine for its version on the first subscription. */
  subscribe(listener: () => void): () => void;
  /**
   * Subscribes without asking the engine for its version: for screens that read only the prefs
   * (the Tab screen), so opening them never starts the engine.
   */
  subscribePrefs(listener: () => void): () => void;
  getSnapshot(): SettingsSnapshot;
  /**
   * Shows or hides bar lines on the Tab screen; remembered in prefs. A failed write still
   * changes the setting for this page session; only remembering it is lost.
   */
  setBarLines(on: boolean): void;
}

export interface SettingsPrefsDeps {
  loadPrefs(): Prefs;
  updatePrefs(patch: PrefsPatch): Prefs;
}

/** The engine is asked for its version on the first subscription, not at import. */
export function createSettingsSession(
  client: Pick<EngineClient, 'version'>,
  prefsDeps: SettingsPrefsDeps = { loadPrefs, updatePrefs },
): SettingsSession {
  let snapshot: SettingsSnapshot = {
    engine: { state: 'loading' },
    prefs: { barLines: prefsDeps.loadPrefs().barLines },
  };
  const listeners = new Set<() => void>();
  let started = false;

  function publish(patch: Partial<SettingsSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    for (const l of [...listeners]) l();
  }

  function start() {
    started = true;
    client.version().then(
      (version) => publish({ engine: { state: 'ready', version } }),
      () => publish({ engine: { state: 'unavailable' } }),
    );
  }

  function subscribePrefs(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return {
    subscribe(listener) {
      const unsubscribe = subscribePrefs(listener);
      if (!started) start();
      return unsubscribe;
    },
    subscribePrefs,
    getSnapshot: () => snapshot,
    setBarLines(on) {
      if (snapshot.prefs.barLines === on) return;
      try {
        prefsDeps.updatePrefs({ barLines: on });
      } catch {
        // The toggle still works this page session; only remembering it is lost.
      }
      publish({ prefs: { barLines: on } });
    },
  };
}

export const settingsSession: SettingsSession = createSettingsSession(engineClient);
