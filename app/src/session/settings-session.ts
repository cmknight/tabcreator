// Settings store (spine AD-3). For now it holds only the engine status shown in About; prefs
// arrive with storage/prefs.ts in a later story. Read it with useSyncExternalStore.

import { engineClient, type EngineClient } from '../engine/engine-client';

export type EngineStatus =
  { state: 'loading' } | { state: 'ready'; version: string } | { state: 'unavailable' };

export interface SettingsSnapshot {
  engine: EngineStatus;
}

export interface SettingsSession {
  subscribe(listener: () => void): () => void;
  getSnapshot(): SettingsSnapshot;
}

/** The engine is asked for its version on the first subscription, not at import. */
export function createSettingsSession(client: Pick<EngineClient, 'version'>): SettingsSession {
  let snapshot: SettingsSnapshot = { engine: { state: 'loading' } };
  const listeners = new Set<() => void>();
  let started = false;

  function set(engine: EngineStatus) {
    snapshot = { ...snapshot, engine };
    for (const l of listeners) l();
  }

  function start() {
    started = true;
    client.version().then(
      (version) => set({ state: 'ready', version }),
      () => set({ state: 'unavailable' }),
    );
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (!started) start();
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
  };
}

export const settingsSession: SettingsSession = createSettingsSession(engineClient);
