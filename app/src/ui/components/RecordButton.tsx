import { useEffect, useState, useSyncExternalStore } from 'react';
import { recordingSession } from '../../session/recording-session';
import { announce } from '../a11y/announcer';
import { strings } from '../strings';
import styles from './RecordButton.module.css';

/** `m:ss` for a duration in ms, rounded down to the second. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * The count-in's beat number (4, 3, 2, 1), read from the store each animation frame while it
 * runs; each new beat re-renders and is announced assertively (latest wins). Null otherwise.
 */
function useCountInBeat(counting: boolean): number | null {
  const [beat, setBeat] = useState<number | null>(null);
  useEffect(() => {
    if (!counting) return;
    let frame = 0;
    let shown: number | null = null;
    const tick = () => {
      const next = recordingSession.readCountInBeat();
      if (next !== shown) {
        shown = next;
        setBeat(next);
        if (next !== null) announce(strings['record.countInBeat'](next), 'assertive');
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(frame);
      setBeat(null);
    };
  }, [counting]);
  return beat;
}

/**
 * The Record screen's hero (DESIGN.md Record button; mockups/record.html): the m:ss timer and
 * the large Record/Stop button. The elapsed time is read from the store each animation frame
 * while a take runs, and re-renders only when the shown second changes. During a count-in the
 * large beat number replaces the timer and the button reads "Cancel" (a press cancels). While
 * the take starts or stops the button is `aria-disabled` (not `disabled`), so it keeps focus.
 */
export function RecordButton() {
  const { recording, countIn } = useSyncExternalStore(
    recordingSession.subscribe,
    recordingSession.getSnapshot,
  );
  const running = recording === 'recording' || recording === 'stopping';
  const counting = recording === 'count-in';
  const busy = recording === 'starting' || recording === 'stopping';
  const [seconds, setSeconds] = useState(0);
  const beat = useCountInBeat(counting);

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
      {/* The indicator (mockup record.html .state); the button carries the state. */}
      <div
        className={counting ? `${styles.state} ${styles.counting}` : styles.state}
        aria-hidden="true"
      >
        {running && (
          <>
            <span className={styles.dot} />
            {strings['record.recording']}
          </>
        )}
        {counting && strings['record.countInState'](countIn.bpm)}
      </div>
      {counting ? (
        // Shown, and announced through the announcer (spine AD-18), never a live region here.
        <div className={styles.beat} data-testid="count-in-beat">
          {beat === null ? '' : strings['record.countInBeat'](beat)}
        </div>
      ) : (
        <div
          className={running ? styles.timer : `${styles.timer} ${styles.idle}`}
          role="timer"
          aria-label={strings['record.elapsed'](time)}
        >
          {time}
        </div>
      )}
      <button
        type="button"
        className={styles.button}
        aria-pressed={counting ? undefined : running}
        aria-disabled={busy || undefined}
        aria-label={counting ? strings['record.cancelCountIn'] : undefined}
        onClick={() => {
          if (recording === 'idle') void recordingSession.record();
          else if (recording === 'recording' || counting) void recordingSession.stop('user');
        }}
      >
        <span className={styles.disc} aria-hidden="true">
          <span className={styles.mark} />
        </span>
        {counting
          ? strings['record.cancel']
          : running
            ? strings['record.stop']
            : strings['record.record']}
      </button>
    </div>
  );
}
