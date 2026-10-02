import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StringNo } from '../../src/model/types';
import { recordingSession, type RecordingSnapshot } from '../../src/session/recording-session';
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
