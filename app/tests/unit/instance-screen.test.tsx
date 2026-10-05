import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { instanceLock } from '../../src/session/instance-lock';
import { recordingSession } from '../../src/session/recording-session';
import type { HandoverTake, RecordingSnapshot } from '../../src/session/recording-types';
import { InstanceScreen } from '../../src/ui/components/InstanceScreen';
import { strings } from '../../src/ui/strings';

// Story 3.10: the full-screen instance notices.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('instance screen', () => {
  it('other tab: the heading takes focus; Use here calls useHere; the status line is empty', () => {
    const useHere = vi.spyOn(instanceLock, 'useHere').mockImplementation(() => {});
    render(<InstanceScreen state="other-tab" />);
    const heading = screen.getByRole('heading', { name: 'TabCreator is open in another tab' });
    expect(document.activeElement).toBe(heading);
    expect(screen.getByRole('status').textContent).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Use here' }));
    expect(useHere).toHaveBeenCalledTimes(1);
  });

  it('handing over: Use here aria-disabled and inert, with "Moving TabCreator here…"', () => {
    const useHere = vi.spyOn(instanceLock, 'useHere').mockImplementation(() => {});
    render(<InstanceScreen state="handing-over" />);
    const button = screen.getByRole('button', { name: 'Use here' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('Moving TabCreator here…');
    fireEvent.click(button);
    expect(useHere).not.toHaveBeenCalled();
  });

  it('upgrade blocked and unsupported: their notice only, with no Use here', () => {
    render(<InstanceScreen state="upgrade-blocked" />);
    expect(
      screen.getByRole('heading', { name: 'Close other TabCreator tabs to finish updating' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    render(<InstanceScreen state="unsupported" />);
    expect(
      screen.getByRole('heading', { name: 'TabCreator needs a recent desktop Chrome' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  describe("the lost tab's take line (story 5.3)", () => {
    /** Fakes the recording store's `handoverTake`; returns a setter that notifies. */
    function fakeHandoverTake(initial: HandoverTake) {
      let value = initial;
      let listeners: Array<() => void> = [];
      const real = recordingSession.getSnapshot();
      vi.spyOn(recordingSession, 'getSnapshot').mockImplementation((): RecordingSnapshot => ({
        ...real,
        handoverTake: value,
      }));
      vi.spyOn(recordingSession, 'subscribe').mockImplementation((listener) => {
        listeners.push(listener);
        return () => {
          listeners = listeners.filter((l) => l !== listener);
        };
      });
      return (next: HandoverTake) => {
        value = next;
        act(() => listeners.forEach((l) => l()));
      };
    }

    it('saved: "Your recording was saved — it\'s in the Library in the other tab"', () => {
      fakeHandoverTake('saved');
      render(<InstanceScreen state="lost" />);
      expect(screen.getByText(strings['global.instanceTakeSaved'])).toBeTruthy();
      expect(
        screen.getByText("Your recording was saved — it's in the Library in the other tab"),
      ).toBeTruthy();
    });

    it('failed: "wasn\'t saved here", arriving when the late save settles', () => {
      const set = fakeHandoverTake(null);
      render(<InstanceScreen state="lost" />);
      expect(screen.queryByText(strings['global.instanceTakeNotSaved'])).toBeNull();
      set('failed');
      expect(
        screen.getByText(
          "Your recording wasn't saved here — the other tab will offer to recover it",
        ),
      ).toBeTruthy();
      // Announced: the line sits in a status region of its own.
      expect(screen.getByText(strings['global.instanceTakeNotSaved']).getAttribute('role')).toBe(
        'status',
      );
    });

    it('no take, or not lost: no line', () => {
      fakeHandoverTake(null);
      render(<InstanceScreen state="lost" />);
      expect(screen.queryByText(strings['global.instanceTakeSaved'])).toBeNull();
      cleanup();
      fakeHandoverTake('saved');
      render(<InstanceScreen state="other-tab" />);
      expect(screen.queryByText(strings['global.instanceTakeSaved'])).toBeNull();
    });
  });
});
