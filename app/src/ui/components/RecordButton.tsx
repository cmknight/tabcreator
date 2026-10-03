import { useEffect, useState, useSyncExternalStore } from 'react';
import { recordingSession } from '../../session/recording-session';
import { strings } from '../strings';
import styles from './RecordButton.module.css';

/** `m:ss` for a duration in ms, rounded down to the second. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * The Record screen's hero (DESIGN.md Record button; mockups/record.html): the m:ss timer and
 * the large Record/Stop button. The elapsed time is read from the store each animation frame
 * while a take runs, and re-renders only when the shown second changes. While the take starts
 * or stops the button is `aria-disabled` (not `disabled`), so it keeps focus.
 */
export function RecordButton() {
  const { recording } = useSyncExternalStore(
    recordingSession.subscribe,
    recordingSession.getSnapshot,
  );
  const running = recording === 'recording' || recording === 'stopping';
  const busy = recording === 'starting' || recording === 'stopping';
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!running) return;
    let frame = 0;
    const tick = () => {
      setSeconds(Math.floor(recordingSession.readElapsedMs() / 1000));
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(frame);
      // A new take starts from 0:00, never from the last take's time.
      setSeconds(0);
    };
  }, [running]);

  const time = formatElapsed(seconds * 1000);
  return (
    <div className={styles.hero}>
      {/* The recording indicator (mockup record.html .state.live); the button carries the state. */}
      <div className={styles.state} aria-hidden="true">
        {running && (
          <>
            <span className={styles.dot} />
            {strings['record.recording']}
          </>
        )}
      </div>
      <div
        className={running ? styles.timer : `${styles.timer} ${styles.idle}`}
        role="timer"
        aria-label={strings['record.elapsed'](time)}
      >
        {time}
      </div>
      <button
        type="button"
        className={styles.button}
        aria-pressed={running}
        aria-disabled={busy || undefined}
        onClick={() => {
          if (recording === 'idle') void recordingSession.record();
          else if (recording === 'recording') void recordingSession.stop('user');
        }}
      >
        <span className={styles.disc} aria-hidden="true">
          <span className={styles.mark} />
        </span>
        {running ? strings['record.stop'] : strings['record.record']}
      </button>
    </div>
  );
}
