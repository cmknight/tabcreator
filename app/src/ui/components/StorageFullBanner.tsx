import { useEffect, useRef, useSyncExternalStore } from 'react';
import { recordingSession } from '../../session/recording-session';
import { announce } from '../a11y/announcer';
import { strings } from '../strings';
import styles from './StorageFullBanner.module.css';

/**
 * The storage-full error banner (story 3.9, CAP-25): shown on Record after a take was stopped
 * because storage is full, until the next take starts. Links to the Library, where takes or
 * their audio can be deleted; no Dismiss. Not a live region (AD-18): it announces its text
 * assertively through the shared announcer each time it appears, including when it mounts
 * showing.
 */
export function StorageFullBanner() {
  const { storageFull } = useSyncExternalStore(
    recordingSession.subscribe,
    recordingSession.getSnapshot,
  );

  const announced = useRef(false);
  useEffect(() => {
    if (announced.current === storageFull) return;
    announced.current = storageFull;
    if (storageFull) announce(strings['record.storageFull'], 'assertive');
  }, [storageFull]);

  if (!storageFull) return null;
  return (
    <div className={styles.banner} data-testid="storage-full-banner">
      <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M12 7v6M12 16.5v.5" stroke="currentColor" strokeWidth="2" />
      </svg>
      <p className={styles.text}>{strings['record.storageFull']}</p>
      <a className={styles.link} href="#/library">
        {strings['record.storageFullLibrary']}
      </a>
    </div>
  );
}
