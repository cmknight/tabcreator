import { useEffect, useRef, useSyncExternalStore } from 'react';
import { recordingSession } from '../../session/recording-session';
import { strings } from '../strings';
import styles from './Screen.module.css';
import recordStyles from './Record.module.css';

export function Record() {
  const { mic } = useSyncExternalStore(recordingSession.subscribe, recordingSession.getSnapshot);
  return (
    <section className={styles.screen}>
      <h1 className={styles.title}>{strings['record.title']}</h1>
      {mic === 'live' ? <LevelBar /> : <MicSetupCard requesting={mic === 'requesting'} />}
    </section>
  );
}

function MicSetupCard({ requesting }: { requesting: boolean }) {
  return (
    <section className={recordStyles.setup} aria-labelledby="mic-setup-title">
      <svg className={recordStyles.setupIcon} viewBox="0 0 24 24" aria-hidden="true">
        <rect
          x="9"
          y="3"
          width="6"
          height="11"
          rx="3"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path
          d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      <h2 id="mic-setup-title" className={recordStyles.setupTitle}>
        {strings['record.micSetupTitle']}
      </h2>
      <p className={recordStyles.setupText}>{strings['record.micSetupText']}</p>
      <button
        type="button"
        className={recordStyles.primary}
        disabled={requesting}
        onClick={() => void recordingSession.allowMic()}
      >
        {strings['record.allowMic']}
      </button>
    </section>
  );
}

/** Plain linear RMS bar; story 2.6 adds the dBFS scale, peak hold and zones. */
function LevelBar() {
  const meterRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const level = Math.min(1, recordingSession.readLevel());
      meterRef.current?.setAttribute('aria-valuenow', level.toFixed(4));
      if (fillRef.current) fillRef.current.style.transform = `scaleX(${level})`;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className={recordStyles.meter}>
      <span id="input-level-label" className={recordStyles.meterLabel}>
        {strings['record.inputLevel']}
      </span>
      <div
        ref={meterRef}
        className={recordStyles.track}
        role="meter"
        aria-labelledby="input-level-label"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={0}
        data-testid="input-level"
      >
        <div ref={fillRef} className={recordStyles.fill} />
      </div>
    </div>
  );
}
