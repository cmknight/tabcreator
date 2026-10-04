import { useSyncExternalStore } from 'react';
import { settingsSession, type EngineStatus } from '../../session/settings-session';
import banner from '../components/banner.module.css';
import buttons from '../components/buttons.module.css';
import { ErrorIcon } from '../components/icons';
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

export function Settings() {
  const { engine } = useSyncExternalStore(settingsSession.subscribe, settingsSession.getSnapshot);
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
