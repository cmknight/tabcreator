import { useEffect, useState, useSyncExternalStore } from 'react';
import type { StringNo } from '../../model/types';
import {
  recordingSession,
  TUNER_POLL_MS,
  type TunerDisplay,
} from '../../session/recording-session';
import { announce } from '../a11y/announcer';
import buttons from '../components/buttons.module.css';
import { CheckIcon } from '../components/icons';
import { InputQualityBanner } from '../components/InputQualityBanner';
import { LevelMeter } from '../components/LevelMeter';
import { MicGate } from '../components/MicGate';
import { MicSelect } from '../components/MicSelect';
import { formatSigned } from '../format';
import { strings } from '../strings';
import styles from './Screen.module.css';
import tunerStyles from './Tuner.module.css';

/** Chips left to right: low E to high E. */
const CHIPS: readonly StringNo[] = [6, 5, 4, 3, 2, 1];
const TICKS = [-50, -25, 0, 25, 50] as const;
const NO_PITCH: TunerDisplay = { reading: null, held: false, inTune: false };

/** Needle position on the track, 0–100 %, clamped to −50…+50 cents. */
const needlePercent = (cents: number) => Math.min(50, Math.max(-50, cents)) + 50;

function tickLabel(cents: number): string {
  return formatSigned(cents);
}

/**
 * Whether two displays render the same: the needle's 0.1 cent and the readout's whole cents
 * (2.46 and 2.54 both show 2.5 on the needle but 2 and 3 in the readout).
 */
function sameDisplay(a: TunerDisplay, b: TunerDisplay): boolean {
  if (a.inTune !== b.inTune || a.held !== b.held) return false;
  if (a.reading === null || b.reading === null) return a.reading === b.reading;
  return (
    a.reading.string === b.reading.string &&
    Math.round(a.reading.cents) === Math.round(b.reading.cents) &&
    a.reading.cents.toFixed(1) === b.reading.cents.toFixed(1)
  );
}

/**
 * The Tuner screen (US-2.1, CAP-4; mockup tuner.html): the string name, a −50…+50 cents
 * needle, the cents readout with the direction or In tune, six string chips ticked for the page
 * session, then the level meter and the microphone select, and "Done — go to Record". While the
 * mic is not live the setup card or its error variant takes the place of all of it.
 */
export function Tuner() {
  return (
    <section className={styles.screen}>
      {/* First, above the h1 (mockup order); it renders only while the mic is live. */}
      <InputQualityBanner />
      <h1 className={styles.title} tabIndex={-1}>
        {strings['tuner.title']}
      </h1>
      <MicGate>
        <TunerPanel />
        <div className={tunerStyles.inputs}>
          <div className={tunerStyles.meterBlock}>
            <LevelMeter />
          </div>
          <div className={tunerStyles.micBlock}>
            <MicSelect />
          </div>
        </div>
        <div className={tunerStyles.doneRow}>
          <a className={buttons.primary} href="#/record">
            {strings['tuner.done']}
          </a>
        </div>
      </MicGate>
    </section>
  );
}

/**
 * The tuner display. Mounted only while the mic is live (inside `MicGate`), and polls
 * `recordingSession.readTuner` every `TUNER_POLL_MS` while mounted; the store notifies only when
 * a string ticks. Nothing here is a live region (AD-18): a string entering In tune and the sixth
 * tick are announced politely through the shared announcer.
 */
function TunerPanel() {
  const { tunedStrings } = useSyncExternalStore(
    recordingSession.subscribe,
    recordingSession.getSnapshot,
  );
  const [display, setDisplay] = useState<TunerDisplay>(NO_PITCH);

  useEffect(() => {
    let inTune = false;
    const poll = () => {
      // A hidden tab throttles timers past the store's 500 ms gap, so every read would only
      // restart the machine: skip polling until the tab is visible again.
      if (document.hidden) return;
      const now = performance.now();
      const before = recordingSession.getSnapshot().tunedStrings.length;
      const next = recordingSession.readTuner(now) ?? NO_PITCH;
      if (next.inTune && !inTune && next.reading) {
        announce(strings['tuner.stringInTune'](next.reading.string));
      }
      inTune = next.inTune;
      if (
        before < CHIPS.length &&
        recordingSession.getSnapshot().tunedStrings.length >= CHIPS.length
      ) {
        // After the string's own "… in tune": the polite region speaks them in order.
        announce(strings['tuner.allInTune']);
      }
      setDisplay((shown) => (sameDisplay(shown, next) ? shown : next));
    };
    // Read at once: after a gap the store restarts the machine before anything is shown.
    poll();
    const id = setInterval(poll, TUNER_POLL_MS);
    return () => clearInterval(id);
  }, []);

  const { reading, held, inTune } = display;
  /** A held reading (no pitch in the latest frame) is drawn muted. */
  const heldClass = held ? ` ${tunerStyles.held}` : '';
  const rounded = reading ? Math.round(reading.cents) : 0;
  const allSix = CHIPS.every((s) => tunedStrings.includes(s));

  return (
    // The first focus target in MicGate: focus lands here when the panel replaces a focused card.
    <div className={tunerStyles.panel} data-testid="tuner-panel" tabIndex={-1} data-focus-target="">
      {reading ? (
        <p className={`${tunerStyles.stringName}${heldClass}`} data-testid="tuner-string">
          {strings['tuner.stringLetter'](reading.string)}
        </p>
      ) : (
        <>
          <p className={`${tunerStyles.stringName} ${tunerStyles.none}`} aria-hidden="true">
            {strings['tuner.noPitch']}
          </p>
          <p className={tunerStyles.hint}>{strings['tuner.noPitchHint']}</p>
        </>
      )}
      <div className={tunerStyles.needleWrap}>
        <div
          className={tunerStyles.track}
          role="img"
          aria-label={strings['tuner.needleLabel'](reading ? reading.cents : null)}
          data-testid="tuner-needle"
        >
          <span className={tunerStyles.line} />
          {TICKS.map((c) => (
            <span
              key={c}
              className={`${tunerStyles.tick} ${c === 0 ? tunerStyles.mid : ''}`}
              style={{ left: `${needlePercent(c)}%` }}
            />
          ))}
          {reading && (
            <span
              className={`${tunerStyles.needle}${heldClass}`}
              style={{ left: `${needlePercent(reading.cents).toFixed(2)}%` }}
              data-testid="tuner-needle-mark"
            />
          )}
        </div>
        <div className={tunerStyles.scale} aria-hidden="true">
          {TICKS.map((c) => (
            <span key={c} style={{ left: `${needlePercent(c)}%` }}>
              {tickLabel(c)}
            </span>
          ))}
        </div>
      </div>
      <div
        className={tunerStyles.readout}
        data-testid="tuner-readout"
        data-string={reading?.string}
        data-cents={reading?.cents.toFixed(1)}
      >
        {reading && (
          <>
            <span className={`${tunerStyles.cents}${heldClass}`} data-testid="tuner-cents">
              {strings['tuner.cents'](reading.cents)}
            </span>
            {/* A held reading (no pitch in the latest frame) gives no advice. */}
            {held ? null : inTune ? (
              <span className={tunerStyles.inTune} data-testid="tuner-in-tune">
                <CheckIcon className={tunerStyles.inTuneIcon} />
                {strings['tuner.inTune']}
              </span>
            ) : rounded > 0 ? (
              <span className={tunerStyles.direction}>{strings['tuner.sharp']}</span>
            ) : rounded < 0 ? (
              <span className={tunerStyles.direction}>{strings['tuner.flat']}</span>
            ) : null}
          </>
        )}
      </div>
      <ul className={tunerStyles.chips} aria-label={strings['tuner.chipsLabel']}>
        {CHIPS.map((s) => {
          const ticked = tunedStrings.includes(s);
          return (
            <li
              key={s}
              className={`${tunerStyles.chip} ${ticked ? tunerStyles.ticked : ''}`}
              aria-label={strings['tuner.chipLabel'](s, ticked)}
              data-ticked={ticked || undefined}
            >
              <span aria-hidden="true">{strings['tuner.stringLetter'](s)}</span>
              {ticked && (
                <span className={tunerStyles.badge} aria-hidden="true">
                  <CheckIcon className={tunerStyles.badgeIcon} />
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {allSix && (
        <p className={tunerStyles.allSet}>
          <CheckIcon className={tunerStyles.inTuneIcon} />
          {strings['tuner.allInTune']}
        </p>
      )}
    </div>
  );
}
