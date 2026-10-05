// The app's only keyboard-shortcut registry (spine AD-18). `ShortcutListener` is mounted once,
// in the shell, and installs the one `keydown` listener every shortcut goes through; nothing
// else in the app listens to `keydown` for shortcuts. Each entry names its key, the route it
// works on (or `global`: every route), a description (for the later `?` dialog), a handler and
// optionally when it applies; a key it does not apply to is left to the page.
//
// The guard (EXPERIENCE.md Interaction Primitives): a shortcut never fires while focus is in a
// text field (input, textarea, select, contenteditable), nor on an element where the key has a
// native action (Space on a button or checkbox, Enter on those or a link), so its own action
// runs exactly once. A handled key's default (Space scrolling the page) is prevented, and
// auto-repeat is ignored (holding a key fires once) unless the entry opts in with `repeat`: only
// the Tab screen's ← / →, so holding one walks the notes.
//
// The Tab screen's keys (story "Tab screen, reflow and selection", US-6.3): ← / → move the note
// selection (from inside the tab area) and Esc clears it (from anywhere on the screen, as
// EXPERIENCE.md lists it Global). Their handlers reach the open screen's session through
// `activeTakeSession()` (session/take-session.ts), which the Tab screen sets while mounted. They
// do nothing while focus is inside a `role="toolbar"`, which owns its arrow keys (ARIA toolbar
// pattern). The count-in Esc comes first in the list, so it keeps priority.
//
// Story "Flags, warnings and bar lines on screen": `N` (Next to check) selects and focuses the
// next low-confidence note. It follows the arrows' shown-tab rule but works with focus anywhere
// on the Tab screen, except in a text field (the guard) or the toolbar.
//
// Story "Playback with a following cursor": Space plays / pauses and `P` seeks to 100 ms before
// the selected note (and plays). Both reach the screen's playback through `activePlayback()`
// (session/playback.ts), apply only while the tab is shown and its audio is loaded, and do
// nothing in a text field or the toolbar. Space on a focused note button is the guard's one
// exception (see `guarded`).

import { useEffect } from 'react';
import { recordingSession, type RecordingSession } from '../../session/recording-session';
import type { RecordingSnapshot } from '../../session/recording-types';
import { activePlayback, type PlaybackController } from '../../session/playback';
import { activeTakeSession, isTabShown, type TakeSession } from '../../session/take-session';
import { parseRoute, type Route } from '../router';
import { NOTE_BUTTON, TAB_AREA, TEXT_FIELD, TOOLBAR } from './selectors';
import { strings } from '../strings';

export interface Shortcut {
  /** `KeyboardEvent.key`, e.g. `' '` for Space. */
  key: string;
  /** The route the shortcut works on; `global` works on every route. */
  route: Route['name'] | 'global';
  /** What it does, as the `?` dialog lists it. */
  description: string;
  handler: () => void;
  /**
   * Whether it applies now, given the keydown's target; when false the key is not handled
   * (default: always).
   */
  when?: (target: EventTarget | null) => boolean;
  /** Whether auto-repeat fires it again (default: a held key fires once). */
  repeat?: boolean;
}

/** The latency mark set at a handled Space keydown on Record (story 3.5, Done when 1). */
export const RECORD_KEYDOWN_MARK = 'record-keydown';

/** Elements Space activates natively (links do not: Space on a link only scrolls). */
const SPACE_ACTION = 'button, summary, [role="button"], [role="checkbox"], [role="switch"]';
/** Elements Enter activates natively. */
const ENTER_ACTION = `${SPACE_ACTION}, a[href], [role="link"]`;

/**
 * On the Tab screen this also settles Space and Enter on a focused toolbar button (or the skip
 * link, the Note list view toggle, Play, the speed buttons, the banners' buttons): they keep
 * their native action (press the button, follow the link), and no `tab`-route Space or Enter
 * shortcut fires there.
 *
 * The one exception (story "Playback with a following cursor"): Space on a note button inside
 * the tab area (`[role="application"]`) is not guarded, so the Tab screen's Space (Play / Pause,
 * EXPERIENCE.md Keyboard) runs there. A note is a selection target, already selected when
 * focused, so pressing it would do nothing visible. Enter on a note stays native.
 *
 * Whether `key` pressed with focus on `target` must be left to the page: focus is in a text
 * field, or on an element where the key has a native action (Space: a button or checkbox;
 * Enter: those and links).
 */
export function guarded(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(TEXT_FIELD)) return true;
  if (key === ' ') {
    if (target.closest(NOTE_BUTTON)) return false;
    return target.closest(SPACE_ACTION) !== null;
  }
  if (key === 'Enter') return target.closest(ENTER_ACTION) !== null;
  return false;
}

/** The recorder's capture-start mark (audio/recorder.ts CAPTURE_START_MARK; ui/ may not import audio/). */
const CAPTURE_START_MARK = 'record-capture-start';

/**
 * Sets the `record-keydown` mark. `restart` (a keydown that starts a take) first clears both
 * latency marks, so the pair always belongs to the latest start. Never throws: the marks are
 * only a measurement and must not stop the shortcut.
 */
function markKeydown(restart: boolean): void {
  try {
    if (restart) {
      performance.clearMarks(RECORD_KEYDOWN_MARK);
      performance.clearMarks(CAPTURE_START_MARK);
    }
    performance.mark(RECORD_KEYDOWN_MARK);
  } catch {
    // No User Timing: nothing to measure.
  }
}

/** The parts of the recording store the Space toggle uses. */
type RecordToggleStore = Pick<RecordingSession, 'getSnapshot' | 'record' | 'stop'>;

/**
 * Space on Record: while the mic is live, idle → `record()`, recording → `stop('user')`,
 * starting → `stop('user')` (the store holds it until the take records, so a quick Space-Space
 * still stops the take), count-in → `stop('user')` (cancels it); ignored while the take stops,
 * or with no live mic. The latency marks are set (and cleared) only with the count-in off: with
 * it on, the capture opens at beat five, so the pair would measure the count-in, not the
 * latency.
 */
export function recordToggle(
  store: RecordToggleStore,
  mark: (restart: boolean) => void = markKeydown,
): () => void {
  return () => {
    const { mic, recording, countIn }: RecordingSnapshot = store.getSnapshot();
    if (mic !== 'live') return;
    if (recording === 'idle') {
      if (!countIn.on) mark(true);
      void store.record();
    } else if (recording === 'recording') {
      if (!countIn.on) mark(false);
      void store.stop('user');
    } else if (recording === 'count-in' || recording === 'starting') {
      void store.stop('user');
    }
  };
}

/** Esc: cancels a count-in; applies only while one runs (otherwise Esc is left to the page). */
export function cancelCountIn(store: Pick<RecordingSession, 'getSnapshot' | 'stop'>): Shortcut {
  return {
    key: 'Escape',
    route: 'global',
    description: strings['global.shortcutCancelCountIn'],
    when: () => store.getSnapshot().recording === 'count-in',
    handler: () => void store.stop('user'),
  };
}

/** Whether `target` is inside the tab area (`role="application"`). */
function inTabArea(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(TAB_AREA) !== null;
}

/** Whether `target` is inside a toolbar, which owns its arrow keys (and Esc). */
function inToolbar(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(TOOLBAR) !== null;
}

/**
 * Moves focus onto the selected note's button (Next to check), unless it already has it. A
 * selection that moved is focused by the tab area too; this also covers one that did not (a
 * lone flagged note already selected, with focus elsewhere).
 */
export function focusSelectedNote(selectedNoteId: string | null): void {
  if (selectedNoteId === null) return;
  const button = [...document.querySelectorAll<HTMLElement>(NOTE_BUTTON)].find(
    (el) => el.getAttribute('data-note-id') === selectedNoteId,
  );
  if (button && document.activeElement !== button) button.focus();
}

type SelectionSession = Pick<
  TakeSession,
  'getSnapshot' | 'select' | 'selectNext' | 'selectPrev' | 'selectNextFlagged'
>;

/**
 * ← / → (previous / next note) and Esc (clear the selection) on the Tab screen, acting on the
 * session `session()` returns (the mounted screen's), and only while its tab is shown (analysed,
 * with notes). "Tab enters the tab area; arrows move within it" (EXPERIENCE.md Tab view): the
 * arrows apply only with focus inside the tab area (held down, they repeat), and step from the
 * last focused note (the session's `lastFocusedNoteId`) when none is selected. Esc applies while
 * a note is selected, from anywhere on the screen (EXPERIENCE.md: Global) but a text field (the
 * guard) or a toolbar. `N` selects and focuses the next note to check (wrapping), from
 * anywhere on the screen but the toolbar, while at least one note is flagged.
 */
export function tabSelectionShortcuts(
  session: () => SelectionSession | null = activeTakeSession,
): Shortcut[] {
  const tabShown = () => isTabShown(session()?.getSnapshot());
  const arrows = (target: EventTarget | null) =>
    inTabArea(target) && !inToolbar(target) && tabShown();
  return [
    {
      key: 'ArrowLeft',
      route: 'tab',
      description: strings['tab.shortcutPrevNote'],
      when: arrows,
      repeat: true,
      handler: () => session()?.selectPrev(),
    },
    {
      key: 'ArrowRight',
      route: 'tab',
      description: strings['tab.shortcutNextNote'],
      when: arrows,
      repeat: true,
      handler: () => session()?.selectNext(),
    },
    {
      key: 'Escape',
      route: 'tab',
      description: strings['tab.shortcutClearSelection'],
      when: (target) =>
        !inToolbar(target) &&
        tabShown() &&
        (session()?.getSnapshot().selectedNoteId ?? null) !== null,
      handler: () => session()?.select(null),
    },
    {
      key: 'n',
      route: 'tab',
      description: strings['tab.shortcutNextToCheck'],
      when: (target) =>
        !inToolbar(target) &&
        tabShown() &&
        (session()
          ?.getSnapshot()
          .tab?.notes.some((n) => n.lowConfidence) ??
          false),
      handler: () => {
        const s = session();
        if (!s) return;
        s.selectNextFlagged();
        focusSelectedNote(s.getSnapshot().selectedNoteId);
      },
    },
  ];
}

/**
 * Space (Play / Pause) and `P` (seek to 100 ms before the selected note and play) on the Tab
 * screen, acting on `playback()` (the mounted screen's), while the tab is shown (`session()`'s,
 * as for the arrows) and its audio is loaded; never with focus in the toolbar (the guard covers
 * text fields and, for Space, every button but the notes). `P` applies only with a note
 * selected.
 */
export function tabPlaybackShortcuts(
  session: () => Pick<TakeSession, 'getSnapshot'> | null = activeTakeSession,
  playback: () => PlaybackController | null = activePlayback,
): Shortcut[] {
  const applies = (target: EventTarget | null) => {
    if (inToolbar(target)) return false;
    return isTabShown(session()?.getSnapshot()) && (playback()?.available() ?? false);
  };
  const selected = () => session()?.getSnapshot().selectedNoteId ?? null;
  return [
    {
      key: ' ',
      route: 'tab',
      description: strings['tab.shortcutPlayPause'],
      when: applies,
      handler: () => playback()?.toggle(),
    },
    {
      key: 'p',
      route: 'tab',
      description: strings['tab.shortcutSeekToNote'],
      when: (target) => applies(target) && selected() !== null,
      handler: () => {
        const id = selected();
        if (id !== null) playback()?.playFromNote(id);
      },
    },
  ];
}

/** Every shortcut in the app. */
export const SHORTCUTS: readonly Shortcut[] = [
  {
    key: ' ',
    route: 'record',
    description: strings['record.shortcutRecordStop'],
    handler: recordToggle(recordingSession),
  },
  cancelCountIn(recordingSession),
  ...tabSelectionShortcuts(),
  ...tabPlaybackShortcuts(),
];

/**
 * Whether a shortcut's `key` matches a pressed `KeyboardEvent.key`. Single letters match either
 * case, so `N` works with Caps Lock on (Shift itself is still refused by the dispatcher).
 */
function keyMatches(key: string, pressed: string): boolean {
  if (key === pressed) return true;
  return /^[a-z]$/i.test(key) && key.toLowerCase() === pressed.toLowerCase();
}

/**
 * Runs the shortcut `event` matches on `route` (null: no known route, so only global ones), if
 * any and unless the guard skips it. Returns whether a shortcut matched; its default is then
 * prevented.
 */
export function dispatchShortcut(
  event: KeyboardEvent,
  route: Route['name'] | null,
  shortcuts: readonly Shortcut[] = SHORTCUTS,
): boolean {
  if (event.defaultPrevented) return false;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  const entry = shortcuts.find(
    (s) =>
      keyMatches(s.key, event.key) &&
      (s.route === 'global' || (route !== null && s.route === route)) &&
      (s.when?.(event.target) ?? true),
  );
  if (!entry || guarded(event.target, event.key)) return false;
  event.preventDefault();
  if (!event.repeat || entry.repeat) entry.handler();
  return true;
}

/** Installs the one shortcut `keydown` listener on `target`; returns its removal. */
export function installShortcuts(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
  shortcuts: readonly Shortcut[] = SHORTCUTS,
): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    dispatchShortcut(event, parseRoute(window.location.hash)?.name ?? null, shortcuts);
  };
  target.addEventListener('keydown', onKeyDown);
  return () => target.removeEventListener('keydown', onKeyDown);
}

/** Installs the shortcut listener while mounted. Mount exactly once, in the shell. */
export function ShortcutListener(): null {
  useEffect(() => installShortcuts(), []);
  return null;
}
