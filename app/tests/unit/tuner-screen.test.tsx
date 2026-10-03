import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StringNo } from '../../src/model/types';
import {
  recordingSession,
  TUNER_POLL_MS,
  type RecordingSnapshot,
} from '../../src/session/recording-session';
import { Tuner } from '../../src/ui/screens/Tuner';

// The Tuner's rendering of one reading (plan I/O matrix: off by 12, flat, beyond range), with
// the store stubbed live and `readTuner` returning a fixed reading.

const LIVE: RecordingSnapshot = {
  mic: 'live',
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
};

function renderReading(string: StringNo, cents: number, held = false) {
  vi.spyOn(recordingSession, 'readTuner').mockReturnValue({
    reading: { string, cents },
    held,
    inTune: false,
  });
  render(<Tuner />);
}

const readout = () => screen.getByTestId('tuner-readout');
/** The needle's left offset, in % of the track. */
const needleLeft = () => parseFloat(screen.getByTestId('tuner-needle-mark').style.left);

describe('Tuner reading display', () => {
  beforeEach(() => {
    vi.spyOn(recordingSession, 'getSnapshot').mockReturnValue(LIVE);
    vi.spyOn(recordingSession, 'resume').mockResolvedValue();
    vi.spyOn(recordingSession, 'readLevels').mockReturnValue({
      peakDb: -Infinity,
      rmsDb: -Infinity,
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('off by 12 cents: "+12 cents", sharp, needle right of centre at 62 %', () => {
    renderReading(5, 12);
    expect(screen.getByText('A', { selector: 'p' })).toBeTruthy();
    expect(readout().textContent).toBe('+12 cents♯ Sharp — tune down');
    expect(needleLeft()).toBeCloseTo(62, 6);
    expect(screen.getByRole('img', { name: /^Tuning needle/ }).getAttribute('aria-label')).toBe(
      'Tuning needle, −50 to +50 cents: +12 cents',
    );
  });

  it('flat: "−7 cents" with U+2212 and "♭ Flat — tune up"', () => {
    renderReading(4, -7);
    expect(readout().textContent).toBe('−7 cents♭ Flat — tune up');
    expect(screen.queryByText('♯ Sharp — tune down')).toBeNull();
    expect(needleLeft()).toBeCloseTo(43, 6);
  });

  it('beyond range: +80 cents clamps the needle to the +50 end; the readout says "+80 cents"', () => {
    renderReading(3, 80);
    expect(readout().textContent).toBe('+80 cents♯ Sharp — tune down');
    expect(needleLeft()).toBe(100);
  });

  it('a held reading shows the string, cents and needle, but no direction and no In tune', () => {
    renderReading(5, 12, true);
    expect(screen.getByText('A', { selector: 'p' })).toBeTruthy();
    expect(readout().textContent).toBe('+12 cents');
    expect(needleLeft()).toBeCloseTo(62, 6);
    expect(screen.queryByTestId('tuner-in-tune')).toBeNull();
    // Drawn muted: string name, cents and needle carry the held class.
    for (const id of ['tuner-string', 'tuner-cents', 'tuner-needle-mark']) {
      expect(screen.getByTestId(id).className, id).toMatch(/held/);
    }
  });

  it('a live reading is not drawn muted', () => {
    renderReading(5, 12);
    for (const id of ['tuner-string', 'tuner-cents', 'tuner-needle-mark']) {
      expect(screen.getByTestId(id).className, id).not.toMatch(/held/);
    }
  });
});

describe('Tuner display dedupe (sameDisplay)', () => {
  let cents: number;

  beforeEach(() => {
    vi.useFakeTimers();
    cents = 0;
    vi.spyOn(recordingSession, 'getSnapshot').mockReturnValue(LIVE);
    vi.spyOn(recordingSession, 'resume').mockResolvedValue();
    vi.spyOn(recordingSession, 'readLevels').mockReturnValue({
      peakDb: -Infinity,
      rmsDb: -Infinity,
    });
    vi.spyOn(recordingSession, 'readTuner').mockImplementation(() => ({
      reading: { string: 5, cents },
      held: false,
      inTune: false,
    }));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const centsText = () => screen.getByTestId('tuner-cents').textContent;

  /** Renders at `from` cents, checks what shows, then lets one poll read `to`. */
  function step(from: number, to: number) {
    cents = from;
    render(<Tuner />);
    expect(centsText()).toBe('+2 cents');
    expect(needleLeft()).toBeCloseTo(50 + from, 6);
    cents = to;
    act(() => vi.advanceTimersByTime(TUNER_POLL_MS));
  }

  it('2.46 → 2.54 (same needle tenth, different whole cents): readout and needle update', () => {
    step(2.46, 2.54);
    expect(centsText()).toBe('+3 cents');
    expect(needleLeft()).toBeCloseTo(52.54, 6);
  });

  it('2.40 → 2.60: readout and needle update', () => {
    step(2.4, 2.6);
    expect(centsText()).toBe('+3 cents');
    expect(needleLeft()).toBeCloseTo(52.6, 6);
  });

  it('2.1 → 2.3 (same whole cents, different needle tenth): the needle updates', () => {
    step(2.1, 2.3);
    expect(centsText()).toBe('+2 cents');
    expect(needleLeft()).toBeCloseTo(52.3, 6);
  });

  it('2.41 → 2.44 (nothing visible changes): the shown display is kept', () => {
    step(2.41, 2.44);
    expect(centsText()).toBe('+2 cents');
    expect(needleLeft()).toBeCloseTo(52.41, 6);
  });
});
