import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  recordingSession,
  type RecordingSnapshot,
  type RecoveredTake,
} from '../../src/session/recording-session';
import { formatClockTime, formatElapsed } from '../../src/ui/format';
import { RecoveredTakeBanners } from '../../src/ui/components/RecoveredTakeBanner';

const announce = vi.hoisted(() => vi.fn());
vi.mock('../../src/ui/a11y/announcer', () => ({ announce }));

// Story 3.11: the recovered-take banners on Record, with the store stubbed.

const BASE: RecordingSnapshot = {
  mic: 'setup',
  levelWarning: null,
  devices: [],
  activeDeviceId: null,
  inputQualityPoor: false,
  inputQualityDismissed: false,
  tunedStrings: [],
  recording: 'idle',
  activeTakeId: null,
  countIn: { on: false, bpm: 100 },
  nearLimit: false,
  savedSeq: 0,
  storageFull: false,
  recovered: [],
};

/** 21:14 local time. */
const EVENING = new Date(2026, 9, 2, 21, 14, 5).toISOString();

let snapshot: RecordingSnapshot = BASE;
const listeners = new Set<() => void>();
function publish(recovered: readonly RecoveredTake[]) {
  snapshot = { ...snapshot, recovered };
  for (const l of listeners) l();
}

function renderScreen() {
  return render(
    <section>
      <RecoveredTakeBanners />
      <h1 tabIndex={-1}>Record</h1>
    </section>,
  );
}

beforeEach(() => {
  snapshot = BASE;
  vi.spyOn(recordingSession, 'getSnapshot').mockImplementation(() => snapshot);
  vi.spyOn(recordingSession, 'subscribe').mockImplementation((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  });
});

afterEach(() => {
  cleanup();
  listeners.clear();
  announce.mockClear();
  vi.restoreAllMocks();
});

describe('format', () => {
  it('formats clock times as a lowercase 12-hour clock', () => {
    expect(formatClockTime(new Date(2026, 0, 1, 21, 14))).toBe('9:14 pm');
    expect(formatClockTime(new Date(2026, 0, 1, 0, 5))).toBe('12:05 am');
    expect(formatClockTime(new Date(2026, 0, 1, 12, 0))).toBe('12:00 pm');
    expect(formatClockTime(new Date(2026, 0, 1, 9, 30))).toBe('9:30 am');
  });

  it('formats durations as m:ss, rounded down', () => {
    expect(formatElapsed(9_999)).toBe('0:09');
    expect(formatElapsed(182_400)).toBe('3:02');
  });
});

describe('RecoveredTakeBanners', () => {
  it('shows one banner per take, oldest first, with Open then Discard', () => {
    snapshot = {
      ...BASE,
      recovered: [
        { id: 'a', createdAt: EVENING, durationMs: 182_400, opening: false },
        { id: 'b', createdAt: EVENING, durationMs: 9_600, opening: false },
      ],
    };
    renderScreen();
    const banners = screen.getAllByTestId('recovered-take-banner');
    expect(banners.map((b) => b.querySelector('p')!.textContent)).toEqual([
      'An unfinished take from 9:14 pm was recovered (3:02)',
      'An unfinished take from 9:14 pm was recovered (0:09)',
    ]);
    expect([...banners[0]!.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Open',
      'Discard',
    ]);
    expect(banners[0]!.getAttribute('role')).toBeNull();
    expect(banners[0]!.getAttribute('aria-live')).toBeNull();
  });

  it('announces each banner once, politely, through the announcer', () => {
    snapshot = {
      ...BASE,
      recovered: [{ id: 'once', createdAt: EVENING, durationMs: 3_000, opening: false }],
    };
    const first = renderScreen();
    first.unmount();
    renderScreen();
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('An unfinished take from 9:14 pm was recovered (0:03)');
  });

  it('Open: calls the store; while opening it reads "Recovering…" with both buttons aria-disabled', () => {
    const open = vi.spyOn(recordingSession, 'openRecovered').mockResolvedValue();
    const discard = vi.spyOn(recordingSession, 'discardRecovered').mockResolvedValue();
    snapshot = {
      ...BASE,
      recovered: [{ id: 'a', createdAt: EVENING, durationMs: 3_000, opening: false }],
    };
    renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(open).toHaveBeenCalledWith('a');
    act(() => publish([{ id: 'a', createdAt: EVENING, durationMs: 3_000, opening: true }]));
    expect(screen.getByTestId('recovered-take-banner').querySelector('p')!.textContent).toBe(
      'Recovering…',
    );
    for (const name of ['Open', 'Discard']) {
      const button = screen.getByRole('button', { name });
      expect(button.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(button);
    }
    expect(open).toHaveBeenCalledTimes(1);
    expect(discard).not.toHaveBeenCalled();
  });

  it('Discard: deletes through the store, then focus is on the h1 before the banner goes', async () => {
    let focusedBeforeDrop: Element | null = null;
    vi.spyOn(recordingSession, 'discardRecovered').mockImplementation(async (_id, deleted) => {
      deleted?.();
      focusedBeforeDrop = document.activeElement;
      publish([]);
    });
    snapshot = {
      ...BASE,
      recovered: [{ id: 'a', createdAt: EVENING, durationMs: 3_000, opening: false }],
    };
    renderScreen();
    const discard = screen.getByRole('button', { name: 'Discard' });
    discard.focus();
    await act(async () => {
      fireEvent.click(discard);
    });
    const h1 = screen.getByRole('heading', { name: 'Record' });
    expect(focusedBeforeDrop).toBe(h1);
    expect(document.activeElement).toBe(h1);
    expect(screen.queryByTestId('recovered-take-banner')).toBeNull();
  });
});
