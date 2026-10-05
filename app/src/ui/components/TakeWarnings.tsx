// The Tab screen's warning banners (story "Flags, warnings and bar lines on screen"; EXPERIENCE.md
// Tuning off, Drop tuning, Every note uncertain, Too loud; DESIGN.md Banners), all from the
// persisted take and tab, in this order:
// - Tuning off: |take.warnings.tuningOffsetCents| ≥ 40, with an "Open tuner" link; dismissible.
// - Drop tuning: take.warnings.belowRangeNotes > 0; dismissible.
// - Every note uncertain: the tab has notes and every one is low-confidence.
// - Clipping: take.clipped.
// Clipping is a fact of the recording, so it shows whenever the take does (also while analysing
// or after a failure); the other three come from an analysis and show only with a committed tab
// (`notes` non-null).
// Dismissal is the screen's state for this visit only (never persisted), so a dismissed banner
// returns when the take is reopened; a re-analysis replaces `warnings`, which clears it for good.
// Not live regions (spine AD-18): each banner announces its text once, politely, through the
// shared announcer when it first shows on this visit.

import { useEffect, useRef } from 'react';
import type { Note, Take } from '../../model/types';
import { announce } from '../a11y/announcer';
import { strings } from '../strings';
import banner from './banner.module.css';
import { WarnIcon } from './icons';
import styles from './TakeWarnings.module.css';

/** The tuning offset, in cents either way, from which the tuning-off warning shows. */
export const TUNING_WARN_CENTS = 40;

/** The warnings a player can dismiss for the visit. */
export type DismissibleWarning = 'tuning' | 'drop';

type WarningKind = DismissibleWarning | 'uncertain' | 'clipped';

interface ShownWarning {
  kind: WarningKind;
  text: string;
}

/**
 * The warnings `take` and its `notes` call for, in display order, before any dismissal. `notes`
 * is null while no analysis is shown (analysing, failed): then only clipping can show.
 */
export function takeWarnings(take: Take, notes: readonly Note[] | null): ShownWarning[] {
  const shown: ShownWarning[] = [];
  if (notes !== null) {
    const cents = take.warnings?.tuningOffsetCents;
    if (
      typeof cents === 'number' &&
      Number.isFinite(cents) &&
      Math.abs(cents) >= TUNING_WARN_CENTS
    ) {
      shown.push({ kind: 'tuning', text: strings['tab.tuningOff'](cents) });
    }
    if ((take.warnings?.belowRangeNotes ?? 0) > 0) {
      shown.push({ kind: 'drop', text: strings['tab.dropTuning'] });
    }
    if (notes.length > 0 && notes.every((n) => n.lowConfidence)) {
      shown.push({ kind: 'uncertain', text: strings['tab.allUncertain'] });
    }
  }
  if (take.clipped) shown.push({ kind: 'clipped', text: strings['tab.clipped'] });
  return shown;
}

export interface TakeWarningsProps {
  take: Take;
  /** The committed tab's notes, or null while no analysis is shown. */
  notes: readonly Note[] | null;
  dismissed: ReadonlySet<DismissibleWarning>;
  onDismiss(kind: DismissibleWarning): void;
  /** Moves focus somewhere that stays (the screen's heading) before a dismissed banner goes. */
  focusAfterDismiss(): void;
}

export function TakeWarnings({
  take,
  notes,
  dismissed,
  onDismiss,
  focusAfterDismiss,
}: TakeWarningsProps) {
  const shown = takeWarnings(take, notes).filter(
    (w) => !(w.kind === 'tuning' || w.kind === 'drop') || !dismissed.has(w.kind),
  );

  // Once per banner text per visit (the ref survives StrictMode's effect re-run).
  const announced = useRef(new Set<string>());
  const texts = shown.map((w) => w.text).join('\n');
  useEffect(() => {
    if (texts === '') return;
    for (const text of texts.split('\n')) {
      if (announced.current.has(text)) continue;
      announced.current.add(text);
      announce(text);
    }
  }, [texts]);

  if (shown.length === 0) return null;
  return (
    <div className={styles.warnings}>
      {shown.map((w) => (
        <div
          key={w.kind}
          className={`${banner.banner} ${banner.warning} ${styles.banner}`}
          data-testid={`tab-warning-${w.kind}`}
        >
          <WarnIcon className={banner.icon} />
          <p className={banner.text}>{w.text}</p>
          {w.kind === 'tuning' && (
            <a className={styles.link} href="#/tuner">
              {strings['tab.openTuner']}
            </a>
          )}
          {(w.kind === 'tuning' || w.kind === 'drop') && (
            <button
              type="button"
              className={styles.dismiss}
              aria-label={
                strings[w.kind === 'tuning' ? 'tab.dismissTuning' : 'tab.dismissDropTuning']
              }
              onClick={() => {
                // The button goes with the banner: hand focus on first.
                focusAfterDismiss();
                onDismiss(w.kind as DismissibleWarning);
              }}
            >
              {strings['global.dismiss']}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
