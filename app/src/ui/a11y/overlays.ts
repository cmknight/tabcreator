// The app's overlay manager (spine AD-18; story "String moves, delete, insert and confirm";
// EXPERIENCE.md: overlays are one level deep, never stacked). An overlay (a popover, later the
// dialogs) registers its element while open: focus moves into it, Tab and Shift+Tab cycle inside
// it, and Esc or a pointer-down outside it dismisses it. Releasing it gives focus back to the
// element that opened it. Opening an overlay dismisses any open one first.
//
// While an overlay is open, `isOverlayOpen()` is true: the shortcut registry then runs no
// shortcut (the overlay's own keys only), and the tab area does not move focus. This module owns
// focus and dismissal, not layout.

/** What can take focus inside an overlay, for the Tab trap. */
const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export interface OverlayOptions {
  /** The overlay's element. */
  element: HTMLElement;
  /**
   * The element that opened it: focus returns there on release. A function is called at
   * release, so it can find the opener's replacement (a note button a reflow re-created).
   */
  opener: HTMLElement | null | (() => HTMLElement | null);
  /** Focused on open (default: the first focusable element inside, else the overlay). */
  initialFocus?: HTMLElement | null;
  /**
   * Called on Esc, on a pointer-down outside, and when another overlay opens: the owner closes
   * the overlay (and releases it).
   */
  onDismiss(): void;
}

interface Open {
  options: OverlayOptions;
  remove(): void;
}

let current: Open | null = null;
const changeListeners = new Set<() => void>();

function setCurrent(next: Open | null) {
  current = next;
  for (const l of [...changeListeners]) l();
}

/** Whether an overlay is open. */
export function isOverlayOpen(): boolean {
  return current !== null;
}

/** Calls `listener` whenever an overlay opens or closes; returns the removal. */
export function subscribeOverlay(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

function focusables(element: HTMLElement): HTMLElement[] {
  return [...element.querySelectorAll<HTMLElement>(FOCUSABLE)];
}

/**
 * Opens an overlay: dismisses any open one, moves focus into it, traps Tab, and listens for Esc
 * and outside pointer-downs. Returns its release, which the owner calls when it closes (also on
 * unmount): the listeners go, and focus returns to the opener when it was inside the overlay
 * (or lost to <body>).
 */
export function openOverlay(options: OverlayOptions): () => void {
  if (current) {
    const previous = current;
    setCurrent(null);
    previous.remove();
    previous.options.onDismiss();
  }
  const { element } = options;
  const doc = element.ownerDocument;

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      options.onDismiss();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusables(element);
    if (items.length === 0) {
      event.preventDefault();
      element.focus();
      return;
    }
    const first = items[0]!;
    const last = items.at(-1)!;
    const active = doc.activeElement;
    const inside = active instanceof Node && element.contains(active);
    if (event.shiftKey && (active === first || !inside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !inside)) {
      event.preventDefault();
      first.focus();
    }
  };
  const onPointerDown = (event: Event) => {
    const target = event.target;
    if (target instanceof Node && element.contains(target)) return;
    options.onDismiss();
  };
  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('pointerdown', onPointerDown, true);

  const entry: Open = {
    options,
    remove() {
      doc.removeEventListener('keydown', onKeyDown, true);
      doc.removeEventListener('pointerdown', onPointerDown, true);
    },
  };
  setCurrent(entry);
  (options.initialFocus ?? focusables(element)[0] ?? element).focus();

  return () => {
    if (current !== entry) return; // dismissed by a newer overlay: already removed
    entry.remove();
    const active = doc.activeElement;
    const lost = active === null || active === doc.body || element.contains(active);
    const opener = typeof options.opener === 'function' ? options.opener() : options.opener;
    if (lost && opener?.isConnected) opener.focus();
    setCurrent(null);
  };
}
