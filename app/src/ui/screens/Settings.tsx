import { useSyncExternalStore } from 'react';
import { reloadApp } from '../../session/app-reload';
import { settingsSession, type EngineStatus } from '../../session/settings-session';
import banner from '../components/banner.module.css';
import buttons from '../components/buttons.module.css';
import { ErrorIcon } from '../components/icons';
import { strings } from '../strings';
import { showToast } from '../toast';
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

/**
 * Reload: refused while a take is recorded, saved or analysed (story 5.6), or a recovered take
 * rebuilt; a toast then says why (story 5.2), so the press is never silently ignored.
 */
export function reloadOrExplain(reload: () => boolean = reloadApp): void {
  if (!reload()) showToast({ message: strings['settings.reloadBusy'] });
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
