// The Tab screen's header (story "Tab screen, reflow and selection"; EXPERIENCE.md Tab row,
// DESIGN.md Inline-editable title): the take's title in the <h1> with a pencil button, "Rename
// take", that switches it to a text field, then the recording date and the duration.
//
// Renaming: Enter or blur saves (and so does leaving the screen mid-edit), Escape cancels; an
// Enter that ends an IME composition does not save. The field holds at most 100 code points. The session trims the value; empty or
// unchanged writes nothing. Focus stays in the field while editing and returns to the pencil
// button after Enter or Escape (a blur leaves focus where the player put it).

import { useEffect, useLayoutEffect, useRef, useState, type Ref } from 'react';
import type { Take } from '../../model/types';
import { capTitle } from '../../session/take-session';
import { formatElapsed, formatTakeDate } from '../format';
import screenStyles from '../screens/Screen.module.css';
import { strings } from '../strings';
import { PencilIcon } from './icons';
import styles from './TakeHeader.module.css';

export interface TakeHeaderProps {
  /** The heading text when there is no take (loading, missing). */
  fallbackTitle: string;
  /** The take, once read; null hides the pencil and the date line. */
  take: Take | null;
  onRename(title: string): void;
  /** The <h1>, which the screen focuses when the focused control goes away. */
  titleRef?: Ref<HTMLHeadingElement>;
}

export function TakeHeader({ fallbackTitle, take, onRename, titleRef }: TakeHeaderProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const pencil = useRef<HTMLButtonElement>(null);
  /** Set once an edit is finished, so a blur from unmounting the field does not save again. */
  const finished = useRef(false);
  /** Whether focus goes back to the pencil once the field is gone (Enter, Escape). */
  const refocus = useRef(false);

  // Leaving mid-edit (a route change unmounts the field with no blur) saves the draft too.
  const latest = useRef({ editing, draft, onRename });
  useLayoutEffect(() => {
    latest.current = { editing, draft, onRename };
  });
  useEffect(
    () => () => {
      const { editing: open, draft: text, onRename: save } = latest.current;
      if (open && !finished.current) {
        finished.current = true;
        save(text);
      }
    },
    [],
  );

  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    pencil.current?.focus();
  }, [editing]);

  function start() {
    if (!take) return;
    finished.current = false;
    setDraft(take.title);
    setEditing(true);
  }

  function finish(save: boolean, returnFocus: boolean) {
    if (finished.current) return;
    finished.current = true;
    if (save) onRename(draft);
    refocus.current = returnFocus;
    setEditing(false);
  }

  return (
    <div className={styles.header}>
      <div className={styles.titleRow}>
        <h1 ref={titleRef} className={`${screenStyles.title} ${styles.title}`} tabIndex={-1}>
          {editing && take ? (
            <input
              className={styles.input}
              type="text"
              aria-label={strings['tab.titleField']}
              value={draft}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setDraft(capTitle(e.currentTarget.value))}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter') {
                  e.preventDefault();
                  finish(true, true);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  finish(false, true);
                }
              }}
              onBlur={() => finish(true, false)}
            />
          ) : (
            (take?.title ?? fallbackTitle)
          )}
        </h1>
        {take && !editing && (
          <button
            ref={pencil}
            type="button"
            className={styles.pencil}
            aria-label={strings['tab.rename']}
            title={strings['tab.rename']}
            onClick={start}
          >
            <PencilIcon className={styles.pencilIcon} />
          </button>
        )}
      </div>
      {take && (
        <p className={styles.meta} data-testid="tab-meta">
          {strings['tab.meta'](formatTakeDate(take.createdAt), formatElapsed(take.durationMs))}
        </p>
      )}
    </div>
  );
}
