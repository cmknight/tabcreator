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
// auto-repeat is ignored: holding a key fires once.

import { useEffect } from 'react';
import {
  recordingSession,
  type RecordingSession,
  type RecordingSnapshot,
} from '../../session/recording-session';
import { parseRoute, type Route } from '../router';
import { strings } from '../strings';

export interface Shortcut {
  /** `KeyboardEvent.key`, e.g. `' '` for Space. */
  key: string;
  /** The route the shortcut works on; `global` works on every route. */
  route: Route['name'] | 'global';
  /** What it does, as the `?` dialog lists it. */
  description: string;
  handler: () => void;
  /** Whether it applies now; when false the key is not handled (default: always). */
  when?: () => boolean;
}

/** The latency mark set at a handled Space keydown on Record (story 3.5, Done when 1). */
export const RECORD_KEYDOWN_MARK = 'record-keydown';

const TEXT_FIELD = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
/** Elements Space activates natively (links do not: Space on a link only scrolls). */
const SPACE_ACTION = 'button, summary, [role="button"], [role="checkbox"], [role="switch"]';
/** Elements Enter activates natively. */
const ENTER_ACTION = `${SPACE_ACTION}, a[href], [role="link"]`;

/**
 * Whether `key` pressed with focus on `target` must be left to the page: focus is in a text
 * field, or on an element where the key has a native action (Space: a button or checkbox;
 * Enter: those and links).
 */
export function guarded(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(TEXT_FIELD)) return true;
  if (key === ' ') return target.closest(SPACE_ACTION) !== null;
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
 * count-in → `stop('user')` (cancels it); ignored while the take starts or stops, or with no
 * live mic. The latency marks are set (and cleared) only with the count-in off: with it on, the
 * capture opens at beat five, so the pair would measure the count-in, not the latency.
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
    } else if (recording === 'count-in') {
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

/** Every shortcut in the app. */
export const SHORTCUTS: readonly Shortcut[] = [
  {
    key: ' ',
    route: 'record',
    description: strings['record.shortcutRecordStop'],
    handler: recordToggle(recordingSession),
  },
  cancelCountIn(recordingSession),
];

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
      s.key === event.key &&
      (s.route === 'global' || (route !== null && s.route === route)) &&
      (s.when?.() ?? true),
  );
  if (!entry || guarded(event.target, event.key)) return false;
  event.preventDefault();
  if (!event.repeat) entry.handler();
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
