// The analysis settings controls (story "Analysis settings and re-analysis", US-4.6; mockups
// tab.html (c) and settings.html): Sensitivity (a 0–1 slider in 0.05 steps between "Fewer
// notes" and "More notes", its value in an <output>), Minimum note length (20–100 ms) and
// Highest fret (12–24). Shared by the Tab screen's Analysis settings panel and the Settings
// screen's "Defaults for new takes"; the owner saves each change. The slider commits on its
// `change` (a release or a key step), the number fields on blur and on Enter (CountInControls'
// draft pattern); the owner's store clamps to the ranges. `children` (Re-analyse) ends the row.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  MAX_FRET_MAX,
  MAX_FRET_MIN,
  MIN_NOTE_MS_MAX,
  MIN_NOTE_MS_MIN,
  SENSITIVITY_MAX,
  SENSITIVITY_MIN,
  SENSITIVITY_STEP,
} from '../../model/analysis-settings';
import type { AnalysisSettings } from '../../model/types';
import { strings } from '../strings';
import styles from './AnalysisSettingsFields.module.css';

export interface AnalysisSettingsFieldsProps {
  settings: AnalysisSettings;
  /** A committed change of one field (unclamped: the owner clamps). */
  onChange(patch: Partial<AnalysisSettings>): void;
  disabled?: boolean;
  /** The Sensitivity slider's element id, for the owner to focus it (default: generated). */
  sensitivityId?: string;
  children?: ReactNode;
}

/** A number field (`unit` optional) committing its draft on blur and on Enter. */
function NumberField({
  label,
  value,
  min,
  max,
  unit,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit?: string;
  disabled: boolean;
  onCommit(value: number): void;
}) {
  const id = useId();
  /** The value being typed; null shows the stored one. */
  const [draft, setDraft] = useState<string | null>(null);
  const toNumber = (text: string) => (text.trim() === '' ? NaN : Number(text));
  const commit = () => {
    if (draft === null) return;
    onCommit(toNumber(draft));
    setDraft(null);
  };
  // A draft still typed when the field goes (Esc closing the panel) is committed, not lost.
  const latest = useRef({ draft, onCommit });
  useEffect(() => {
    latest.current = { draft, onCommit };
  });
  useEffect(
    () => () => {
      const { draft: pending, onCommit: save } = latest.current;
      if (pending !== null) save(toNumber(pending));
    },
    [],
  );
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <div className={styles.numfield}>
        <input
          id={id}
          className={styles.input}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={draft ?? String(value)}
          disabled={disabled}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
        />
        {unit && <span className={styles.unit}>{unit}</span>}
      </div>
    </div>
  );
}

export function AnalysisSettingsFields({
  settings,
  onChange,
  disabled = false,
  sensitivityId: givenId,
  children,
}: AnalysisSettingsFieldsProps) {
  const generatedId = useId();
  const sensitivityId = givenId ?? generatedId;
  const slider = useRef<HTMLInputElement | null>(null);
  /** The slider's value while it moves (input), before its change commits it; null: stored. */
  const [moving, setMoving] = useState<number | null>(null);
  const sensitivity = moving ?? settings.sensitivity;
  const commit = useRef(onChange);
  useEffect(() => {
    commit.current = onChange;
  });

  // The native `change` (a release, or a key step) commits; React's onChange is `input`.
  useEffect(() => {
    const el = slider.current;
    if (!el) return;
    const onCommit = () => {
      commit.current({ sensitivity: Number(el.value) });
      // After React's own handler for this event (it may set `moving` once more).
      queueMicrotask(() => setMoving(null));
    };
    el.addEventListener('change', onCommit);
    return () => el.removeEventListener('change', onCommit);
  }, []);

  return (
    <div className={styles.fields}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={sensitivityId}>
          {strings['global.sensitivity']}
        </label>
        <div className={styles.slider}>
          <span className={styles.end} aria-hidden="true">
            {strings['global.fewerNotes']}
          </span>
          <input
            ref={slider}
            id={sensitivityId}
            className={styles.range}
            type="range"
            min={SENSITIVITY_MIN}
            max={SENSITIVITY_MAX}
            step={SENSITIVITY_STEP}
            value={sensitivity}
            aria-valuetext={strings['global.sensitivityValueText'](sensitivity)}
            disabled={disabled}
            onChange={(e) => setMoving(Number(e.currentTarget.value))}
          />
          <span className={styles.end} aria-hidden="true">
            {strings['global.moreNotes']}
          </span>
          <output className={styles.output} htmlFor={sensitivityId}>
            {strings['global.sensitivityValue'](sensitivity)}
          </output>
        </div>
      </div>
      <NumberField
        label={strings['global.minNoteLength']}
        value={settings.minNoteMs}
        min={MIN_NOTE_MS_MIN}
        max={MIN_NOTE_MS_MAX}
        unit={strings['global.ms']}
        disabled={disabled}
        onCommit={(minNoteMs) => onChange({ minNoteMs })}
      />
      <NumberField
        label={strings['global.highestFret']}
        value={settings.maxFret}
        min={MAX_FRET_MIN}
        max={MAX_FRET_MAX}
        disabled={disabled}
        onCommit={(maxFret) => onChange({ maxFret })}
      />
      {children}
    </div>
  );
}
