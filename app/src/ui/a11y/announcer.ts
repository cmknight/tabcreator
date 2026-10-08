// The app's only live regions (spine AD-18). `Announcer` is mounted once, in the shell; every
// other module announces through `announce`, and nothing else in the app sets `aria-live`.

import { createElement, Fragment, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import styles from './visually-hidden.module.css';

export type Politeness = 'polite' | 'assertive';

/** Options for `announce`. */
export interface AnnounceOptions {
  /**
   * A minor assertive message (a count-in beat): dropped while a non-minor assertive message is
   * pending or was shown within `ASSERTIVE_HOLD_MS`, and replaced by any non-minor one.
   */
  minor?: boolean;
  /**
   * An assertive message that is a new event although its text repeats the last one (a retry
   * that failed the same way again): never dropped as a duplicate.
   */
  repeat?: boolean;
}

type Listener = (message: string, politeness: Politeness, options: AnnounceOptions) => void;

/** How long each polite message stays in the region at least before the next replaces it. */
export const ANNOUNCE_GAP_MS = 500;
/** At most this many polite messages wait; a further one drops the oldest waiting. */
export const ANNOUNCE_QUEUE_MAX = 5;
/** A polite message that waited longer than this when its turn comes is dropped. */
export const ANNOUNCE_EXPIRY_MS = 10_000;
/**
 * How long a shown non-minor assertive message keeps minor ones out (a whole count-in at the
 * slowest tempo: 4 beats at 40 BPM).
 */
export const ASSERTIVE_HOLD_MS = 6_000;
/**
 * How long a shown assertive text is not repeated: two owners announcing one event (the shell
 * and a screen's banner) do so in the same moment. Shorter than `ASSERTIVE_HOLD_MS`, so the
 * same failure met again on a retry a few seconds later is announced again.
 */
export const ASSERTIVE_REPEAT_MS = 1_000;

const listeners = new Set<Listener>();

/**
 * Speaks `message` to screen readers through the shared live region. Polite by default:
 * polite messages are queued and spoken in order, each held for at least `ANNOUNCE_GAP_MS`; at
 * most `ANNOUNCE_QUEUE_MAX` wait (the oldest waiting is dropped), and one that waited longer
 * than `ANNOUNCE_EXPIRY_MS` is dropped when its turn comes. `'assertive'` interrupts, is for
 * errors that need attention now, and the latest one replaces any still pending, except that a
 * `minor` one (a count-in beat) never replaces or follows closely a non-minor one, and a text
 * equal to the pending one, or to one shown within `ASSERTIVE_REPEAT_MS`, is dropped. A message
 * announced before the `Announcer` mounts is dropped.
 */
export function announce(
  message: string,
  politeness: Politeness = 'polite',
  options: AnnounceOptions = {},
): void {
  for (const listener of listeners) listener(message, politeness, options);
}

/** One polite and one assertive region, visually hidden. Mount exactly once. */
export function Announcer() {
  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');

  useEffect(() => {
    /**
     * Sets a region on the frame after it was cleared. The clear is committed first (a no-op if
     * React already rendered it): were the two batched into one render, a repeat of the current
     * text would change nothing in the DOM and not be announced again.
     */
    const fill = (set: (text: string) => void, message: string) => {
      flushSync(() => set(''));
      set(message);
    };
    /** Work scheduled for the next frame (`frame`) or, while the page is hidden, a timer. */
    interface Pending {
      run: () => void;
      cancel: () => void;
      frame: boolean;
    }
    /**
     * Runs `run` on the next frame, or through a timer while the page is hidden (a hidden tab
     * runs no frames, so the regions would stall). Browsers throttle a hidden tab's timers, so a
     * long-hidden backlog may expire rather than play: intended, stale messages are dropped.
     */
    const later = (run: () => void): Pending => {
      if (document.hidden) {
        const timer = setTimeout(run, 0);
        return { run, frame: false, cancel: () => clearTimeout(timer) };
      }
      const frame = requestAnimationFrame(run);
      return { run, frame: true, cancel: () => cancelAnimationFrame(frame) };
    };
    // Assertive: latest wins; a minor message yields to a non-minor one, and a repeat of the
    // pending or recently shown text is dropped.
    let assertivePending: Pending | null = null;
    /** The pending assertive message's text, and whether it is non-minor. */
    let assertivePendingText: string | null = null;
    let assertivePendingMajor = false;
    /** When the last non-minor assertive message was shown. */
    let majorShownAt = -Infinity;
    /** The last assertive text shown, and when. */
    let assertiveShownText: string | null = null;
    let assertiveShownAt = -Infinity;
    // Polite: first in, first out. `busy` while a message is being written or held.
    const queue: { message: string; at: number }[] = [];
    let busy = false;
    let politePending: Pending | null = null;
    let politeTimer: ReturnType<typeof setTimeout> | null = null;

    const next = () => {
      if (queue.length === 0) {
        busy = false;
        return;
      }
      busy = true;
      // Clear, then set on the next frame: a repeat of the current text is a change the
      // screen reader notices, so it is announced again. The message is taken then, so a burst
      // arriving meanwhile is capped as one.
      setPolite('');
      politePending = later(() => {
        politePending = null;
        const now = performance.now();
        let entry = queue.shift();
        while (entry !== undefined && now - entry.at > ANNOUNCE_EXPIRY_MS) entry = queue.shift();
        if (entry === undefined) {
          busy = false;
          return;
        }
        fill(setPolite, entry.message);
        politeTimer = setTimeout(() => {
          politeTimer = null;
          next();
        }, ANNOUNCE_GAP_MS);
      });
    };

    const listener: Listener = (message, politeness, options) => {
      if (politeness === 'polite') {
        queue.push({ message, at: performance.now() });
        while (queue.length > ANNOUNCE_QUEUE_MAX) queue.shift();
        if (!busy) next();
        return;
      }
      const now = performance.now();
      const minor = options.minor === true;
      if (minor && (assertivePendingMajor || now - majorShownAt < ASSERTIVE_HOLD_MS)) return;
      // The same text pending, or shown within the hold: one moment, one announcement (a stop
      // announced by the shell and by the screen's banner at once).
      if (options.repeat !== true) {
        if (message === assertivePendingText) return;
        if (message === assertiveShownText && now - assertiveShownAt < ASSERTIVE_REPEAT_MS) return;
      }
      assertivePendingMajor = !minor;
      assertivePendingText = message;
      setAssertive('');
      assertivePending?.cancel();
      assertivePending = later(() => {
        assertivePending = null;
        const shownAt = performance.now();
        if (assertivePendingMajor) majorShownAt = shownAt;
        assertiveShownText = message;
        assertiveShownAt = shownAt;
        assertivePendingMajor = false;
        assertivePendingText = null;
        fill(setAssertive, message);
      });
    };
    // The page hidden with a frame scheduled: that frame would not run until it shows again, so
    // the same work moves to the timer path.
    const onVisibility = () => {
      if (!document.hidden) return;
      if (politePending?.frame) {
        politePending.cancel();
        politePending = later(politePending.run);
      }
      if (assertivePending?.frame) {
        assertivePending.cancel();
        assertivePending = later(assertivePending.run);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      document.removeEventListener('visibilitychange', onVisibility);
      queue.length = 0;
      assertivePending?.cancel();
      politePending?.cancel();
      if (politeTimer !== null) clearTimeout(politeTimer);
    };
  }, []);

  return createElement(
    Fragment,
    null,
    createElement(
      'div',
      { className: styles.visuallyHidden, role: 'status', 'aria-live': 'polite' },
      polite,
    ),
    createElement(
      'div',
      { className: styles.visuallyHidden, role: 'alert', 'aria-live': 'assertive' },
      assertive,
    ),
  );
}
