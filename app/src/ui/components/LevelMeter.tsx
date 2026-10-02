import { useEffect, useId, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { INITIAL_PEAK_HOLD, nextPeakHold } from '../../model/level-warnings';
import { recordingSession } from '../../session/recording-session';
import { announce } from '../a11y/announcer';
import { strings } from '../strings';
import styles from './LevelMeter.module.css';

/** The meter's scale, in dBFS. */
const MIN_DB = -60;
const MAX_DB = 0;
const TICKS = [-60, -48, -36, -24, -12, -3, 0] as const;
/** ARIA values change at most 4 times a second; the visual fill every animation frame. */
const ARIA_INTERVAL_MS = 250;

/** Position on the bar, 0–100 %, for `db` (clamped to the scale; -Infinity is the left end). */
function percent(db: number): number {
  const clamped = Math.min(MAX_DB, Math.max(MIN_DB, db));
  return ((clamped - MIN_DB) / (MAX_DB - MIN_DB)) * 100;
}

/** The rounded dBFS the meter reports, clamped to the scale. */
function ariaDb(db: number): number {
  return Math.round(Math.min(MAX_DB, Math.max(MIN_DB, db))) || 0;
}

function tickLabel(db: number): string {
  return db < 0 ? `−${-db}` : `${db}`;
}

function WarnIcon() {
  return (
    <svg className={styles.warnIcon} viewBox="0 0 24 24" aria-hidden="true">
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
 * The live input level meter (US-1.3, mockup record.html): −60…0 dBFS, RMS fill over fixed
 * green / amber / red zones, a 1.5 s peak-hold tick, and the Too loud / Too quiet warning as
 * icon + text under the bar. Reads the live input from `recordingSession` every animation frame;
 * the store notifies only when the warning changes. A new warning is announced politely through
 * the shared announcer (spine AD-18), so the warning line itself is not a live region. The
 * meter element is a `data-focus-target`: it takes focus when it replaces a focused card.
 */
export function LevelMeter() {
  const { levelWarning } = useSyncExternalStore(
    recordingSession.subscribe,
    recordingSession.getSnapshot,
  );
  const labelId = useId();
  const meterRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const peakRef = useRef<HTMLDivElement>(null);

  // A layout effect, and the first frame read at once: after a gap the store drops a stale
  // warning on that read, before the meter is painted.
  useLayoutEffect(() => {
    let frame = 0;
    let hold = INITIAL_PEAK_HOLD;
    let ariaAt = -Infinity;
    let ariaText = strings['global.levelValueText'](MIN_DB, null);
    const tick = () => {
      const now = performance.now();
      const { peakDb, rmsDb } = recordingSession.readLevels(now);
      hold = nextPeakHold(hold, peakDb, now);
      if (fillRef.current) {
        fillRef.current.style.clipPath = `inset(0 ${(100 - percent(rmsDb)).toFixed(2)}% 0 0)`;
      }
      if (peakRef.current) {
        peakRef.current.style.left = `${percent(hold.db).toFixed(2)}%`;
        peakRef.current.style.visibility = hold.db > MIN_DB ? 'visible' : 'hidden';
      }
      // Written only when the text changes, and at most every 250 ms, so a change after a
      // steady stretch shows at once.
      const meter = meterRef.current;
      if (meter && now - ariaAt >= ARIA_INTERVAL_MS) {
        const db = ariaDb(rmsDb);
        const text = strings['global.levelValueText'](
          db,
          recordingSession.getSnapshot().levelWarning,
        );
        if (text !== ariaText) {
          ariaAt = now;
          ariaText = text;
          meter.setAttribute('aria-valuenow', String(db));
          meter.setAttribute('aria-valuetext', text);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, []);

  // Announce each new warning once; the warning showing when the meter mounts is not new.
  const announced = useRef(levelWarning);
  useEffect(() => {
    if (announced.current === levelWarning) return;
    announced.current = levelWarning;
    if (levelWarning === 'loud') announce(strings['global.levelTooLoud']);
    else if (levelWarning === 'quiet') announce(strings['global.levelTooQuiet']);
  }, [levelWarning]);

  return (
    <div className={styles.meter}>
      <div className={styles.labelRow}>
        <span id={labelId}>{strings['global.inputLevel']}</span>
        <span className={styles.unit}>{strings['global.levelUnit']}</span>
      </div>
      <div
        ref={meterRef}
        className={styles.track}
        role="meter"
        aria-labelledby={labelId}
        aria-valuemin={MIN_DB}
        aria-valuemax={MAX_DB}
        aria-valuenow={MIN_DB}
        aria-valuetext={strings['global.levelValueText'](MIN_DB, null)}
        data-testid="input-level"
        tabIndex={-1}
        data-focus-target=""
      >
        <div ref={fillRef} className={styles.fill} data-testid="input-level-fill" />
        <div ref={peakRef} className={styles.peak} data-testid="input-level-peak" />
      </div>
      <div className={styles.scale} aria-hidden="true">
        {TICKS.map((db) => (
          <span key={db} style={{ left: `${percent(db)}%` }}>
            {tickLabel(db)}
          </span>
        ))}
      </div>
      <div className={styles.warning} data-testid="input-level-warning">
        {levelWarning && (
          <>
            <WarnIcon />
            {strings[levelWarning === 'loud' ? 'global.levelTooLoud' : 'global.levelTooQuiet']}
          </>
        )}
      </div>
    </div>
  );
}
