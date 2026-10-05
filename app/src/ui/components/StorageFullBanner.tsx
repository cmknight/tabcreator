import { useEffect, useRef, useSyncExternalStore } from 'react';
import { recordingSession } from '../../session/recording-session';
import { announce } from '../a11y/announcer';
import { strings } from '../strings';
import styles from './StorageFullBanner.module.css';
import { StorageFullBannerView } from './StorageFullBannerView';

/**
 * The storage-full error banner (story 3.9, CAP-25): shown on Record after a take was stopped
 * because storage is full (or could not be created for it), until the next take starts. It says
 * "saved" only when the take was saved (`storageFullSaved`). Links to the Library, where takes or
 * their audio can be deleted; no Dismiss. Not a live region (AD-18): it announces its text
 * assertively through the shared announcer each time it appears, including when it mounts
 * showing.
 */
export function StorageFullBanner() {
  const { storageFull, storageFullSaved } = useSyncExternalStore(
    recordingSession.subscribe,
    recordingSession.getSnapshot,
  );
  // "…stopped and saved" only when the take was saved (story 5.2).
  const text =
    storageFullSaved === true
      ? strings['record.storageFull']
      : strings['record.storageFullUnsaved'];

  const announced = useRef(false);
  useEffect(() => {
    if (announced.current === storageFull) return;
    announced.current = storageFull;
    if (storageFull) announce(text, 'assertive');
  }, [storageFull, text]);

  if (!storageFull) return null;
  return (
    <StorageFullBannerView text={text} className={styles.banner} testId="storage-full-banner" />
  );
}
