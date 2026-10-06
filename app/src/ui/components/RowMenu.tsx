// The Library row menu (story "Rename, delete take and delete audio"; EXPERIENCE.md Library,
// mockup library.html .menu): a `role="menu"` popover anchored below its "⋯" button (above when
// there is no room), kept inside the viewport. Focus starts on the first item; ↑/↓ move between
// items (wrapping), Home/End go to the ends; Tab and Shift+Tab close it and focus moves on from
// its button (WAI-ARIA menu, no trap). Focus and dismissal (Esc, a pointer-down outside) belong
// to `ui/a11y/overlays.ts`; focus returns to the button on close.
// Choosing an item closes the menu and hands its id to the owner. Placed once, it closes on a
// window scroll or resize rather than drift away from its button. A click on the button itself
// closes it (the owner toggles; the button is the overlay's `toggle`). An item with a
// `disabledReason` stays focusable but is `aria-disabled`, described by its reason, and does
// nothing when chosen.

import { Fragment, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { openOverlay } from '../a11y/overlays';
import hidden from '../a11y/visually-hidden.module.css';
import styles from './RowMenu.module.css';

/** The space kept between the menu and its button, and the viewport's edges (px). */
const GAP = 4;
const MARGIN = 8;

export interface RowMenuItem {
  id: string;
  label: string;
  icon: ReactNode;
  /** A destructive item: the danger colour. */
  danger?: boolean;
  /** A separator goes before it. */
  separated?: boolean;
  /** Set when the item cannot be chosen now: why (its description and tooltip). */
  disabledReason?: string;
}

export interface RowMenuProps {
  /** The menu's id (its button's `aria-controls`). */
  id: string;
  /** The menu's accessible name ("Actions for <title>"). */
  label: string;
  items: RowMenuItem[];
  /** The button it opened from: it anchors there and focus returns there. */
  anchor: HTMLElement;
  /** An item was chosen (the menu is closing). */
  onSelect(id: string): void;
  /** Closes the menu (Esc, Tab, a pointer-down outside, a scroll, or after a choice). */
  onClose(): void;
  /**
   * Where focus returns on close (default: `anchor`); asked at close, so a row being removed
   * can answer null.
   */
  returnFocusTo?(): HTMLElement | null;
}

export function RowMenu({
  id,
  label,
  items,
  anchor,
  onSelect,
  onClose,
  returnFocusTo,
}: RowMenuProps) {
  const ref = useRef<HTMLUListElement>(null);
  const close = useRef(onClose);
  const returnTo = useRef(returnFocusTo);
  useLayoutEffect(() => {
    close.current = onClose;
    returnTo.current = returnFocusTo;
  });

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
    // Right-aligned with its button.
    const left = Math.min(
      Math.max(MARGIN, a.right - p.width),
      Math.max(MARGIN, vw - p.width - MARGIN),
    );
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
    const release = openOverlay({
      element: el,
      opener: () => (returnTo.current ? returnTo.current() : anchor),
      toggle: anchor,
      trapTab: false,
      initialFocus: el.querySelector<HTMLElement>('[role="menuitem"]'),
      onDismiss: () => close.current(),
    });
    const dismiss = () => close.current();
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      release();
    };
  }, [anchor]);

  function onKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    const el = ref.current;
    if (!el) return;
    if (event.key === 'Tab') {
      // Not prevented: from the button, the browser moves focus on (Shift+Tab: back).
      anchor.focus();
      onClose();
      return;
    }
    const all = [...el.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    if (all.length === 0) return;
    const at = all.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (event.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % all.length;
    else if (event.key === 'ArrowUp')
      next = at < 0 ? all.length - 1 : (at - 1 + all.length) % all.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = all.length - 1;
    else return;
    event.preventDefault();
    all[next]!.focus();
  }

  return (
    <ul
      ref={ref}
      id={id}
      className={styles.menu}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <Fragment key={item.id}>
          {item.separated && <li role="separator" className={styles.separator} />}
          <li role="none">
            <button
              type="button"
              role="menuitem"
              className={item.danger ? `${styles.item} ${styles.danger}` : styles.item}
              aria-disabled={item.disabledReason !== undefined || undefined}
              aria-describedby={
                item.disabledReason !== undefined ? `${id}-${item.id}-why` : undefined
              }
              title={item.disabledReason}
              onClick={() => {
                if (item.disabledReason !== undefined) return;
                onClose();
                onSelect(item.id);
              }}
            >
              {item.icon}
              {item.label}
            </button>
            {/* Outside the button, so the reason describes it without joining its name. */}
            {item.disabledReason !== undefined && (
              <span id={`${id}-${item.id}-why`} className={hidden.visuallyHidden}>
                {item.disabledReason}
              </span>
            )}
          </li>
        </Fragment>
      ))}
    </ul>
  );
}
