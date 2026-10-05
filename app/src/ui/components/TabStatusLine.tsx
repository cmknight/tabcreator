// The Tab screen's status line (story "Flags, warnings and bar lines on screen"; EXPERIENCE.md
// Status line; DESIGN.md Status line): "42 notes · 3 to check" in ui-small, muted, with the
// "to check" count in the warning colour while non-zero, and "Next to check" (`N`) at its right
// end, disabled with its reason while nothing is flagged. Not a live region (spine AD-18): a
// change of the counts is announced politely through the shared announcer.

import { useEffect, useId, type MutableRefObject } from 'react';
import type { Note } from '../../model/types';
import { announce } from '../a11y/announcer';
import hidden from '../a11y/visually-hidden.module.css';
import { strings } from '../strings';
import buttons from './buttons.module.css';
import styles from './TabStatusLine.module.css';

export interface TabStatusLineProps {
  notes: readonly Note[];
  onNextToCheck(): void;
  /**
   * The line last shown, held by the screen so it survives this line unmounting (a re-analysis
   * or Retry): a remount with changed counts is announced, an unchanged one is not.
   */
  lastLineRef: MutableRefObject<string | null>;
}

export function TabStatusLine({ notes, onNextToCheck, lastLineRef }: TabStatusLineProps) {
  const reasonId = useId();
  const n = notes.length;
  const k = notes.filter((note) => note.lowConfidence).length;
  const notesText = strings['tab.statusNotes'](n);
  const checkText = strings['tab.statusToCheck'](k);
  const line = strings['tab.statusLine'](notesText, checkText);

  // Announce updates only: the line as first shown is read with the screen.
  useEffect(() => {
    if (lastLineRef.current !== null && lastLineRef.current !== line) announce(line);
    lastLineRef.current = line;
  }, [line, lastLineRef]);

  const none = k === 0;
  return (
    <div className={styles.statusLine} data-testid="tab-status-line">
      <p className={styles.counts}>
        {notesText}
        {' · '}
        <span className={none ? undefined : styles.toCheck}>{checkText}</span>
      </p>
      <span title={none ? strings['tab.nextToCheckNone'] : undefined}>
        <button
          type="button"
          className={`${buttons.secondary} ${styles.next}`}
          disabled={none}
          aria-describedby={none ? reasonId : undefined}
          onClick={onNextToCheck}
        >
          {strings['tab.nextToCheck']}
        </button>
      </span>
      {none && (
        <span id={reasonId} className={hidden.visuallyHidden}>
          {strings['tab.nextToCheckNone']}
        </span>
      )}
    </div>
  );
}
