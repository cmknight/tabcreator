import { useEffect, useRef, useSyncExternalStore } from 'react';
import { recordingSession } from '../../session/recording-session';
import { announce } from '../a11y/announcer';
import { strings } from '../strings';
import styles from './InputQualityBanner.module.css';

function WarnIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3 2 20h20z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M12 10v4.5M12 17.2v.3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The input quality warning (story 2.8, US-1.2; mockup record.html (e)): shown while the mic is
 * live on an input that looks like a Bluetooth headset in call mode or runs below 44.1 kHz,
 * until Dismiss hides it for the rest of the page session. Reads `recordingSession` itself, so
 * any mic screen mounts it with no props. Not a live region (AD-18): it announces its text
 * politely through the shared announcer each time it appears, including when it mounts showing
 * (a screen the player navigates to).
 */
export function InputQualityBanner() {
  const { mic, inputQualityPoor, inputQualityDismissed } = useSyncExternalStore(
    recordingSession.subscribe,
    recordingSession.getSnapshot,
  );
  const shown = mic === 'live' && inputQualityPoor && !inputQualityDismissed;

  const announced = useRef(false);
  useEffect(() => {
    if (announced.current === shown) return;
    announced.current = shown;
    if (shown) announce(strings['global.inputQualityWarning']);
  }, [shown]);

  if (!shown) return null;
  return (
    <div className={styles.banner} data-testid="input-quality-banner">
      <WarnIcon />
      <p className={styles.text}>{strings['global.inputQualityWarning']}</p>
      <button
        type="button"
        className={styles.dismiss}
        aria-label={strings['global.inputQualityDismissLabel']}
        onClick={(e) => {
          // The button goes with the banner: hand focus to the screen's heading first.
          e.currentTarget.closest('section')?.querySelector<HTMLElement>('h1')?.focus();
          recordingSession.dismissInputQuality();
        }}
      >
        {strings['global.dismiss']}
      </button>
    </div>
  );
}
