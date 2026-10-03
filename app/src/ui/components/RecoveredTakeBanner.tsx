import { useEffect, useSyncExternalStore } from 'react';
import { recordingSession, type RecoveredTake } from '../../session/recording-session';
import { announce } from '../a11y/announcer';
import { formatClockTime, formatElapsed } from '../format';
import { strings } from '../strings';
import banner from './banner.module.css';
import buttons from './buttons.module.css';
import { WarnIcon } from './icons';
import styles from './RecoveredTakeBanner.module.css';

/** Takes whose banner text was announced on this page, so each is announced once. */
const announced = new Set<string>();

const sentence = (take: RecoveredTake) =>
  strings['record.recovered'](
    formatClockTime(new Date(take.createdAt)),
    formatElapsed(take.durationMs),
  );

/**
 * One recovered-take banner (story 3.11, US-3.2; mockup record.html (d)): "An unfinished take
 * from 9:14 pm was recovered (3:02)" with Open and Discard. While Open rebuilds the take it
 * reads "Recovering…" and both buttons are `aria-disabled`. Not a live region (AD-18): the
 * sentence is announced once, politely, through the shared announcer.
 */
export function RecoveredTakeBanner({ take }: { take: RecoveredTake }) {
  const text = sentence(take);
  const textId = `recovered-${take.id}`;

  useEffect(() => {
    if (announced.has(take.id)) return;
    announced.add(take.id);
    announce(text);
  }, [take.id, text]);

  return (
    <div
      className={`${banner.banner} ${banner.warning} ${styles.banner}`}
      data-testid="recovered-take-banner"
      data-recovered-id={take.id}
    >
      <WarnIcon className={banner.icon} />
      <p className={`${banner.text} ${styles.text}`} id={textId}>
        {take.opening ? strings['record.recovering'] : text}
      </p>
      <div className={styles.actions}>
        <button
          type="button"
          className={`${buttons.secondary} ${styles.action}`}
          aria-disabled={take.opening || undefined}
          aria-describedby={textId}
          onClick={() => {
            if (take.opening) return;
            void recordingSession.openRecovered(take.id);
          }}
        >
          {strings['record.recoveredOpen']}
        </button>
        <button
          type="button"
          className={`${buttons.secondary} ${styles.action}`}
          aria-disabled={take.opening || undefined}
          aria-describedby={textId}
          onClick={(e) => {
            if (take.opening) return;
            const heading = e.currentTarget.closest('section')?.querySelector<HTMLElement>('h1');
            // The banner goes once the take is deleted: focus moves to the heading first.
            void recordingSession.discardRecovered(take.id, () => heading?.focus());
          }}
        >
          {strings['record.recoveredDiscard']}
        </button>
      </div>
    </div>
  );
}

/** Every recovered-take banner, oldest first; above the Record screen's h1. */
export function RecoveredTakeBanners() {
  const { recovered } = useSyncExternalStore(
    recordingSession.subscribe,
    recordingSession.getSnapshot,
  );
  return (
    <>
      {recovered.map((take) => (
        <RecoveredTakeBanner key={take.id} take={take} />
      ))}
    </>
  );
}
