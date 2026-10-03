// The app's only live regions (spine AD-18). `Announcer` is mounted once, in the shell; every
// other module announces through `announce`, and nothing else in the app sets `aria-live`.

import { createElement, Fragment, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import styles from './announcer.module.css';

export type Politeness = 'polite' | 'assertive';

type Listener = (message: string, politeness: Politeness) => void;

/** How long each polite message stays in the region at least before the next replaces it. */
export const ANNOUNCE_GAP_MS = 500;

const listeners = new Set<Listener>();

/**
 * Speaks `message` to screen readers through the shared live region. Polite by default:
 * polite messages are queued and spoken in order, each held for at least `ANNOUNCE_GAP_MS`.
 * `'assertive'` interrupts, is for errors that need attention now, and the latest one replaces
 * any still pending. A message announced before the `Announcer` mounts is dropped.
 */
export function announce(message: string, politeness: Politeness = 'polite'): void {
  for (const listener of listeners) listener(message, politeness);
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
    // Assertive: latest wins.
    let assertiveFrame: number | null = null;
    // Polite: first in, first out. `busy` while a message is being written or held.
    const queue: string[] = [];
    let busy = false;
    let politeFrame: number | null = null;
    let politeTimer: ReturnType<typeof setTimeout> | null = null;

    const next = () => {
      const message = queue.shift();
      if (message === undefined) {
        busy = false;
        return;
      }
      busy = true;
      // Clear, then set on the next frame: a repeat of the current text is a change the
      // screen reader notices, so it is announced again.
      setPolite('');
      politeFrame = requestAnimationFrame(() => {
        politeFrame = null;
        fill(setPolite, message);
        politeTimer = setTimeout(() => {
          politeTimer = null;
          next();
        }, ANNOUNCE_GAP_MS);
      });
    };

    const listener: Listener = (message, politeness) => {
      if (politeness === 'polite') {
        queue.push(message);
        if (!busy) next();
        return;
      }
      setAssertive('');
      if (assertiveFrame !== null) cancelAnimationFrame(assertiveFrame);
      assertiveFrame = requestAnimationFrame(() => {
        assertiveFrame = null;
        fill(setAssertive, message);
      });
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      queue.length = 0;
      if (assertiveFrame !== null) cancelAnimationFrame(assertiveFrame);
      if (politeFrame !== null) cancelAnimationFrame(politeFrame);
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
