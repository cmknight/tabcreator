import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordingSession } from '../../src/session/recording-session';
import type { RecordingSnapshot } from '../../src/session/recording-types';
import { MicNotices } from '../../src/ui/components/MicNotices';
import { MicSelect } from '../../src/ui/components/MicSelect';
import { ToastHost } from '../../src/ui/components/ToastHost';
import { dismissToast } from '../../src/ui/toast';

// An input the browser gives no label is named "Microphone N" (its 1-based place in the list),
// both in the Microphone select and in the switched-input toast.

const DEVICES = [
  { deviceId: 'mic-a', label: 'USB Interface', groupId: 'g-a' },
  { deviceId: 'mic-b', label: '', groupId: 'g-b' },
] as const;

const LIVE: RecordingSnapshot = {
  mic: 'live',
  levelWarning: null,
  devices: DEVICES,
  activeDeviceId: 'mic-a',
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
  handoverTake: null,
};

describe('unnamed microphone label', () => {
  let snapshot: RecordingSnapshot;
  let listeners: Array<() => void>;

  beforeEach(() => {
    snapshot = LIVE;
    listeners = [];
    vi.spyOn(recordingSession, 'getSnapshot').mockImplementation(() => snapshot);
    vi.spyOn(recordingSession, 'subscribe').mockImplementation((listener) => {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((l) => l !== listener);
      };
    });
  });
  afterEach(() => {
    act(() => dismissToast());
    cleanup();
    vi.restoreAllMocks();
  });

  it('MicSelect names an empty-label input "Microphone 2"', () => {
    render(<MicSelect />);
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['USB Interface', 'Microphone 2']);
  });

  it('the switched-input toast names an empty-label input as the select does', () => {
    render(
      <>
        <MicNotices />
        <ToastHost />
      </>,
    );
    act(() => {
      snapshot = {
        ...LIVE,
        activeDeviceId: 'mic-b',
        notice: { kind: 'switched', label: '', seq: 1 },
      };
      for (const listener of [...listeners]) listener();
    });
    expect(screen.getByTestId('toast').textContent).toContain(
      'Microphone disconnected — switched to Microphone 2',
    );
  });
});
