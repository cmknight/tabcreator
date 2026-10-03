import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANNOUNCE_GAP_MS, announce, Announcer } from '../../src/ui/a11y/announcer';

const polite = () => document.querySelector('[aria-live="polite"]');
const assertive = () => document.querySelector('[aria-live="assertive"]');

/** Announces and lets the next animation frame run. */
function say(message: string, politeness?: 'polite' | 'assertive') {
  act(() => announce(message, politeness));
  act(() => vi.advanceTimersToNextFrame());
}

/**
 * Runs the clock forward `ms` in 1 ms steps and returns every change of `region`'s text, in
 * order (including clears to '').
 */
function texts(region: () => Element | null, ms: number): string[] {
  const seen: string[] = [];
  let last = region()?.textContent ?? '';
  for (let i = 0; i < ms; i++) {
    act(() => vi.advanceTimersByTime(1));
    const now = region()?.textContent ?? '';
    if (now !== last) seen.push(now);
    last = now;
  }
  return seen;
}

describe('announcer (spine AD-18)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    render(createElement(Announcer));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders one polite status and one assertive alert region', () => {
    expect(document.querySelectorAll('[aria-live]')).toHaveLength(2);
    expect(polite()?.getAttribute('role')).toBe('status');
    expect(assertive()?.getAttribute('role')).toBe('alert');
  });

  it('puts a polite message in the polite region', () => {
    say('Saved');
    expect(polite()?.textContent).toBe('Saved');
    expect(assertive()?.textContent).toBe('');
  });

  it('puts an assertive message in the assertive region', () => {
    say('Mic lost', 'assertive');
    expect(assertive()?.textContent).toBe('Mic lost');
    expect(polite()?.textContent).toBe('');
  });

  it('re-sets the region for a repeat, so it is announced again', () => {
    say('Saved');
    act(() => vi.advanceTimersByTime(ANNOUNCE_GAP_MS));
    const observer = new MutationObserver(() => {});
    observer.observe(polite()!, { childList: true, characterData: true, subtree: true });
    act(() => announce('Saved'));
    expect(polite()?.textContent).toBe('');
    act(() => vi.advanceTimersToNextFrame());
    expect(polite()?.textContent).toBe('Saved');
    // The region's DOM changed (cleared, then refilled), which is what screen readers watch.
    expect(observer.takeRecords().length).toBeGreaterThan(0);
    observer.disconnect();
  });

  it('speaks two polite messages in one frame in order, the second after the gap', () => {
    act(() => {
      announce('First');
      announce('Second');
    });
    act(() => vi.advanceTimersToNextFrame());
    expect(polite()?.textContent).toBe('First');
    // Held for the gap: still First just before it ends.
    act(() => vi.advanceTimersByTime(ANNOUNCE_GAP_MS - 1));
    expect(polite()?.textContent).toBe('First');
    act(() => vi.advanceTimersByTime(1));
    // Cleared, then set on the next frame.
    expect(polite()?.textContent).toBe('');
    act(() => vi.advanceTimersToNextFrame());
    expect(polite()?.textContent).toBe('Second');
  });

  it.each([
    ['polite', polite],
    ['assertive', assertive],
  ] as const)(
    'commits the clear before the refill when both land in one render (%s)',
    (politeness, region) => {
      say('Saved', politeness);
      act(() => vi.advanceTimersByTime(ANNOUNCE_GAP_MS));
      const observer = new MutationObserver(() => {});
      observer.observe(region()!, { childList: true, characterData: true, subtree: true });
      // The clear and the next frame's set in one act scope: batched, they would leave the DOM
      // untouched and the repeat unspoken.
      act(() => {
        announce('Saved', politeness);
        vi.advanceTimersToNextFrame();
      });
      expect(observer.takeRecords().length).toBeGreaterThan(0);
      expect(region()?.textContent).toBe('Saved');
      observer.disconnect();
    },
  );

  it('announces a repeat far apart twice, clearing then setting each time', () => {
    act(() => announce('Saved'));
    const first = texts(polite, ANNOUNCE_GAP_MS * 4);
    expect(first).toEqual(['Saved']);
    act(() => announce('Saved'));
    // Cleared at once, then set again on the next frame.
    expect(polite()?.textContent).toBe('');
    expect(texts(polite, ANNOUNCE_GAP_MS * 4)).toEqual(['Saved']);
  });

  it('speaks a burst of three in order, then keeps the last text', () => {
    act(() => {
      announce('One');
      announce('Two');
      announce('Three');
    });
    const seen = texts(polite, ANNOUNCE_GAP_MS * 8);
    expect(seen).toEqual(['One', '', 'Two', '', 'Three']);
    expect(polite()?.textContent).toBe('Three');
  });

  it('keeps only the last of two assertive messages in one frame', () => {
    act(() => {
      announce('First', 'assertive');
      announce('Second', 'assertive');
    });
    expect(texts(assertive, ANNOUNCE_GAP_MS * 4)).toEqual(['Second']);
    expect(polite()?.textContent).toBe('');
  });

  it('cancels pending frames and timers on unmount mid-queue', () => {
    const errors = vi.spyOn(console, 'error');
    act(() => {
      announce('One');
      announce('Two');
      announce('Late', 'assertive');
    });
    act(() => vi.advanceTimersToNextFrame());
    act(() => announce('Three'));
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(ANNOUNCE_GAP_MS * 10);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('stops listening after unmount', () => {
    cleanup();
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    announce('Nobody hears');
    expect(raf).not.toHaveBeenCalled();
    // A remounted Announcer is the only listener: one frame scheduled per message.
    render(createElement(Announcer));
    act(() => announce('Heard once'));
    expect(raf).toHaveBeenCalledOnce();
    raf.mockRestore();
  });
});
