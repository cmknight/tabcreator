// Settings store (spine AD-3): the engine status shown in About, and the prefs the screens read
// from it (story "Flags, warnings and bar lines on screen": the Tab screen's Bar lines toggle,
// `prefs.barLines`). Read it with useSyncExternalStore. `recording-session` keeps its own
// `updatePrefs` calls for the mic and count-in fields; `updatePrefs` patches only the fields it
// is given, so the two never overwrite each other.
//
// Story "Analysis settings and re-analysis" (US-4.6): the Settings screen's "Defaults for new
// takes", `prefs.analysisDefaults`, which `recording-session` copies into each new take.
//
// Story "Storage protection and Library states" (6.7): `storageProtected`, whether storage is
// persisted (storage/persistence.ts), read on each `subscribe` for the Storage panel.
//
// Story "Theme toggle": `prefs.theme` (system, light or dark), the Settings screen's Appearance
// panel. `main.tsx` has `ui/theme-apply.ts`'s `followTheme` apply it to the page on each change.

import { engineClient, type EngineClient } from '../engine/engine-client';
import { clampAnalysisSettings, sameSettings } from '../model/analysis-settings';
import type { AnalysisSettings, Prefs, ThemePref } from '../model/types';
import { persistence } from '../storage/persistence';
import { loadPrefs, updatePrefs, type PrefsPatch } from '../storage/prefs';

export type EngineStatus =
  { state: 'loading' } | { state: 'ready'; version: string } | { state: 'unavailable' };

export interface SettingsSnapshot {
  engine: EngineStatus;
  /**
   * The prefs this store handles, loaded at start and kept with its own changes: `barLines`,
   * `analysisDefaults` and `theme`; the other prefs belong to their writers (recording-session)
   * and are not mirrored.
   */
  prefs: SettingsPrefs;
  /** Whether storage is persisted (false when unknown); null until read. */
  storageProtected: boolean | null;
}

/** The prefs fields settings-session handles. */
export type SettingsPrefs = Pick<Prefs, 'barLines' | 'analysisDefaults' | 'theme'>;

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
  /**
   * Changes the defaults for new takes (clamped to the UI ranges), saved to
   * `prefs.analysisDefaults` at once. A failed write shows the stored defaults again.
   */
  setAnalysisDefaults(patch: Partial<AnalysisSettings>): void;
  /**
   * Chooses the theme (system, light or dark); remembered in prefs. A failed write still changes
   * the theme for this page session; only remembering it is lost.
   */
  setTheme(pref: ThemePref): void;
}

export interface SettingsPrefsDeps {
  loadPrefs(): Prefs;
  updatePrefs(patch: PrefsPatch): Prefs;
}

export interface SettingsStorageDeps {
  /** Whether storage is persisted; false when unknown. */
  persisted(): Promise<boolean>;
}

/** The engine is asked for its version on the first subscription, not at import. */
export function createSettingsSession(
  client: Pick<EngineClient, 'version'>,
  prefsDeps: SettingsPrefsDeps = { loadPrefs, updatePrefs },
  storageDeps: SettingsStorageDeps = { persisted: () => persistence.persisted() },
): SettingsSession {
  let snapshot: SettingsSnapshot = {
    engine: { state: 'loading' },
    prefs: (() => {
      const { barLines, analysisDefaults, theme } = prefsDeps.loadPrefs();
      return { barLines, analysisDefaults, theme };
    })(),
    storageProtected: null,
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

  /** The latest protection read's number: an older read landing later is dropped. */
  let protectionSeq = 0;
  function readProtection() {
    const seq = ++protectionSeq;
    storageDeps.persisted().then(
      (persisted) => {
        if (seq === protectionSeq && snapshot.storageProtected !== persisted) {
          publish({ storageProtected: persisted });
        }
      },
      () => {
        if (seq === protectionSeq && snapshot.storageProtected !== false) {
          publish({ storageProtected: false });
        }
      },
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
      readProtection();
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
      publish({ prefs: { ...snapshot.prefs, barLines: on } });
    },
    setAnalysisDefaults(patch) {
      const current = snapshot.prefs.analysisDefaults;
      const analysisDefaults = clampAnalysisSettings({ ...current, ...patch }, current);
      if (sameSettings(analysisDefaults, current)) return;
      try {
        prefsDeps.updatePrefs({ analysisDefaults });
      } catch {
        // New takes copy the stored defaults, so the screen shows those, not the failed change.
        publish({
          prefs: { ...snapshot.prefs, analysisDefaults: prefsDeps.loadPrefs().analysisDefaults },
        });
        return;
      }
      publish({ prefs: { ...snapshot.prefs, analysisDefaults } });
    },
    setTheme(theme) {
      if (snapshot.prefs.theme === theme) return;
      try {
        prefsDeps.updatePrefs({ theme });
      } catch {
        // The theme still changes this page session; only remembering it is lost.
      }
      publish({ prefs: { ...snapshot.prefs, theme } });
    },
  };
}

export const settingsSession: SettingsSession = createSettingsSession(engineClient);
