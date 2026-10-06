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
// focused note's button and focus fell to <body>, focus goes to that note's new button without
// selecting it.
//
// Story "Flags, warnings and bar lines on screen": a low-confidence note's button shows the
// check fill and dotted underline (DESIGN.md tab-note-check) and its label ends ", check this
// note". The lines sit above the buttons (and let clicks through), so the fill never hides them.
//
// Story "Playback with a following cursor": the note playback is on gets `data-playing` (DESIGN.md
// tab-note-playing, a solid ink outline), kept by note id across reflows; it never moves the
// selection or focus. While playback runs (`playing`), when that note's button is outside the
// viewport it is scrolled into view, at most once per 500 ms (smoothly, unless reduced motion is asked for). A click on a note also
// reports it through `onNoteClick` (the screen seeks to it while playing).
//
// Story "String moves, delete, insert and confirm": a double-click on a note reports it, with its
// button, through `onNoteDoubleClick` (the screen opens the edit popover there). While an
// overlay is open the selection never pulls focus.
//
// Story "Re-fit feedback": the notes in `refitIds` show the re-fit outline (DESIGN.md
// tab-note-refit, a dashed violet outline outside the selection outline) and `data-refit`;
// with `refitFading` it fades out. The screen owns the set and its timer.
//
// Story "500-note edit latency" (CAP-14, AD-17): the layout keeps the systems whose notes did not
// change (`layoutTab`'s `previous`: the last committed layout), and each system renders as a
// memoised `SystemView` that renders again only when its system, the metrics, or one of its
// notes' label, flag, selection, tab stop, playing or re-fit state changed
// (`SYSTEM_VIEW_COMPARE` lists how each prop is compared). Its event handlers are stable and
// read the latest props.

import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { midiName, playedOrder } from '../../model/notes';
import { layoutTab, type TabLayout, type TabSystem } from '../../model/tab-render';
import type { Note } from '../../model/types';
import { isOverlayOpen, subscribeOverlay } from '../a11y/overlays';
import { TEXT_FIELD } from '../a11y/selectors';
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
/** The playing note is scrolled into view at most this often (EXPERIENCE.md Playback). */
export const KEEP_IN_VIEW_MS = 500;

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

/** A note's re-fit outline: shown, or fading out. */
type RefitState = 'shown' | 'fading';

/**
 * A re-fit state's `data-refit` value. `'true'` and `'fading'` are a fixed contract: the unit
 * and e2e tests select on them, so renaming `RefitState` must not change them.
 */
const REFIT_ATTR: Record<RefitState, string> = { shown: 'true', fading: 'fading' };

/** A note button's classes: the check style when flagged, the re-fit outline (and its fade). */
function noteClass(flagged: boolean, refit: RefitState | null): string {
  return [
    styles.note,
    flagged && styles.check,
    refit && styles.refit,
    refit === 'fading' && styles.refitFading,
  ]
    .filter(Boolean)
    .join(' ');
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
  /** Every note's label in played order (`noteLabels(notes)`), computed once by the screen. */
  labels: readonly NoteLabel[];
  countInBpm?: number;
  selectedNoteId: string | null;
  onSelect(noteId: string): void;
  /** The area's element id (the skip link's target). */
  id?: string;
  /**
   * The note whose button last had focus (the session's `lastFocusedNoteId`): the tab stop while
   * nothing is selected.
   */
  lastFocusedNoteId?: string | null;
  /** Called with a note's id whenever its button takes focus (the session records it). */
  onFocusNote?(noteId: string): void;
  /** The note playback is on (the playing outline), or null. */
  playingNoteId?: string | null;
  /** Whether playback is running: only then is the playing note kept in view. */
  playing?: boolean;
  /** Called with a note's id when it is clicked, after it is selected. */
  onNoteClick?(noteId: string): void;
  /** Called with a note's id and its button when it is double-clicked (the edit popover). */
  onNoteDoubleClick?(noteId: string, button: HTMLButtonElement): void;
  /** The notes the last edit's re-fit re-fingered: they show the re-fit outline. */
  refitIds?: ReadonlySet<string>;
  /** Whether the re-fit outline is fading out. */
  refitFading?: boolean;
}

const NO_IDS: ReadonlySet<string> = new Set();

/** Whether `el` lies (partly) outside the window's viewport. */
function outOfView(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.top < 0 || r.left < 0 || r.bottom > window.innerHeight || r.right > window.innerWidth;
}

/** Whether the user asks for reduced motion. */
export function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

export function TabArea({
  notes,
  labels,
  countInBpm,
  selectedNoteId,
  onSelect,
  id,
  lastFocusedNoteId = null,
  onFocusNote,
  playingNoteId = null,
  playing = false,
  onNoteClick,
  onNoteDoubleClick,
  refitIds = NO_IDS,
  refitFading = false,
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

  // The last committed layout, kept after each commit (not during render) and passed to
  // `layoutTab` as `previous`, so the systems whose notes did not change keep their identity.
  // Reading it during render is safe: `previous` changes only which system objects the layout
  // reuses, never what it lays out, and a discarded render never becomes `previous`.
  const committedLayout = useRef<TabLayout | null>(null);
  const layout = useMemo(
    () =>
      metrics
        ? // eslint-disable-next-line react-hooks/refs
          layoutTab(notes, metrics.widthChars, countInBpm, committedLayout.current)
        : null,
    [notes, metrics, countInBpm],
  );
  useLayoutEffect(() => {
    if (layout) committedLayout.current = layout;
  }, [layout]);
  const labelById = useMemo(() => new Map(labels.map((l) => [l.id, l.label])), [labels]);
  const flagged = useMemo(
    () => new Set(notes.filter((n) => n.lowConfidence).map((n) => n.id)),
    [notes],
  );
  const firstId = labels[0]?.id ?? null;
  const tabStop =
    selectedNoteId ??
    (lastFocusedNoteId !== null && labelById.has(lastFocusedNoteId) ? lastFocusedNoteId : firstId);

  const buttons = useRef(new Map<string, HTMLButtonElement>());
  /** The note button that had focus, until focus really leaves it (not a reflow re-creating it). */
  const focused = useRef<{ el: HTMLButtonElement; id: string } | null>(null);
  /** Set while focus is handed back after a reflow, which must not select the note. */
  const restoring = useRef(false);
  const lastSelected = useRef(selectedNoteId);
  const overlayOpen = useSyncExternalStore(subscribeOverlay, isOverlayOpen, isOverlayOpen);

  // The note buttons' handlers are stable (so a memoised system need not render again for them)
  // and call the latest callbacks, kept here after each commit.
  const callbacks = useRef({ onSelect, onFocusNote, onNoteClick, onNoteDoubleClick });
  useLayoutEffect(() => {
    callbacks.current = { onSelect, onFocusNote, onNoteClick, onNoteDoubleClick };
  });
  const [handlers] = useState<NoteHandlers>(() => ({
    ref(noteId, el) {
      if (el) buttons.current.set(noteId, el);
      else if (buttons.current.get(noteId)?.isConnected === false) {
        buttons.current.delete(noteId);
      }
    },
    focus(noteId, el) {
      focused.current = { el, id: noteId };
      callbacks.current.onFocusNote?.(noteId);
      if (!restoring.current) callbacks.current.onSelect(noteId);
    },
    blur(el) {
      // Focus really left when the button is still in the page; a button a reflow removed
      // keeps its claim so the new one takes focus.
      requestAnimationFrame(() => {
        if (focused.current?.el === el && el.isConnected && document.activeElement !== el) {
          focused.current = null;
        }
      });
    },
    click(noteId) {
      callbacks.current.onSelect(noteId);
      callbacks.current.onNoteClick?.(noteId);
    },
    doubleClick(noteId, el) {
      callbacks.current.onNoteDoubleClick?.(noteId, el);
    },
  }));

  useLayoutEffect(() => {
    // An open overlay (the edit popover) holds focus; a selection moved meanwhile is focused
    // once it closes (this effect runs again then).
    if (overlayOpen) return;
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
    // selecting it (Esc may have cleared the selection) — but only when focus was really lost
    // (it is on <body>), never taken back from where the player moved it since. A claim for a
    // note with no button any more (deleted) is dropped.
    const had = focused.current;
    if (had && !had.el.isConnected) {
      const target = buttons.current.get(had.id);
      if (!target) {
        focused.current = null;
        return;
      }
      if (active !== null && active !== document.body) {
        if (active !== target) focused.current = null;
        return;
      }
      restoring.current = true;
      try {
        target.focus();
      } finally {
        restoring.current = false;
      }
    }
  }, [selectedNoteId, layout, overlayOpen]);

  // Keep the playing note in view: scroll at most once per KEEP_IN_VIEW_MS; a note that leaves
  // the view sooner is checked again when that time is up.
  const lastScroll = useRef(-Infinity);
  useEffect(() => {
    if (playingNoteId === null || !playing) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const el = buttons.current.get(playingNoteId);
      if (!el || !el.isConnected || !outOfView(el)) return;
      const wait = lastScroll.current + KEEP_IN_VIEW_MS - performance.now();
      if (wait > 0) {
        timer = setTimeout(check, wait);
        return;
      }
      lastScroll.current = performance.now();
      el.scrollIntoView({
        block: 'center',
        inline: 'nearest',
        behavior: reducedMotion() ? 'instant' : 'smooth',
      });
    };
    check();
    return () => clearTimeout(timer);
  }, [playingNoteId, playing, layout]);

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
          <SystemView
            // By its first note, so a change in the system count does not remount every later
            // system (and its note buttons).
            key={system.cells[0]?.noteId ?? `empty-${i}`}
            system={system}
            index={i}
            count={systems.length}
            metrics={metrics}
            labelById={labelById}
            flagged={flagged}
            selectedNoteId={selectedNoteId}
            tabStop={tabStop}
            playingNoteId={playingNoteId}
            refitIds={refitIds}
            refitFading={refitFading}
            handlers={handlers}
          />
        ))}
    </div>
  );
}

/** The note buttons' stable handlers (see TabArea). */
interface NoteHandlers {
  ref(noteId: string, el: HTMLButtonElement | null): void;
  focus(noteId: string, el: HTMLButtonElement): void;
  blur(el: HTMLButtonElement): void;
  click(noteId: string): void;
  doubleClick(noteId: string, el: HTMLButtonElement): void;
}

export interface SystemViewProps {
  system: TabSystem;
  index: number;
  count: number;
  metrics: Metrics;
  labelById: ReadonlyMap<string, string>;
  flagged: ReadonlySet<string>;
  selectedNoteId: string | null;
  tabStop: string | null;
  playingNoteId: string | null;
  refitIds: ReadonlySet<string>;
  refitFading: boolean;
  handlers: NoteHandlers;
}

/** A note's re-fit outline state, or null when it has none. */
function refitState(
  noteId: string,
  refitIds: ReadonlySet<string>,
  refitFading: boolean,
): RefitState | null {
  return refitIds.has(noteId) ? (refitFading ? 'fading' : 'shown') : null;
}

/**
 * How `sameSystemView` compares each prop: `'whole'` by identity, or a function giving what a
 * note's button shows from it (compared per note of the system, so a set-wide prop may change
 * for notes elsewhere). Every prop must be listed: a new one fails the type check until it is.
 */
export const SYSTEM_VIEW_COMPARE: {
  readonly [K in keyof SystemViewProps]-?: 'whole' | ((p: SystemViewProps, id: string) => unknown);
} = {
  system: 'whole',
  index: 'whole',
  count: 'whole',
  metrics: 'whole',
  handlers: 'whole',
  labelById: (p, id) => p.labelById.get(id),
  flagged: (p, id) => p.flagged.has(id),
  selectedNoteId: (p, id) => id === p.selectedNoteId,
  tabStop: (p, id) => id === p.tabStop,
  playingNoteId: (p, id) => id === p.playingNoteId,
  refitIds: (p, id) => refitState(id, p.refitIds, p.refitFading),
  refitFading: (p, id) => refitState(id, p.refitIds, p.refitFading),
};

const COMPARED = Object.entries(SYSTEM_VIEW_COMPARE) as [
  keyof SystemViewProps,
  (typeof SYSTEM_VIEW_COMPARE)[keyof SystemViewProps],
][];
const WHOLE_PROPS = COMPARED.filter(([, how]) => how === 'whole').map(([key]) => key);
const PER_NOTE = COMPARED.flatMap(([, how]) => (how === 'whole' ? [] : [how]));

/**
 * Whether a system renders the same for `a` and `b`: every prop as `SYSTEM_VIEW_COMPARE` says
 * (the same system, place, metrics and handlers, and the same label, flag, selection, tab stop,
 * playing and re-fit state for each of its notes).
 */
export function sameSystemView(a: SystemViewProps, b: SystemViewProps): boolean {
  if (WHOLE_PROPS.some((key) => a[key] !== b[key])) return false;
  return a.system.cells.every(({ noteId: id }) => PER_NOTE.every((f) => f(a, id) === f(b, id)));
}

/** One system: its six lines and a note button over each note's characters. */
const SystemView = memo(function SystemView({
  system,
  index,
  count,
  metrics,
  labelById,
  flagged,
  selectedNoteId,
  tabStop,
  playingNoteId,
  refitIds,
  refitFading,
  handlers,
}: SystemViewProps) {
  return (
    <div
      role="group"
      className={styles.system}
      aria-label={strings['tab.system'](index + 1, count)}
    >
      <div className={styles.inner}>
        <pre className={styles.lines} aria-hidden="true">
          {system.lines.join('\n')}
        </pre>
        {system.cells.map((cell) => {
          const refit = refitState(cell.noteId, refitIds, refitFading);
          return (
            <button
              key={cell.noteId}
              ref={(el) => handlers.ref(cell.noteId, el)}
              type="button"
              className={noteClass(flagged.has(cell.noteId), refit)}
              data-note-id={cell.noteId}
              data-playing={cell.noteId === playingNoteId ? 'true' : undefined}
              data-refit={refit ? REFIT_ATTR[refit] : undefined}
              aria-label={labelById.get(cell.noteId)}
              aria-pressed={cell.noteId === selectedNoteId}
              tabIndex={cell.noteId === tabStop ? 0 : -1}
              style={{
                left: cell.col * metrics.charWidth,
                top: (cell.string - 1) * metrics.lineHeight,
                width: cell.width * metrics.charWidth,
                height: metrics.lineHeight,
              }}
              onFocus={(e) => handlers.focus(cell.noteId, e.currentTarget)}
              onBlur={(e) => handlers.blur(e.currentTarget)}
              onClick={() => handlers.click(cell.noteId)}
              onDoubleClick={(e) => handlers.doubleClick(cell.noteId, e.currentTarget)}
            />
          );
        })}
      </div>
    </div>
  );
}, sameSystemView);
