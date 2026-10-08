import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANNOUNCE_EXPIRY_MS,
  ANNOUNCE_GAP_MS,
  ANNOUNCE_QUEUE_MAX,
  ASSERTIVE_HOLD_MS,
  ASSERTIVE_REPEAT_MS,
  announce,
  Announcer,
} from '../../src/ui/a11y/announcer';

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
      // An assertive repeat is dropped within its window: wait it out.
      act(() =>
        vi.advanceTimersByTime(politeness === 'assertive' ? ASSERTIVE_REPEAT_MS : ANNOUNCE_GAP_MS),
      );
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

  // Story "Announcements and the Tab toolbar" (retro DS10): the queue's cap and expiry, the
  // hidden-tab path, and minor assertive messages.
  describe('queue cap, expiry, hidden tab and minor assertive messages', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('caps the polite queue: of 8 in one burst only the last 5 are spoken, in order', () => {
      expect(ANNOUNCE_QUEUE_MAX).toBe(5);
      act(() => {
        for (let i = 1; i <= 8; i++) announce(`M${i}`);
      });
      const seen = texts(polite, ANNOUNCE_GAP_MS * 20).filter((t) => t !== '');
      expect(seen).toEqual(['M4', 'M5', 'M6', 'M7', 'M8']);
    });

    it('drops a queued message older than the expiry when its turn comes', () => {
      expect(ANNOUNCE_EXPIRY_MS).toBe(10_000);
      // As on a page whose timers are throttled: the first message is shown, and the clock
      // passes the expiry before its gap ends, so the second has waited too long.
      act(() => {
        announce('First');
        announce('Stale');
      });
      act(() => vi.advanceTimersToNextFrame());
      expect(polite()?.textContent).toBe('First');
      // The monotonic clock jumps past the expiry while the gap timer is held back.
      const now = performance.now();
      vi.spyOn(performance, 'now').mockReturnValue(now + ANNOUNCE_EXPIRY_MS + 1);
      act(() => announce('Fresh'));
      const seen = texts(polite, ANNOUNCE_GAP_MS * 6).filter((t) => t !== '');
      expect(seen).toEqual(['Fresh']);
    });

    it('drains both regions through a timer while the page is hidden, without frames', () => {
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      const raf = vi.spyOn(window, 'requestAnimationFrame');
      act(() => {
        announce('One');
        announce('Two');
        announce('Alert', 'assertive');
      });
      act(() => vi.advanceTimersByTime(1));
      expect(polite()?.textContent).toBe('One');
      expect(assertive()?.textContent).toBe('Alert');
      act(() => vi.advanceTimersByTime(ANNOUNCE_GAP_MS + 1));
      expect(polite()?.textContent).toBe('Two');
      expect(raf).not.toHaveBeenCalled();
    });

    it('a minor message within the hold after an error is dropped; the error stays', () => {
      expect(ASSERTIVE_HOLD_MS).toBe(6_000);
      say('Mic lost', 'assertive');
      act(() => announce('3', 'assertive', { minor: true }));
      act(() => vi.advanceTimersByTime(ASSERTIVE_HOLD_MS - 100));
      act(() => announce('2', 'assertive', { minor: true }));
      act(() => vi.advanceTimersToNextFrame());
      expect(assertive()?.textContent).toBe('Mic lost');
      // After the hold, beats are spoken again.
      act(() => vi.advanceTimersByTime(200));
      act(() => announce('1', 'assertive', { minor: true }));
      act(() => vi.advanceTimersToNextFrame());
      expect(assertive()?.textContent).toBe('1');
    });

    it('a minor message never replaces a pending error', () => {
      act(() => {
        announce('Mic lost', 'assertive');
        announce('3', 'assertive', { minor: true });
      });
      act(() => vi.advanceTimersToNextFrame());
      expect(assertive()?.textContent).toBe('Mic lost');
    });

    it('an error replaces a minor message, pending or shown', () => {
      act(() => {
        announce('4', 'assertive', { minor: true });
        announce('Mic lost', 'assertive');
      });
      act(() => vi.advanceTimersToNextFrame());
      expect(assertive()?.textContent).toBe('Mic lost');
      act(() => vi.advanceTimersByTime(ASSERTIVE_HOLD_MS * 2));
      act(() => announce('3', 'assertive', { minor: true }));
      act(() => vi.advanceTimersToNextFrame());
      expect(assertive()?.textContent).toBe('3');
      say('Storage is full', 'assertive');
      expect(assertive()?.textContent).toBe('Storage is full');
    });

    it('a page hidden with frames scheduled moves both regions to the timer path', () => {
      const raf = vi.spyOn(window, 'requestAnimationFrame');
      act(() => {
        announce('Queued');
        announce('Alert', 'assertive');
      });
      expect(raf).toHaveBeenCalledTimes(2);
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      // Timers only: the frames never run while hidden.
      vi.spyOn(window, 'cancelAnimationFrame');
      act(() => vi.advanceTimersByTime(1));
      expect(polite()?.textContent).toBe('Queued');
      expect(assertive()?.textContent).toBe('Alert');
      expect(raf).toHaveBeenCalledTimes(2);
    });

    it('drops an assertive text equal to the pending one or one shown within the repeat window', () => {
      expect(ASSERTIVE_REPEAT_MS).toBe(1_000);
      act(() => {
        announce('Storage is full', 'assertive');
        announce('Storage is full', 'assertive');
      });
      // One fill: cleared once, then set once.
      expect(texts(assertive, 50)).toEqual(['Storage is full']);
      // An accepted message clears the region at once; a dropped one leaves it as it is.
      act(() => announce('Storage is full', 'assertive'));
      expect(assertive()?.textContent).toBe('Storage is full');
      act(() => vi.advanceTimersByTime(ASSERTIVE_REPEAT_MS - 100));
      // Minor or not, the same text is not repeated inside the window.
      act(() => announce('Storage is full', 'assertive', { minor: true }));
      act(() => announce('Storage is full', 'assertive'));
      expect(assertive()?.textContent).toBe('Storage is full');
      expect(texts(assertive, 50)).toEqual([]);
      // After the window it is spoken again (a retry meeting the same failure).
      act(() => vi.advanceTimersByTime(100));
      act(() => announce('Storage is full', 'assertive'));
      expect(assertive()?.textContent).toBe('');
      expect(texts(assertive, 50)).toEqual(['Storage is full']);
    });

    it('a repeat marked as a new event is announced again at once', () => {
      say('Microphone access is blocked', 'assertive');
      act(() => announce('Microphone access is blocked', 'assertive', { repeat: true }));
      expect(assertive()?.textContent).toBe('');
      act(() => vi.advanceTimersToNextFrame());
      expect(assertive()?.textContent).toBe('Microphone access is blocked');
    });

    it('minor messages replace one another', () => {
      act(() => {
        announce('3', 'assertive', { minor: true });
        announce('2', 'assertive', { minor: true });
      });
      act(() => vi.advanceTimersToNextFrame());
      expect(assertive()?.textContent).toBe('2');
    });
  });
});
