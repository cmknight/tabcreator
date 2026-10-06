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
//
// Story "Change a fret and undo it" (spine AD-4): `0`–`9` set the selected note's fret (two
// digits within 400 ms make one number; the session times them), while the tab is shown and a
// note is selected. Undo (Ctrl/⌘+Z) and Redo (Ctrl/⌘+Shift+Z, Ctrl+Y) are modifier entries:
// an entry's `mod` names the modifiers it needs, `'mod'` being ⌘ on a Mac and Ctrl elsewhere.
// A key pressed with modifiers no matching entry declares is still left to the page, and the
// guard still applies (Ctrl/⌘+Z in the title field stays native).
//
// Story "String moves, delete, insert and confirm": ↑ / ↓ move the selected note to the next
// thinner / thicker string at the same pitch (from inside the tab area, like ← / →); Delete and
// Backspace delete it and `I` inserts a note after it (from anywhere on the Tab screen but the
// toolbar); Enter confirms it (from a note button or elsewhere in the tab area: the guard's
// Enter exception for note buttons). Undo and redo also work in the No notes found state while
// there is history. While an overlay is open (`ui/a11y/overlays.ts`) no shortcut runs: the
// overlay owns the keys, Esc first.
//
// Story "Trim": with focus in the Trim strip, the note edit keys (digits, Delete, Backspace, `I`,
// Enter), `N`, Space and `P` do not run: the strip's handles own their keys. Undo and redo still
// do.
//
// Story "Copy and Download on the Tab screen": Ctrl/⌘+Shift+C copies the tab (as the toolbar's
// Copy does: the shown notes, bar lines only with the toggle on) while it is shown, with the
// edit keys' guards: not in a text field, not under an overlay, not in the Trim strip.

import { useEffect } from 'react';
import { recordingSession, type RecordingSession } from '../../session/recording-session';
import type { RecordingSnapshot } from '../../session/recording-types';
import { activePlayback, type PlaybackController } from '../../session/playback';
import { settingsSession } from '../../session/settings-session';
import {
  activeTakeSession,
  isTabShown,
  shownNotes,
  type TakeSession,
} from '../../session/take-session';
import { parseRoute, type Route } from '../router';
import { isOverlayOpen } from './overlays';
import { NOTE_BUTTON, TAB_AREA, TEXT_FIELD, TOOLBAR, TRIM_STRIP } from './selectors';
import { strings } from '../strings';
import { copyTab, tabExportText } from '../tab-export';

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
  /**
   * The modifiers it needs (default: none). `'mod'`: Ctrl, or ⌘ on a Mac; `'mod+shift'`: that
   * and Shift; `'ctrl'`: Ctrl on every platform. Any other modifier held means no match.
   */
  mod?: 'mod' | 'mod+shift' | 'ctrl';
  /**
   * Whether it also matches with Shift held (default: no). The digits: on some layouts (French
   * AZERTY) the number row types digits only with Shift.
   */
  shiftOk?: boolean;
}

/** Whether the platform is a Mac (⌘ is the command modifier there). */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return /mac|iphone|ipad|ipod|ios/i.test(data?.platform ?? navigator.platform ?? '');
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
 * focused, so pressing it would do nothing visible. Enter on a note button is not guarded either
 * (story "String moves, delete, insert and confirm"): it confirms the note. Enter on any other
 * button stays native.
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
  if (key === 'Enter') {
    if (target.closest(NOTE_BUTTON)) return false;
    return target.closest(ENTER_ACTION) !== null;
  }
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
 * Whether `target` is inside the Trim strip (story "Trim"): its handles own their keys, so the
 * note edit, Next to check and playback shortcuts do not run there.
 */
function inTrimStrip(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(TRIM_STRIP) !== null;
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
        !inTrimStrip(target) &&
        tabShown() &&
        shownNotes(session()?.getSnapshot() ?? { take: null, tab: null }).some(
          (n) => n.lowConfidence,
        ),
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
    if (inToolbar(target) || inTrimStrip(target)) return false;
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

type EditSession = Pick<
  TakeSession,
  | 'getSnapshot'
  | 'typeDigit'
  | 'undo'
  | 'redo'
  | 'canUndo'
  | 'canRedo'
  | 'moveStringBy'
  | 'deleteSelected'
  | 'insert'
  | 'confirm'
>;

/**
 * The Tab screen's edit keys, acting on `session()` (the mounted screen's) while its tab is
 * shown: `0`–`9` set the selected note's fret (only with a note selected), Ctrl/⌘+Z undoes,
 * Ctrl/⌘+Shift+Z and Ctrl+Y redo (nothing to undo or redo: nothing happens; with no notes left,
 * they apply only while there is something to undo or redo). ↑ / ↓ move the selected note to
 * the next thinner / thicker string (inside the tab area, held down they repeat), Delete and
 * Backspace delete it, `I` inserts a note after it (or before the first note with none
 * selected), Enter confirms it (on a note button or elsewhere in the tab area). None of those
 * applies in the toolbar; undo and redo do (focus on the Undo button, say).
 */
export function tabEditShortcuts(
  session: () => EditSession | null = activeTakeSession,
): Shortcut[] {
  const tabShown = () => isTabShown(session()?.getSnapshot());
  const selected = () => (session()?.getSnapshot().selectedNoteId ?? null) !== null;
  /** The No notes found state: analysed, idle, a tab with no visible notes. */
  const noNotes = () => {
    const snap = session()?.getSnapshot();
    return (
      !!snap &&
      !snap.missing &&
      snap.analysis.kind === 'idle' &&
      !!snap.take &&
      !!snap.tab &&
      shownNotes(snap).length === 0
    );
  };
  const canUndo = () => tabShown() || (noNotes() && (session()?.canUndo() ?? false));
  const canRedo = () => tabShown() || (noNotes() && (session()?.canRedo() ?? false));
  const inArea = (target: EventTarget | null) =>
    inTabArea(target) && !inToolbar(target) && tabShown() && selected();
  const onScreen = (target: EventTarget | null) =>
    !inToolbar(target) && !inTrimStrip(target) && tabShown();
  const digits: Shortcut[] = Array.from({ length: 10 }, (_, digit) => ({
    key: String(digit),
    route: 'tab',
    shiftOk: true,
    description: strings['tab.shortcutSetFret'],
    when: (target) =>
      !inToolbar(target) &&
      !inTrimStrip(target) &&
      tabShown() &&
      (session()?.getSnapshot().selectedNoteId ?? null) !== null,
    handler: () => session()?.typeDigit(digit),
  }));
  return [
    ...digits,
    {
      key: 'z',
      mod: 'mod',
      route: 'tab',
      description: strings['tab.shortcutUndo'],
      when: canUndo,
      handler: () => void session()?.undo(),
    },
    {
      key: 'z',
      mod: 'mod+shift',
      route: 'tab',
      description: strings['tab.shortcutRedo'],
      when: canRedo,
      handler: () => void session()?.redo(),
    },
    {
      key: 'y',
      mod: 'ctrl',
      route: 'tab',
      description: strings['tab.shortcutRedo'],
      when: canRedo,
      handler: () => void session()?.redo(),
    },
    {
      key: 'ArrowUp',
      route: 'tab',
      description: strings['tab.shortcutStringUp'],
      when: inArea,
      repeat: true,
      handler: () => void session()?.moveStringBy(-1),
    },
    {
      key: 'ArrowDown',
      route: 'tab',
      description: strings['tab.shortcutStringDown'],
      when: inArea,
      repeat: true,
      handler: () => void session()?.moveStringBy(1),
    },
    ...['Delete', 'Backspace'].map((key): Shortcut => ({
      key,
      route: 'tab',
      description: strings['tab.shortcutDelete'],
      when: (target) => onScreen(target) && selected(),
      handler: () => void session()?.deleteSelected(),
    })),
    {
      key: 'i',
      route: 'tab',
      description: strings['tab.shortcutInsert'],
      when: onScreen,
      handler: () => void session()?.insert(),
    },
    {
      key: 'Enter',
      route: 'tab',
      description: strings['tab.shortcutConfirm'],
      when: inArea,
      handler: () => {
        const s = session();
        const id = s?.getSnapshot().selectedNoteId ?? null;
        if (s && id !== null) void s.confirm(id);
      },
    },
  ];
}

/**
 * Ctrl/⌘+Shift+C on the Tab screen: copies the shown tab (`toText` over the visible notes, bar
 * lines only while `barLines()` is on) through `copy`, which toasts the outcome. Applies only
 * while the tab is shown with visible notes, and not from the Trim strip (the guard covers text
 * fields, the dispatcher overlays).
 */
export function tabExportShortcuts(
  session: () => Pick<TakeSession, 'getSnapshot'> | null = activeTakeSession,
  barLines: () => boolean = () => settingsSession.getSnapshot().prefs.barLines,
  copy: (text: string) => Promise<void> = copyTab,
): Shortcut[] {
  return [
    {
      key: 'c',
      mod: 'mod+shift',
      route: 'tab',
      description: strings['tab.shortcutCopy'],
      when: (target) => !inTrimStrip(target) && isTabShown(session()?.getSnapshot()),
      handler: () => {
        const snap = session()?.getSnapshot();
        if (!snap?.take || !isTabShown(snap)) return;
        void copy(tabExportText(snap.take, shownNotes(snap), barLines()));
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
  ...tabEditShortcuts(),
  ...tabExportShortcuts(),
];

/**
 * Whether a shortcut's `key` matches a pressed `KeyboardEvent.key`. Single letters match either
 * case, so `N` works with Caps Lock on (Shift itself is still refused by the dispatcher).
 */
function keyMatches(key: string, pressed: string): boolean {
  if (key === pressed) return true;
  return /^[a-z]$/i.test(key) && key.toLowerCase() === pressed.toLowerCase();
}

/** Whether the modifiers held in `event` are exactly those `entry.mod` needs (Shift also with `shiftOk`). */
function modMatches(entry: Shortcut, event: KeyboardEvent, mac: boolean): boolean {
  const { mod } = entry;
  const { ctrlKey, metaKey, altKey, shiftKey } = event;
  if (altKey) return false;
  if (mod === undefined) return !ctrlKey && !metaKey && (!shiftKey || entry.shiftOk === true);
  if (mod === 'ctrl') return ctrlKey && !metaKey && !shiftKey;
  const command = mac ? metaKey && !ctrlKey : ctrlKey && !metaKey;
  return command && shiftKey === (mod === 'mod+shift');
}

/**
 * Whether `entry` matches `event`'s key. A modifier entry also matches by physical key
 * (`event.code` `Key<letter>`), so Ctrl+Z works on non-Latin layouts, where `key` is, say, 'я'.
 */
function entryKeyMatches(entry: Shortcut, event: KeyboardEvent): boolean {
  if (keyMatches(entry.key, event.key)) return true;
  return (
    entry.mod !== undefined &&
    /^[a-z]$/i.test(entry.key) &&
    event.code === `Key${entry.key.toUpperCase()}`
  );
}

/**
 * Runs the shortcut `event` matches on `route` (null: no known route, so only global ones), if
 * any and unless the guard skips it. Returns whether a shortcut matched; its default is then
 * prevented. A key held with modifiers matches only an entry declaring exactly those (`mod`;
 * `mac` decides what `'mod'` means).
 */
export function dispatchShortcut(
  event: KeyboardEvent,
  route: Route['name'] | null,
  shortcuts: readonly Shortcut[] = SHORTCUTS,
  mac: boolean = isMacPlatform(),
): boolean {
  if (event.defaultPrevented || isOverlayOpen()) return false;
  const entry = shortcuts.find(
    (s) =>
      modMatches(s, event, mac) &&
      entryKeyMatches(s, event) &&
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
  mac: () => boolean = isMacPlatform,
): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    dispatchShortcut(event, parseRoute(window.location.hash)?.name ?? null, shortcuts, mac());
  };
  target.addEventListener('keydown', onKeyDown);
  return () => target.removeEventListener('keydown', onKeyDown);
}

/** Installs the shortcut listener while mounted. Mount exactly once, in the shell. */
export function ShortcutListener(): null {
  useEffect(() => installShortcuts(), []);
  return null;
}
