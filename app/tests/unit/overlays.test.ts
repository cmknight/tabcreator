import { afterEach, describe, expect, it, vi } from 'vitest';
import { isOverlayOpen, openOverlay } from '../../src/ui/a11y/overlays';

// Story "String moves, delete, insert and confirm" (spine AD-18): the overlay manager.

function setup() {
  const opener = document.createElement('button');
  opener.textContent = 'note';
  document.body.append(opener);
  opener.focus();
  const overlay = document.createElement('div');
  overlay.tabIndex = -1;
  const field = overlay.appendChild(document.createElement('input'));
  const middle = overlay.appendChild(document.createElement('button'));
  const last = overlay.appendChild(document.createElement('button'));
  document.body.append(overlay);
  return { opener, overlay, field, middle, last };
}

function key(target: EventTarget, k: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

const releases: (() => void)[] = [];
afterEach(() => {
  for (const r of releases.splice(0)) r();
  document.body.innerHTML = '';
});

describe('overlays', () => {
  it('moves focus in (to the initial focus), and reports itself open until released', () => {
    const { opener, overlay, middle } = setup();
    expect(isOverlayOpen()).toBe(false);
    const release = openOverlay({ element: overlay, opener, initialFocus: middle, onDismiss() {} });
    expect(isOverlayOpen()).toBe(true);
    expect(document.activeElement).toBe(middle);
    release();
    expect(isOverlayOpen()).toBe(false);
    expect(document.activeElement).toBe(opener); // focus restored
  });

  it('defaults focus to the first focusable element', () => {
    const { opener, overlay, field } = setup();
    releases.push(openOverlay({ element: overlay, opener, onDismiss() {} }));
    expect(document.activeElement).toBe(field);
  });

  it('traps Tab and Shift+Tab inside', () => {
    const { opener, overlay, field, last } = setup();
    releases.push(openOverlay({ element: overlay, opener, onDismiss() {} }));
    last.focus();
    expect(key(last, 'Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(field);
    expect(key(field, 'Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    // In the middle, Tab is left to the browser (it stays inside).
    field.focus();
    expect(key(field, 'Tab').defaultPrevented).toBe(false);
    // Focus somehow outside: Tab brings it back in.
    opener.focus();
    key(opener, 'Tab');
    expect(document.activeElement).toBe(field);
  });

  it('Esc dismisses it, and no other keydown listener sees that Esc', () => {
    const { opener, overlay, field } = setup();
    const onDismiss = vi.fn();
    const outer = vi.fn();
    window.addEventListener('keydown', outer);
    releases.push(openOverlay({ element: overlay, opener, onDismiss }));
    expect(key(field, 'Escape').defaultPrevented).toBe(true);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    key(field, 'a');
    expect(outer).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', outer);
  });

  it('a pointer-down outside dismisses it; inside does not', () => {
    const { opener, overlay, middle } = setup();
    const onDismiss = vi.fn();
    releases.push(openOverlay({ element: overlay, opener, onDismiss }));
    middle.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(onDismiss).not.toHaveBeenCalled();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('a pointer-down on its toggle (the menu button) does not dismiss it', () => {
    const { opener, overlay } = setup();
    const onDismiss = vi.fn();
    releases.push(openOverlay({ element: overlay, opener, toggle: opener, onDismiss }));
    opener.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(onDismiss).not.toHaveBeenCalled();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('trapTab false: Tab is left to the owner (not prevented)', () => {
    const { opener, overlay, last } = setup();
    releases.push(openOverlay({ element: overlay, opener, trapTab: false, onDismiss() {} }));
    last.focus();
    expect(key(last, 'Tab').defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(last);
  });

  it('one level: opening another dismisses the open one', () => {
    const a = setup();
    const b = setup();
    const dismissA = vi.fn();
    const releaseA = openOverlay({ element: a.overlay, opener: a.opener, onDismiss: dismissA });
    const releaseB = openOverlay({ element: b.overlay, opener: b.opener, onDismiss() {} });
    expect(dismissA).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(b.field);
    releaseA(); // already superseded: changes nothing
    expect(isOverlayOpen()).toBe(true);
    expect(document.activeElement).toBe(b.field);
    // Esc reaches only the open one.
    key(b.field, 'Escape');
    expect(dismissA).toHaveBeenCalledTimes(1);
    releaseB();
    expect(isOverlayOpen()).toBe(false);
  });

  it('an opener given as a function is resolved at release', () => {
    const { opener, overlay } = setup();
    const replacement = document.body.appendChild(document.createElement('button'));
    let current: HTMLElement = opener;
    const release = openOverlay({ element: overlay, opener: () => current, onDismiss() {} });
    opener.remove();
    current = replacement;
    release();
    expect(document.activeElement).toBe(replacement);
  });

  it('subscribers hear it open and close', async () => {
    const { subscribeOverlay } = await import('../../src/ui/a11y/overlays');
    const { opener, overlay } = setup();
    const heard: boolean[] = [];
    const stop = subscribeOverlay(() => heard.push(isOverlayOpen()));
    const release = openOverlay({ element: overlay, opener, onDismiss() {} });
    release();
    stop();
    expect(heard).toEqual([true, false]);
  });

  it('release leaves focus alone when it already moved outside the overlay', () => {
    const { opener, overlay } = setup();
    const elsewhere = document.body.appendChild(document.createElement('button'));
    const release = openOverlay({ element: overlay, opener, onDismiss() {} });
    elsewhere.focus();
    release();
    expect(document.activeElement).toBe(elsewhere);
  });
});
