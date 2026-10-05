// The tab area (story "Tab screen, reflow and selection"; US-6.2, US-6.3; EXPERIENCE.md Tab view,
// Note (in tab), Accessibility floor). A `role="application"` region described by its
// instructions, holding one group per system: the six lines as an `aria-hidden` <pre>, with a
// note <button> laid exactly over each note's characters (from `TabLayout.cells`).
//
// Reflow: the character width is measured once per mount from a hidden probe in the tab font,
// the line height from its computed style; `widthChars = max(20, floor(contentWidth /
// charWidth))`. A ResizeObserver re-lays the tab out (debounced 100 ms), so no line is wider
// than the area and the page never scrolls sideways.
//
// Selection and focus: one note button is in the tab order (roving tabIndex): the selected
// note's, else the last focused note's (after Esc cleared the selection), else the first.
// Focusing or clicking a note selects it; a selection moved elsewhere (the arrow shortcuts)
// moves focus onto the new note, unless focus is in a text field. When a reflow re-creates the
// focused note's button, focus goes to that note's new button without selecting it.
//
// Story "Flags, warnings and bar lines on screen": a low-confidence note's button shows the
// check fill and dotted underline (DESIGN.md tab-note-check) and its label ends ", check this
// note". The lines sit above the buttons (and let clicks through), so the fill never hides them.

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { midiName, playedOrder } from '../../model/notes';
import { layoutTab } from '../../model/tab-render';
import type { Note } from '../../model/types';
import hidden from '../a11y/visually-hidden.module.css';
import { strings } from '../strings';
import styles from './TabArea.module.css';

/** The narrowest tab, in characters. */
export const MIN_WIDTH_CHARS = 20;
/** Characters in the measuring probe; more gives a finer average width. */
const PROBE_CHARS = 100;
/** Fallbacks when nothing can be measured (no layout, as in jsdom): 16 px monospace at 1.35. */
const FALLBACK_CHAR_WIDTH = 9.6;
const FALLBACK_LINE_HEIGHT = 21.6;
/** The reflow debounce (EXPERIENCE.md Tab view). */
export const REFLOW_DEBOUNCE_MS = 100;

const TEXT_FIELD = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

export interface NoteLabel {
  id: string;
  label: string;
}

/**
 * Every note's accessible label in played order (US-6.2): "Note 12: B string, fret 3, D4, at
 * 4.25 seconds", plus ", check this note" when it is flagged (low-confidence).
 */
export function noteLabels(notes: readonly Note[]): NoteLabel[] {
  return playedOrder(notes).map((note, i) => {
    const label = strings['tab.noteLabel'](
      i + 1,
      note.string,
      note.fret,
      midiName(note.midi),
      (note.startMs / 1000).toFixed(2),
    );
    return {
      id: note.id,
      label: note.lowConfidence ? strings['tab.noteLabelCheck'](label) : label,
    };
  });
}

interface Metrics {
  charWidth: number;
  lineHeight: number;
  widthChars: number;
}

/** The characters per line that fit `measure`'s content box. */
function fitChars(measure: HTMLElement, charWidth: number): number {
  const style = getComputedStyle(measure);
  const px = (v: string) => parseFloat(v) || 0;
  const content =
    measure.getBoundingClientRect().width -
    px(style.paddingLeft) -
    px(style.paddingRight) -
    px(style.borderLeftWidth) -
    px(style.borderRightWidth);
  return Math.max(MIN_WIDTH_CHARS, Math.floor(content / charWidth + 1e-6));
}

export interface TabAreaProps {
  notes: readonly Note[];
  countInBpm?: number;
  selectedNoteId: string | null;
  onSelect(noteId: string): void;
  /** The area's element id (the skip link's target). */
  id?: string;
  /** Called with a note's id whenever its button takes focus (Next to check starts after it). */
  onFocusNote?(noteId: string): void;
}

export function TabArea({
  notes,
  countInBpm,
  selectedNoteId,
  onSelect,
  id,
  onFocusNote,
}: TabAreaProps) {
  const areaRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);

  // Measure once per mount; re-fit the width on every (debounced) resize.
  useLayoutEffect(() => {
    const area = areaRef.current;
    const measure = measureRef.current;
    const probe = probeRef.current;
    if (!area || !measure || !probe) return;
    const measured = probe.getBoundingClientRect().width / PROBE_CHARS;
    const charWidth = measured > 0 ? measured : FALLBACK_CHAR_WIDTH;
    const lh = parseFloat(getComputedStyle(probe).lineHeight);
    const lineHeight = Number.isFinite(lh) && lh > 0 ? lh : FALLBACK_LINE_HEIGHT;
    setMetrics({ charWidth, lineHeight, widthChars: fitChars(measure, charWidth) });
    if (typeof ResizeObserver === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const widthChars = fitChars(measure, charWidth);
        setMetrics((m) => (m && m.widthChars !== widthChars ? { ...m, widthChars } : m));
      }, REFLOW_DEBOUNCE_MS);
    });
    observer.observe(area);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, []);

  const layout = useMemo(
    () => (metrics ? layoutTab(notes, metrics.widthChars, countInBpm) : null),
    [notes, metrics, countInBpm],
  );
  const labels = useMemo(() => new Map(noteLabels(notes).map((l) => [l.id, l.label])), [notes]);
  const flagged = useMemo(
    () => new Set(notes.filter((n) => n.lowConfidence).map((n) => n.id)),
    [notes],
  );
  const firstId = useMemo(() => playedOrder(notes)[0]?.id ?? null, [notes]);
  /** The note last focused: the tab stop (and the arrows' start) while nothing is selected. */
  const [current, setCurrent] = useState<string | null>(null);
  const tabStop = selectedNoteId ?? (current !== null && labels.has(current) ? current : firstId);

  const buttons = useRef(new Map<string, HTMLButtonElement>());
  /** The note button that had focus, until focus really leaves it (not a reflow re-creating it). */
  const focused = useRef<{ el: HTMLButtonElement; id: string } | null>(null);
  /** Set while focus is handed back after a reflow, which must not select the note. */
  const restoring = useRef(false);
  const lastSelected = useRef(selectedNoteId);

  useLayoutEffect(() => {
    const moved = lastSelected.current !== selectedNoteId;
    lastSelected.current = selectedNoteId;
    const active = document.activeElement;
    if (moved && selectedNoteId !== null) {
      const target = buttons.current.get(selectedNoteId);
      if (!target || active === target) return;
      if (active instanceof Element && active.closest(TEXT_FIELD)) return;
      target.focus();
      return;
    }
    // A reflow re-created the focused note button: focus goes to that note's new one, without
    // selecting it (Esc may have cleared the selection).
    const had = focused.current;
    if (had && !had.el.isConnected) {
      const target = buttons.current.get(had.id);
      if (!target || active === target) return;
      restoring.current = true;
      try {
        target.focus();
      } finally {
        restoring.current = false;
      }
    }
  }, [selectedNoteId, layout]);

  const instructionsId = `${id ?? 'tab-area'}-instructions`;
  const systems = layout?.systems ?? [];

  return (
    <div
      ref={areaRef}
      id={id}
      className={styles.area}
      role="application"
      aria-label={strings['tab.area']}
      aria-describedby={instructionsId}
      data-testid="tab-systems"
      data-width-chars={metrics?.widthChars}
    >
      <p id={instructionsId} className={hidden.visuallyHidden}>
        {strings['tab.areaInstructions']}
      </p>
      {/* The measuring box: a system's width and padding, no height. */}
      <div ref={measureRef} className={`${styles.system} ${styles.measure}`} aria-hidden="true">
        <span ref={probeRef} className={styles.probe}>
          {'-'.repeat(PROBE_CHARS)}
        </span>
      </div>
      {metrics &&
        systems.map((system, i) => (
          <div
            key={i}
            role="group"
            className={styles.system}
            aria-label={strings['tab.system'](i + 1, systems.length)}
          >
            <div className={styles.inner}>
              <pre className={styles.lines} aria-hidden="true">
                {system.lines.join('\n')}
              </pre>
              {system.cells.map((cell) => (
                <button
                  key={cell.noteId}
                  ref={(el) => {
                    if (el) buttons.current.set(cell.noteId, el);
                    else if (buttons.current.get(cell.noteId)?.isConnected === false) {
                      buttons.current.delete(cell.noteId);
                    }
                  }}
                  type="button"
                  className={
                    flagged.has(cell.noteId) ? `${styles.note} ${styles.check}` : styles.note
                  }
                  data-note-id={cell.noteId}
                  aria-label={labels.get(cell.noteId)}
                  aria-pressed={cell.noteId === selectedNoteId}
                  tabIndex={cell.noteId === tabStop ? 0 : -1}
                  style={{
                    left: cell.col * metrics.charWidth,
                    top: (cell.string - 1) * metrics.lineHeight,
                    width: cell.width * metrics.charWidth,
                    height: metrics.lineHeight,
                  }}
                  onFocus={(e) => {
                    focused.current = { el: e.currentTarget, id: cell.noteId };
                    setCurrent(cell.noteId);
                    onFocusNote?.(cell.noteId);
                    if (!restoring.current) onSelect(cell.noteId);
                  }}
                  onBlur={(e) => {
                    const el = e.currentTarget;
                    // Focus really left when the button is still in the page; a button a reflow
                    // removed keeps its claim so the new one takes focus.
                    requestAnimationFrame(() => {
                      if (
                        focused.current?.el === el &&
                        el.isConnected &&
                        document.activeElement !== el
                      ) {
                        focused.current = null;
                      }
                    });
                  }}
                  onClick={() => onSelect(cell.noteId)}
                />
              ))}
            </div>
          </div>
        ))}
    </div>
  );
}
