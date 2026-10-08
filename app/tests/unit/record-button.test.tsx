import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordingSession } from '../../src/session/recording-session';
import type { RecordingSnapshot } from '../../src/session/recording-types';
import * as announcer from '../../src/ui/a11y/announcer';
import { RecordButton } from '../../src/ui/components/RecordButton';
import { strings } from '../../src/ui/strings';

// Story "Announcements and the Tab toolbar": the count-in's beats are announced assertively as
// minor messages, so a beat never overwrites an error announced just before it.

const COUNTING: RecordingSnapshot = {
  mic: 'live',
  levelWarning: null,
  devices: [],
  activeDeviceId: null,
  inputQualityPoor: false,
  inputQualityDismissed: false,
  tunedStrings: [],
  recording: 'count-in',
  activeTakeId: null,
  countIn: { on: true, bpm: 120 },
  nearLimit: false,
  savedSeq: 0,
  storageFull: false,
  recovered: [],
  handoverTake: null,
};

describe('RecordButton count-in beats', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(recordingSession, 'getSnapshot').mockImplementation(() => COUNTING);
    vi.spyOn(recordingSession, 'subscribe').mockImplementation(() => () => {});
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('announces each beat assertively with { minor: true }', () => {
    const announce = vi.spyOn(announcer, 'announce').mockImplementation(() => {});
    let beat: number | null = 4;
    vi.spyOn(recordingSession, 'readCountInBeat').mockImplementation(() => beat);
    render(<RecordButton />);
    for (const next of [3, 2, 1]) {
      beat = next;
      act(() => vi.advanceTimersToNextFrame());
    }
    expect(announce.mock.calls).toEqual(
      [4, 3, 2, 1].map((b) => [strings['record.countInBeat'](b), 'assertive', { minor: true }]),
    );
  });
});
