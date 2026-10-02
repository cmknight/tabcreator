// The app's only live regions (spine AD-18). `Announcer` is mounted once, in the shell; every
// other module announces through `announce`, and nothing else in the app sets `aria-live`.

import { createElement, Fragment, useEffect, useState } from 'react';
import styles from './announcer.module.css';

export type Politeness = 'polite' | 'assertive';

type Listener = (message: string, politeness: Politeness) => void;

const listeners = new Set<Listener>();

/**
 * Speaks `message` to screen readers through the shared live region. Polite by default;
 * `'assertive'` interrupts and is for errors that need attention now. A message announced
 * before the `Announcer` mounts is dropped.
 */
export function announce(message: string, politeness: Politeness = 'polite'): void {
  for (const listener of listeners) listener(message, politeness);
}

/** One polite and one assertive region, visually hidden. Mount exactly once. */
export function Announcer() {
  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');

  useEffect(() => {
    const pending: Record<Politeness, number | null> = { polite: null, assertive: null };
    const listener: Listener = (message, politeness) => {
      const set = politeness === 'assertive' ? setAssertive : setPolite;
      // Clear, then set on the next frame: a repeat of the current text is a change the
      // screen reader notices, so it is announced again.
      set('');
      const previous = pending[politeness];
      if (previous !== null) cancelAnimationFrame(previous);
      pending[politeness] = requestAnimationFrame(() => {
        pending[politeness] = null;
        set(message);
      });
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      for (const id of Object.values(pending)) if (id !== null) cancelAnimationFrame(id);
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
