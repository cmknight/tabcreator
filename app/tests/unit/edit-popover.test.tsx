import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { Note } from '../../src/model/types';
import { isOverlayOpen } from '../../src/ui/a11y/overlays';
import { EditPopover } from '../../src/ui/components/EditPopover';

// Story "String moves, delete, insert and confirm": the edit popover's placement, dismissal on
// scroll and resize, its fret hint, and where focus returns.

const NOTE: Note = {
  id: 'n1',
  startMs: 0,
  endMs: 200,
  midi: 62,
  confidence: 0.9,
  string: 2,
  fret: 3,
  locked: false,
  lowConfidence: false,
};

const rect = (left: number, top: number, width: number, height: number) =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
  }) as DOMRect;

let anchorRect = rect(100, 100, 10, 20);
const POPOVER = { width: 200, height: 150 };

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.getAttribute('role') === 'dialog') return rect(0, 0, POPOVER.width, POPOVER.height);
    if (this.hasAttribute('data-note-id')) return anchorRect;
    return rect(0, 0, 0, 0);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

/** A tab area with note buttons, and the popover on `n1` while open. */
function Harness({ returnTo }: { returnTo?: () => string }) {
  const [open, setOpen] = useState(true);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <div role="application" aria-label="Tab">
        <button type="button" data-note-id="n1" ref={setAnchor}>
          n1
        </button>
        <button type="button" data-note-id="n2">
          n2
        </button>
      </div>
      {open && anchor && (
        <EditPopover
          note={NOTE}
          maxFret={24}
          anchor={anchor}
          onSetFret={() => {}}
          onMove={() => {}}
          onConfirm={() => {}}
          onClose={() => setOpen(false)}
          {...(returnTo ? { returnFocusTo: returnTo } : {})}
        />
      )}
    </>
  );
}

const dialog = () => screen.getByRole('dialog', { name: 'Edit note' });

describe('EditPopover placement', () => {
  it('sits below the note', () => {
    anchorRect = rect(100, 100, 10, 20);
    render(<Harness />);
    expect(dialog().style.top).toBe('124px'); // bottom 120 + 4
    expect(dialog().style.left).toBe('100px');
  });

  it('above the note near the bottom of the viewport', () => {
    anchorRect = rect(100, 700, 10, 20);
    render(<Harness />);
    expect(dialog().style.top).toBe(`${700 - 4 - 150}px`);
  });

  it('its left edge clamped near the right edge of the viewport', () => {
    anchorRect = rect(950, 100, 10, 20);
    render(<Harness />);
    expect(dialog().style.left).toBe(`${1000 - 200 - 8}px`);
  });
});

describe('EditPopover dismissal and focus', () => {
  it.each(['scroll', 'resize'])('a window %s closes it', (type) => {
    render(<Harness />);
    expect(isOverlayOpen()).toBe(true);
    act(() => {
      window.dispatchEvent(new Event(type));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(isOverlayOpen()).toBe(false);
  });

  it('shows the allowed range, linked to the fret field', () => {
    render(<Harness />);
    const field = screen.getByLabelText('Fret');
    const hint = document.getElementById(field.getAttribute('aria-describedby')!)!;
    expect(hint.textContent).toBe('0 to 24');
    fireEvent.change(field, { target: { value: '30' } });
    fireEvent.submit((field as HTMLInputElement).form!);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(hint.textContent).toBe('0 to 24');
  });

  it("focus returns to the note's current button when a reflow replaced the one it opened from", () => {
    render(<Harness />);
    const old = document.querySelector<HTMLElement>('[data-note-id="n1"]')!;
    const area = old.parentElement!;
    // A reflow re-creates the note's button.
    old.remove();
    const fresh = document.createElement('button');
    fresh.setAttribute('data-note-id', 'n1');
    area.append(fresh);
    fireEvent.keyDown(screen.getByLabelText('Fret'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(fresh);
  });

  it('focus goes to the note `returnFocusTo` names at close', () => {
    let target = 'n1';
    render(<Harness returnTo={() => target} />);
    target = 'n2';
    fireEvent.keyDown(screen.getByLabelText('Fret'), { key: 'Escape' });
    expect(document.activeElement).toBe(document.querySelector('[data-note-id="n2"]'));
  });
});
