// The Settings screen (mockup settings.html): the engine-failed banner, "Defaults for new takes"
// (story "Analysis settings and re-analysis", US-4.6: the Tab screen's analysis settings fields
// without Re-analyse, saved on each change to `prefs.analysisDefaults` through settings-session;
// new takes copy them at creation), Storage (story 6.7: "Storage: protected", or "Storage: may be
// cleared by the browser" with a Back up library link to the Library) and About (the engine
// version).

import { useSyncExternalStore } from 'react';
import {
  settingsSession,
  type EngineStatus,
  type SettingsSession,
} from '../../session/settings-session';
import { AnalysisSettingsFields } from '../components/AnalysisSettingsFields';
import banner from '../components/banner.module.css';
import buttons from '../components/buttons.module.css';
import { CheckIcon, ErrorIcon, WarnIcon } from '../components/icons';
import { routeToHash } from '../router';
import { reloadOrExplain } from '../reload-or-explain';
import { strings } from '../strings';
import styles from './Screen.module.css';
import settingsStyles from './Settings.module.css';

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
  session?: Pick<SettingsSession, 'subscribe' | 'getSnapshot' | 'setAnalysisDefaults'>;
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
          <button type="button" className={buttons.secondary} onClick={() => reloadOrExplain()}>
            {strings['global.reload']}
          </button>
        </div>
      )}
      <h1 className={styles.title}>{strings['settings.title']}</h1>
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
        <p className={settingsStyles.engine} data-testid="engine-version">
          {engineLine(engine)}
        </p>
      </section>
    </section>
  );
}
