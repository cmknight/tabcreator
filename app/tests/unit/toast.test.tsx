import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Announcer } from '../../src/ui/a11y/announcer';
import { ToastHost } from '../../src/ui/components/ToastHost';
import { dismissToast, showToast, TOAST_MS } from '../../src/ui/toast';

const toast = () => screen.queryByTestId('toast');
const polite = () => document.querySelector('[aria-live="polite"]');
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe('toast focus return', () => {
  beforeEach(() => {
    render(
      <>
        <main tabIndex={-1}>
          <button type="button">Before</button>
        </main>
        <ToastHost />
      </>,
    );
  });
  afterEach(() => {
    act(() => dismissToast());
    cleanup();
  });

  const enterToast = () => {
    act(() => showToast({ message: 'Deleted', action: { label: 'Undo', run: () => {} } }));
    act(() => screen.getByRole('button', { name: 'Before' }).focus());
    act(() => screen.getByRole('button', { name: 'Undo' }).focus());
  };

  it('returns focus to where it came from when the action closes the toast', () => {
    enterToast();
    act(() => screen.getByRole('button', { name: 'Undo' }).click());
    expect(toast()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Before' }));
  });

  it('returns focus to where it came from when the toast is replaced', () => {
    enterToast();
    act(() => showToast({ message: 'Next' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Before' }));
  });

  it('falls back to <main> when that element is gone', () => {
    enterToast();
    screen.getByRole('button', { name: 'Before' }).remove();
    act(() => dismissToast());
    expect(document.activeElement).toBe(document.querySelector('main'));
  });

  it('leaves focus alone when it is outside the toast', () => {
    act(() => showToast({ message: 'Saved' }));
    act(() => screen.getByRole('button', { name: 'Before' }).focus());
    act(() => dismissToast());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Before' }));
  });
});

describe('toast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    render(
      <>
        <ToastHost />
        <Announcer />
      </>,
    );
  });
  afterEach(() => {
    act(() => dismissToast());
    cleanup();
    vi.useRealTimers();
  });

  it('shows the message, announces it politely and is gone after 4 s', () => {
    act(() => showToast({ message: 'Tab copied' }));
    expect(toast()?.textContent).toBe('Tab copied');
    expect(toast()?.hasAttribute('aria-live')).toBe(false);
    act(() => vi.advanceTimersToNextFrame());
    expect(polite()?.textContent).toBe('Tab copied');
    advance(TOAST_MS - 100);
    expect(toast()).not.toBeNull();
    advance(100);
    expect(toast()).toBeNull();
  });

  it('runs the action and dismisses on click', () => {
    const run = vi.fn();
    act(() => showToast({ message: 'Deleted', action: { label: 'Undo', run } }));
    const button = screen.getByRole('button', { name: 'Undo' });
    act(() => button.click());
    expect(run).toHaveBeenCalledOnce();
    expect(toast()).toBeNull();
  });

  it('pauses while hovered and dismisses after the remaining time', () => {
    act(() => showToast({ message: 'Saved' }));
    advance(1000);
    fireEvent.mouseEnter(toast()!);
    advance(10_000);
    expect(toast()).not.toBeNull();
    fireEvent.mouseLeave(toast()!);
    advance(TOAST_MS - 1000 - 50);
    expect(toast()).not.toBeNull();
    advance(50);
    expect(toast()).toBeNull();
  });

  it('pauses while focus is inside and resumes when it leaves', () => {
    act(() => showToast({ message: 'Deleted', action: { label: 'Undo', run: () => {} } }));
    advance(3000);
    const button = screen.getByRole('button', { name: 'Undo' });
    act(() => button.focus());
    advance(10_000);
    expect(toast()).not.toBeNull();
    act(() => button.blur());
    advance(TOAST_MS - 3000 - 50);
    expect(toast()).not.toBeNull();
    advance(50);
    expect(toast()).toBeNull();
  });

  it('stays paused while hovered even after focus leaves', () => {
    act(() => showToast({ message: 'Deleted', action: { label: 'Undo', run: () => {} } }));
    const button = screen.getByRole('button', { name: 'Undo' });
    fireEvent.mouseEnter(toast()!);
    act(() => button.focus());
    act(() => button.blur());
    advance(10_000);
    expect(toast()).not.toBeNull();
  });

  it('replaces the current toast and restarts the timer', () => {
    act(() => showToast({ message: 'First' }));
    advance(3000);
    act(() => showToast({ message: 'Second' }));
    expect(screen.getAllByTestId('toast')).toHaveLength(1);
    expect(toast()?.textContent).toBe('Second');
    act(() => vi.advanceTimersToNextFrame());
    expect(polite()?.textContent).toBe('Second');
    advance(TOAST_MS - 100);
    expect(toast()?.textContent).toBe('Second');
    advance(100);
    expect(toast()).toBeNull();
  });

  // Story "Update available prompt": the update toast stays until its action or a replacement.
  it('a persistent toast has no timer, and still announces', () => {
    act(() => showToast({ message: 'Update available', persistent: true }));
    act(() => vi.advanceTimersToNextFrame());
    expect(polite()?.textContent).toBe('Update available');
    advance(TOAST_MS * 10);
    expect(toast()?.textContent).toBe('Update available');
    act(() => showToast({ message: 'Tab copied' }));
    advance(TOAST_MS);
    expect(toast()).toBeNull();
  });

  it('a persistent toast has a close button: it removes the toast and runs its close', () => {
    const run = vi.fn();
    act(() =>
      showToast({
        message: 'Update available',
        persistent: true,
        close: { label: 'Close it', run },
      }),
    );
    act(() => screen.getByRole('button', { name: 'Close it' }).click());
    expect(toast()).toBeNull();
    expect(run).toHaveBeenCalledOnce();
  });

  it('a plain toast has no close button; a silent toast is not announced', () => {
    act(() => showToast({ message: 'Quiet', silent: true }));
    expect(screen.queryByRole('button')).toBeNull();
    act(() => vi.advanceTimersToNextFrame());
    expect(polite()?.textContent ?? '').not.toBe('Quiet');
  });

  it('replaces a toast with an identical one and still restarts the timer', () => {
    act(() => showToast({ message: 'Saved' }));
    advance(3000);
    act(() => showToast({ message: 'Saved' }));
    advance(TOAST_MS - 100);
    expect(toast()).not.toBeNull();
    advance(100);
    expect(toast()).toBeNull();
  });
});
