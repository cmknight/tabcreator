import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { announce, Announcer } from '../../src/ui/a11y/announcer';

const polite = () => document.querySelector('[aria-live="polite"]');
const assertive = () => document.querySelector('[aria-live="assertive"]');

/** Announces and lets the next animation frame run. */
function say(message: string, politeness?: 'polite' | 'assertive') {
  act(() => announce(message, politeness));
  act(() => vi.advanceTimersToNextFrame());
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

  it('keeps the last of two messages in one frame', () => {
    act(() => {
      announce('First');
      announce('Second');
    });
    act(() => vi.advanceTimersToNextFrame());
    expect(polite()?.textContent).toBe('Second');
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
