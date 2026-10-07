import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordingSession } from '../../src/session/recording-session';
import type { RecordingSnapshot } from '../../src/session/recording-types';
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

  it('the banner with nothing saved shows and announces the shared storage-full copy', () => {
    const announce = vi.spyOn(announcer, 'announce').mockImplementation(() => {});
    snapshot = { ...LIVE, storageFull: true, storageFullSaved: false };
    render(<StorageFullBanner />);
    expect(screen.getByTestId('storage-full-banner').textContent).toContain(
      strings['global.storageFull'],
    );
    expect(announce).toHaveBeenCalledWith(strings['global.storageFull'], 'assertive');
  });

  it('the banner after a saved take shows the saved copy', () => {
    vi.spyOn(announcer, 'announce').mockImplementation(() => {});
    snapshot = { ...LIVE, storageFull: true, storageFullSaved: true };
    render(<StorageFullBanner />);
    expect(screen.getByTestId('storage-full-banner').textContent).toContain(
      strings['record.storageFull'],
    );
  });

  it('the banner for a status set elsewhere (no stop) shows the shared copy and the Library link', () => {
    vi.spyOn(announcer, 'announce').mockImplementation(() => {});
    snapshot = { ...LIVE, storageFull: true };
    render(<StorageFullBanner />);
    const banner = screen.getByTestId('storage-full-banner');
    expect(banner.textContent).toContain(strings['global.storageFull']);
    expect(banner.getAttribute('role')).toBeNull();
    expect(screen.getByRole('link', { name: strings['global.goToLibrary'] })).toBeTruthy();
  });

  it('the banner announces once per showing, and again when the stop saves (its text changes)', () => {
    const announce = vi.spyOn(announcer, 'announce').mockImplementation(() => {});
    snapshot = { ...LIVE, storageFull: true };
    render(<StorageFullBanner />);
    const set = (next: RecordingSnapshot) => {
      snapshot = next;
      act(() => listeners.forEach((l) => l()));
    };
    set({ ...LIVE, storageFull: true, recording: 'stopping' });
    set({ ...LIVE, storageFull: true, storageFullSaved: true });
    set({ ...LIVE, storageFull: true, storageFullSaved: true, savedSeq: 1 });
    expect(announce.mock.calls).toEqual([
      [strings['global.storageFull'], 'assertive'],
      [strings['record.storageFull'], 'assertive'],
    ]);
    set(LIVE);
    expect(screen.queryByTestId('storage-full-banner')).toBeNull();
    set({ ...LIVE, storageFull: true });
    expect(announce).toHaveBeenCalledTimes(3);
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
