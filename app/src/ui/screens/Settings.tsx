import { useSyncExternalStore } from 'react';
import { reloadApp } from '../../session/app-reload';
import { settingsSession, type EngineStatus } from '../../session/settings-session';
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

export function Settings() {
  const { engine } = useSyncExternalStore(settingsSession.subscribe, settingsSession.getSnapshot);
  return (
    <section className={styles.screen}>
      {engine.state === 'unavailable' && (
        <div className={settingsStyles.bannerError}>
          <svg className={settingsStyles.bannerIcon} viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M12 7v6M12 16.5v.5" stroke="currentColor" strokeWidth="2" />
          </svg>
          <p className={settingsStyles.bannerText}>{strings['global.engineFailed']}</p>
          <button type="button" className={settingsStyles.button} onClick={reloadApp}>
            {strings['global.reload']}
          </button>
        </div>
      )}
      <h1 className={styles.title}>{strings['settings.title']}</h1>
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
