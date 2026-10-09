// The Settings screen (mockup settings.html): the engine-failed banner, "Defaults for new takes"
// (story "Analysis settings and re-analysis", US-4.6: the Tab screen's analysis settings fields
// without Re-analyse, saved on each change to `prefs.analysisDefaults` through settings-session;
// new takes copy them at creation), Storage (story 6.7: "Storage: protected", or "Storage: may be
// cleared by the browser" with a Back up library link to the Library) and About (the engine
// version). Story "Theme toggle": Appearance, between Defaults and Storage, with the Theme
// segmented control (System / Light / Dark, `aria-pressed`, like the Tab screen's speed control);
// a change is saved through settings-session, and `followTheme` (started in main.tsx) applies it
// to the page at once. Story "Shell reflow, focus and shortcuts help": About's Keyboard shortcuts
// button opens the shortcuts dialog (a button, as in the mockup, since it opens a dialog), beside
// the engine line in a wrapping row; the h1 takes focus after a route change (`tabIndex={-1}`).

import { useSyncExternalStore } from 'react';
import type { ThemePref } from '../../model/types';
import {
  settingsSession,
  type EngineStatus,
  type SettingsSession,
} from '../../session/settings-session';
import { AnalysisSettingsFields } from '../components/AnalysisSettingsFields';
import banner from '../components/banner.module.css';
import buttons from '../components/buttons.module.css';
import { CheckIcon, ErrorIcon, KeyboardIcon, WarnIcon } from '../components/icons';
import segmented from '../components/segmented.module.css';
import { routeToHash } from '../router';
import { reloadOrExplain } from '../reload-or-explain';
import { openShortcutsDialog } from '../shortcuts-dialog';
import { strings } from '../strings';
import styles from './Screen.module.css';
import settingsStyles from './Settings.module.css';

const THEMES: readonly { pref: ThemePref; label: string }[] = [
  { pref: 'system', label: strings['settings.themeSystem'] },
  { pref: 'light', label: strings['settings.themeLight'] },
  { pref: 'dark', label: strings['settings.themeDark'] },
];

function engineLine(engine: EngineStatus): string {
  switch (engine.state) {
    case 'ready':
      return strings['settings.engineVersion'](engine.version);
    case 'unavailable':
      return strings['settings.engineVersionUnavailable'];
    case 'loading':
      return '';
  }
}

export interface SettingsProps {
  /** The settings store; tests pass their own. */
  session?: Pick<SettingsSession, 'subscribe' | 'getSnapshot' | 'setAnalysisDefaults' | 'setTheme'>;
}

export function Settings({ session = settingsSession }: SettingsProps = {}) {
  const { engine, prefs, storageProtected } = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
  );
  return (
    <section className={styles.screen}>
      {engine.state === 'unavailable' && (
        <div className={`${banner.banner} ${banner.error} ${settingsStyles.bannerError}`}>
          <ErrorIcon className={banner.icon} />
          <p className={banner.text}>{strings['global.engineFailed']}</p>
          <button
            type="button"
            className={buttons.secondary}
            onClick={() => void reloadOrExplain()}
          >
            {strings['global.reload']}
          </button>
        </div>
      )}
      <h1 className={styles.title} tabIndex={-1}>
        {strings['settings.title']}
      </h1>
      <section className={settingsStyles.panel} aria-labelledby="settings-defaults">
        <h2 id="settings-defaults" className={settingsStyles.panelTitle}>
          {strings['settings.defaults']}
        </h2>
        <p className={settingsStyles.hint}>{strings['settings.defaultsHint']}</p>
        <AnalysisSettingsFields
          settings={prefs.analysisDefaults}
          onChange={(patch) => session.setAnalysisDefaults(patch)}
        />
      </section>
      <section className={settingsStyles.panel} aria-labelledby="settings-appearance">
        <h2 id="settings-appearance" className={settingsStyles.panelTitle}>
          {strings['settings.appearance']}
        </h2>
        <div className={settingsStyles.row}>
          <span id="settings-theme">{strings['settings.theme']}</span>
          <div role="group" aria-labelledby="settings-theme" className={segmented.segments}>
            {THEMES.map(({ pref, label }) => (
              <button
                key={pref}
                type="button"
                className={`${buttons.secondary} ${buttons.toggle} ${segmented.segment}`}
                aria-pressed={prefs.theme === pref}
                onClick={() => session.setTheme(pref)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </section>
      <section className={settingsStyles.panel} aria-labelledby="settings-storage">
        <h2 id="settings-storage" className={settingsStyles.panelTitle}>
          {strings['settings.storage']}
        </h2>
        <div className={settingsStyles.row} data-testid="storage-status">
          {storageProtected === true && (
            <span className={`${settingsStyles.stat} ${settingsStyles.ok}`}>
              <CheckIcon className={settingsStyles.statIcon} />
              {strings['settings.storageProtected']}
            </span>
          )}
          {storageProtected === false && (
            <>
              <span className={`${settingsStyles.stat} ${settingsStyles.warn}`}>
                <WarnIcon className={settingsStyles.statIcon} />
                {strings['settings.storageAtRisk']}
              </span>
              <a className={buttons.secondary} href={routeToHash({ name: 'library' })}>
                {strings['settings.storageBackUp']}
              </a>
            </>
          )}
        </div>
      </section>
      <section className={settingsStyles.panel} aria-labelledby="settings-about">
        <h2 id="settings-about" className={settingsStyles.panelTitle}>
          {strings['settings.about']}
        </h2>
        <div className={settingsStyles.row}>
          <p className={settingsStyles.engine} data-testid="engine-version">
            {engineLine(engine)}
          </p>
          <button
            type="button"
            className={`${buttons.secondary} ${settingsStyles.shortcutsButton}`}
            aria-haspopup="dialog"
            aria-keyshortcuts={strings['settings.keyboardShortcutsKey']}
            onClick={(event) => openShortcutsDialog(event.currentTarget)}
          >
            <KeyboardIcon className={settingsStyles.shortcutsIcon} />
            {strings['settings.keyboardShortcuts']}
            <kbd className={settingsStyles.kbd} aria-hidden="true">
              {strings['settings.keyboardShortcutsKey']}
            </kbd>
          </button>
        </div>
      </section>
    </section>
  );
}
