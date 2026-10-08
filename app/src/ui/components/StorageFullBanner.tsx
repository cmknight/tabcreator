import { useEffect, useRef, useSyncExternalStore } from 'react';
import { recordingSession } from '../../session/recording-session';
import { announce } from '../a11y/announcer';
import { strings } from '../strings';
import styles from './StorageFullBanner.module.css';
import { StorageFullBannerView } from './StorageFullBannerView';

/**
 * The storage-full error banner (story 3.9, CAP-25): shown on Record while storage is full (the
 * recording store mirrors storage/persistence.ts's one status, which only freed space clears; a
 * new take does not). It says "saved" only when a storage-full stop saved its take
 * (`storageFullSaved`); otherwise the shared Storage full text. Links to the Library, where takes or
 * their audio can be deleted; no Dismiss. Not a live region (AD-18): it announces its text
 * assertively through the shared announcer each time it appears, including when it mounts
 * showing, and again when its text changes while it shows (a storage-full stop that saved).
 * The shell's StorageNoticeAnnouncer announces the same stop on every screen; the announcer
 * drops the same text repeated within its repeat window, so it is heard once.
 */
export function StorageFullBanner() {
  const { storageFull, storageFullSaved } = useSyncExternalStore(
    recordingSession.subscribe,
    recordingSession.getSnapshot,
  );
  // "…stopped and saved" only when the take was saved (story 5.2).
  const text =
    storageFullSaved === true ? strings['record.storageFull'] : strings['global.storageFull'];

  // The text announced for this showing (null while hidden). The banner can show as soon as an
  // append fails, before the stop has saved the take: its "saved" text is announced then too.
  const announced = useRef<string | null>(null);
  useEffect(() => {
    const next = storageFull ? text : null;
    if (announced.current === next) return;
    announced.current = next;
    if (next !== null) announce(next, 'assertive');
  }, [storageFull, text]);

  if (!storageFull) return null;
  return (
    <StorageFullBannerView text={text} className={styles.banner} testId="storage-full-banner" />
  );
}
