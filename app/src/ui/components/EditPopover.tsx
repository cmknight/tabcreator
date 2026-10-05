// The edit popover (story "String moves, delete, insert and confirm"; EXPERIENCE.md Fret popover,
// Note (in tab)): opened by a double-click on a note, anchored below it (above when there is no
// room), kept inside the viewport. A `role="dialog"` named "Edit note" holding the fret field
// (focused on open; Enter applies a fret in 0..the take's highest fret), one button per other
// string that plays the note's pitch, and Confirm. Each action applies its command and closes.
// Focus, the Tab trap and dismissal (Esc, a pointer-down outside) belong to `ui/a11y/overlays.ts`;
// focus returns to the note on close (its current button, should a reflow have re-created it).
// Placed once, it closes on a window scroll or resize rather than drift away from its note.

import { useId, useLayoutEffect, useRef, useState } from 'react';
import { playablePositions } from '../../model/edit-history';
import type { Note, StringNo } from '../../model/types';
import { openOverlay } from '../a11y/overlays';
import { NOTE_BUTTON } from '../a11y/selectors';
import { strings } from '../strings';
import buttons from './buttons.module.css';
import styles from './EditPopover.module.css';

/** The space kept between the popover and its note, and the viewport's edges (px). */
const GAP = 4;
const MARGIN = 8;

export interface EditPopoverProps {
  note: Note;
  /** The take's highest fret. */
  maxFret: number;
  /** The note button it opened from: it anchors there and focus returns there. */
  anchor: HTMLElement;
  onSetFret(fret: number): void;
  onMove(string: StringNo): void;
  onConfirm(): void;
  /** Closes the popover (Esc, a pointer-down outside, or after an action). */
  onClose(): void;
  /**
   * The note whose button takes focus back on close (default: this note); asked at close, so a
   * selection that moved while it was open gets focus.
   */
  returnFocusTo?(): string;
}

export function EditPopover({
  note,
  maxFret,
  anchor,
  onSetFret,
  onMove,
  onConfirm,
  onClose,
  returnFocusTo,
}: EditPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const close = useRef(onClose);
  const returnTo = useRef(returnFocusTo);
  useLayoutEffect(() => {
    close.current = onClose;
    returnTo.current = returnFocusTo;
  });
  const [fret, setFret] = useState(String(note.fret));
  const [invalid, setInvalid] = useState(false);
  const fieldId = useId();
  const hintId = useId();
  const positions = playablePositions(note.midi, maxFret).filter((p) => p.string !== note.string);

  // Place it at the note, then register it as the open overlay (focus moves into the field).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const a = anchor.getBoundingClientRect();
    const p = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    let top = a.bottom + GAP;
    if (top + p.height > vh - MARGIN && a.top - GAP - p.height >= MARGIN) {
      top = a.top - GAP - p.height;
    }
    top = Math.min(Math.max(MARGIN, top), Math.max(MARGIN, vh - p.height - MARGIN));
    const left = Math.min(Math.max(MARGIN, a.left), Math.max(MARGIN, vw - p.width - MARGIN));
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
    const noteId = note.id;
    const release = openOverlay({
      element: el,
      // The note's button now: a reflow may have replaced the one it opened from.
      opener: () => {
        const id = returnTo.current?.() ?? noteId;
        if (id === noteId && anchor.isConnected) return anchor;
        return (
          [...document.querySelectorAll<HTMLElement>(NOTE_BUTTON)].find(
            (b) => b.getAttribute('data-note-id') === id,
          ) ?? null
        );
      },
      initialFocus: fieldRef.current,
      onDismiss: () => close.current(),
    });
    fieldRef.current?.select();
    // Placed once: a scroll or resize would leave it away from its note, so it closes.
    const dismiss = () => close.current();
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      release();
    };
    // The note's id is fixed for a popover (the screen keys it by note).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor]);

  return (
    <div
      ref={ref}
      className={styles.popover}
      role="dialog"
      aria-modal="true"
      aria-label={strings['tab.popover']}
      tabIndex={-1}
      data-testid="edit-popover"
    >
      <form
        className={styles.fretRow}
        onSubmit={(event) => {
          event.preventDefault();
          const value = fret.trim();
          const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
          if (!Number.isInteger(n) || n < 0 || n > maxFret) {
            setInvalid(true);
            return;
          }
          onSetFret(n);
          onClose();
        }}
      >
        <label htmlFor={fieldId}>{strings['tab.popoverFret']}</label>
        <input
          ref={fieldRef}
          id={fieldId}
          className={styles.field}
          type="number"
          inputMode="numeric"
          min={0}
          max={maxFret}
          step={1}
          value={fret}
          aria-invalid={invalid || undefined}
          aria-describedby={hintId}
          onChange={(event) => {
            setFret(event.target.value);
            setInvalid(false);
          }}
        />
        <span id={hintId} className={invalid ? `${styles.hint} ${styles.invalid}` : styles.hint}>
          {strings['tab.popoverFretRange'](maxFret)}
        </span>
      </form>
      {positions.length > 0 && (
        <div className={styles.positions} role="group" aria-label={strings['tab.popoverPositions']}>
          {positions.map((p) => (
            <button
              key={p.string}
              type="button"
              className={buttons.secondary}
              onClick={() => {
                onMove(p.string);
                onClose();
              }}
            >
              {strings['tab.popoverPosition'](p.string, p.fret)}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className={`${buttons.secondary} ${styles.confirm}`}
        onClick={() => {
          onConfirm();
          onClose();
        }}
      >
        {strings['tab.popoverConfirm']}
      </button>
    </div>
  );
}
