import { useId, useState, useSyncExternalStore } from 'react';
import {
  COUNT_IN_BPM_MAX,
  COUNT_IN_BPM_MIN,
  recordingSession,
} from '../../session/recording-session';
import { strings } from '../strings';
import buttons from './buttons.module.css';
import styles from './CountInControls.module.css';

/**
 * The count-in row (EXPERIENCE.md Count-in controls; mockup record.html .countin): a pressed-style
 * "Count-in" toggle and the Tempo field (40–240 BPM). Both read and save the `countIn` pref
 * through the recording store, and both are disabled during a count-in and while recording. A
 * typed tempo is committed on blur or Enter, clamped to the range by the store.
 */
export function CountInControls() {
  const { recording, countIn } = useSyncExternalStore(
    recordingSession.subscribe,
    recordingSession.getSnapshot,
  );
  const id = useId();
  /** The tempo being typed; null shows the stored one. */
  const [draft, setDraft] = useState<string | null>(null);
  const disabled = recording !== 'idle';

  const commit = () => {
    if (draft === null) return;
    const value = draft.trim() === '' ? NaN : Number(draft);
    recordingSession.setCountIn({ bpm: value });
    setDraft(null);
  };

  return (
    <div className={styles.row}>
      <button
        type="button"
        className={`${buttons.secondary} ${buttons.toggle}`}
        aria-pressed={countIn.on}
        disabled={disabled}
        onClick={() => recordingSession.setCountIn({ on: !countIn.on })}
      >
        {strings['record.countIn']}
      </button>
      <div className={styles.field}>
        <label htmlFor={id}>{strings['record.tempo']}</label>
        <input
          id={id}
          className={styles.input}
          type="number"
          inputMode="numeric"
          min={COUNT_IN_BPM_MIN}
          max={COUNT_IN_BPM_MAX}
          step={1}
          value={draft ?? String(countIn.bpm)}
          disabled={disabled}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
        />
        <span className={styles.unit}>{strings['record.bpm']}</span>
      </div>
    </div>
  );
}
