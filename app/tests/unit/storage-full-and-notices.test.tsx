import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordingSession, type RecordingSnapshot } from '../../src/session/recording-session';
import * as announcer from '../../src/ui/a11y/announcer';
import { MicNotices } from '../../src/ui/components/MicNotices';
import { StorageFullBanner } from '../../src/ui/components/StorageFullBanner';
import { ToastHost } from '../../src/ui/components/ToastHost';
import { strings } from '../../src/ui/strings';
import { dismissToast } from '../../src/ui/toast';

// Story 5.2 (DS3): the storage-full banner says "saved" only when the take was saved, and a
// failed save shows the save-failed toast.

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
  recovered: [],
  handoverTake: null,
};

describe('failed-save copy', () => {
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

  it('the banner with nothing saved shows and announces the unsaved copy', () => {
    const announce = vi.spyOn(announcer, 'announce').mockImplementation(() => {});
    snapshot = { ...LIVE, storageFull: true, storageFullSaved: false };
    render(<StorageFullBanner />);
    expect(screen.getByTestId('storage-full-banner').textContent).toContain(
      strings['record.storageFullUnsaved'],
    );
    expect(announce).toHaveBeenCalledWith(strings['record.storageFullUnsaved'], 'assertive');
  });

  it('the banner after a saved take shows the saved copy', () => {
    vi.spyOn(announcer, 'announce').mockImplementation(() => {});
    snapshot = { ...LIVE, storageFull: true, storageFullSaved: true };
    render(<StorageFullBanner />);
    expect(screen.getByTestId('storage-full-banner').textContent).toContain(
      strings['record.storageFull'],
    );
  });

  it('MicNotices shows the save-failed toast', () => {
    render(
      <>
        <MicNotices />
        <ToastHost />
      </>,
    );
    act(() => {
      snapshot = { ...LIVE, notice: { kind: 'save-failed', seq: 1 } };
      for (const l of listeners) l();
    });
    expect(screen.getByText(strings['record.saveFailed'])).toBeTruthy();
  });
});
