// The app's only keyboard-shortcut registry (spine AD-18). `ShortcutListener` is mounted once,
// in the shell, and installs the one `keydown` listener every shortcut goes through; nothing
// else in the app listens to `keydown` for shortcuts. Each entry names its key, the route it
// works on, a description (for the later `?` dialog) and a handler.
//
// The guard (EXPERIENCE.md Interaction Primitives): a shortcut never fires while focus is in a
// text field (input, textarea, select, contenteditable), nor on an element where the key has a
// native action (Space or Enter on a button, a link or a checkbox), so that element's own action
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
  /** The route the shortcut works on. */
  route: Route['name'];
  /** What it does, as the `?` dialog lists it. */
  description: string;
  handler: () => void;
}

/** The latency mark set at a handled Space keydown on Record (story 3.5, Done when 1). */
export const RECORD_KEYDOWN_MARK = 'record-keydown';

/** Keys that activate a focused button, link or checkbox natively. */
const NATIVE_ACTION_KEYS = new Set([' ', 'Enter']);

const TEXT_FIELD = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const NATIVE_ACTION =
  'button, a[href], summary, [role="button"], [role="link"], [role="checkbox"], [role="switch"]';

/**
 * Whether `key` pressed with focus on `target` must be left to the page: focus is in a text
 * field, or on an element where the key has a native action.
 */
export function guarded(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(TEXT_FIELD)) return true;
  return NATIVE_ACTION_KEYS.has(key) && target.closest(NATIVE_ACTION) !== null;
}

/** The parts of the recording store the Space toggle uses. */
type RecordToggleStore = Pick<RecordingSession, 'getSnapshot' | 'record' | 'stop'>;

/**
 * Space on Record: while the mic is live, idle → `record()`, recording → `stop('user')`;
 * ignored while the take starts or stops, or with no live mic.
 */
export function recordToggle(
  store: RecordToggleStore,
  mark: (name: string) => void = (name) => performance.mark(name),
): () => void {
  return () => {
    const { mic, recording }: RecordingSnapshot = store.getSnapshot();
    if (mic !== 'live') return;
    if (recording === 'idle') {
      mark(RECORD_KEYDOWN_MARK);
      void store.record();
    } else if (recording === 'recording') {
      mark(RECORD_KEYDOWN_MARK);
      void store.stop('user');
    }
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
];

/**
 * Runs the shortcut `event` matches on `route` (null: no known route), if any and unless the
 * guard skips it. Returns whether a shortcut matched; its default is then prevented.
 */
export function dispatchShortcut(
  event: KeyboardEvent,
  route: Route['name'] | null,
  shortcuts: readonly Shortcut[] = SHORTCUTS,
): boolean {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return false;
  if (route === null) return false;
  const entry = shortcuts.find((s) => s.key === event.key && s.route === route);
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
