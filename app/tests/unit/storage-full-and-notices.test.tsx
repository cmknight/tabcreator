import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { recordingSession } from '../../src/session/recording-session';
import type { RecordingSnapshot } from '../../src/session/recording-types';
import * as announcer from '../../src/ui/a11y/announcer';
import { MicNotices } from '../../src/ui/components/MicNotices';
import { StorageFullBanner } from '../../src/ui/components/StorageFullBanner';
import { StorageNoticeAnnouncer } from '../../src/ui/components/StorageNoticeAnnouncer';
import { ToastHost } from '../../src/ui/components/ToastHost';
import { strings } from '../../src/ui/strings';
import { dismissToast } from '../../src/ui/toast';

// Story 5.2 (DS3): the storage-full banner says "saved" only when the take was saved, and a
// failed save shows the save-failed toast. Story "Announcements and the Tab toolbar": the
// shell's StorageNoticeAnnouncer announces the stops on every screen; the save-failed toast is
// silent (the shell owns that one).

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

  it('MicNotices shows the save-failed toast silently (the shell announcer owns it)', () => {
    const announce = vi.spyOn(announcer, 'announce').mockImplementation(() => {});
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
    expect(announce).not.toHaveBeenCalled();
  });
});

describe('StorageNoticeAnnouncer', () => {
  let snapshot: RecordingSnapshot;
  let listeners: Array<() => void>;
  let announce: MockInstance<typeof announcer.announce>;
  const set = (next: RecordingSnapshot) => {
    snapshot = next;
    act(() => listeners.forEach((l) => l()));
  };

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
    announce = vi.spyOn(announcer, 'announce').mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('announces nothing on mount, whatever the snapshot shows', () => {
    snapshot = {
      ...LIVE,
      storageFull: true,
      storageFullSaved: true,
      savedSeq: 3,
      notice: { kind: 'save-failed', seq: 2 },
    };
    render(<StorageNoticeAnnouncer />);
    expect(announce).not.toHaveBeenCalled();
  });

  it('a storage-full stop that saved: the saved copy once, not the shared copy too', () => {
    render(<StorageNoticeAnnouncer />);
    set({ ...LIVE, recording: 'recording' });
    // The append fails: storage reads as full while the take runs.
    set({ ...LIVE, recording: 'recording', storageFull: true });
    set({ ...LIVE, recording: 'stopping', storageFull: true });
    const saved: RecordingSnapshot = {
      ...LIVE,
      storageFull: true,
      storageFullSaved: true,
      savedSeq: 1,
      lastStopReason: 'storage-full',
    };
    set(saved);
    // Later changes while it shows say nothing more.
    set({ ...saved, nearLimit: false });
    expect(announce.mock.calls).toEqual([[strings['record.storageFull'], 'assertive']]);
  });

  it('a failed save: the save-failed copy once', () => {
    render(<StorageNoticeAnnouncer />);
    set({ ...LIVE, recording: 'recording', storageFull: true });
    set({
      ...LIVE,
      storageFull: true,
      storageFullSaved: false,
      notice: { kind: 'save-failed', seq: 1 },
    });
    set({
      ...LIVE,
      storageFull: true,
      storageFullSaved: false,
      notice: { kind: 'save-failed', seq: 1 },
      savedSeq: 0,
    });
    expect(announce.mock.calls).toEqual([[strings['record.saveFailed'], 'assertive']]);
    // A failed save with storage not full says the same.
    set({ ...LIVE, notice: { kind: 'save-failed', seq: 2 } });
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it('storage filling outside a take: the shared copy, once per filling', () => {
    render(<StorageNoticeAnnouncer />);
    set({ ...LIVE, storageFull: true });
    set({ ...LIVE, storageFull: true, nearLimit: false });
    expect(announce.mock.calls).toEqual([[strings['global.storageFull'], 'assertive']]);
    set(LIVE);
    set({ ...LIVE, storageFull: true });
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it('full during a take that ends too short: the shared copy when it ends', () => {
    render(<StorageNoticeAnnouncer />);
    set({ ...LIVE, recording: 'recording', storageFull: true });
    expect(announce).not.toHaveBeenCalled();
    set({
      ...LIVE,
      storageFull: true,
      storageFullSaved: false,
      notice: { kind: 'too-short', seq: 1 },
    });
    expect(announce.mock.calls).toEqual([[strings['global.storageFull'], 'assertive']]);
  });

  it('storage freed before the save: the stop is still announced as storage-full', () => {
    render(<StorageNoticeAnnouncer />);
    set({ ...LIVE, recording: 'recording', storageFull: true });
    set({ ...LIVE, recording: 'stopping', storageFull: false });
    set({ ...LIVE, savedSeq: 1, lastStopReason: 'storage-full' });
    expect(announce.mock.calls).toEqual([[strings['record.storageFull'], 'assertive']]);
  });

  it('the stop and storage becoming full in one emit: only the stop message', () => {
    render(<StorageNoticeAnnouncer />);
    set({ ...LIVE, recording: 'stopping' });
    set({
      ...LIVE,
      storageFull: true,
      storageFullSaved: true,
      savedSeq: 1,
      lastStopReason: 'storage-full',
    });
    expect(announce.mock.calls).toEqual([[strings['record.storageFull'], 'assertive']]);
    // A failed save in the same emit as the flip: only the save-failed message.
    set(LIVE);
    set({ ...LIVE, storageFull: true, notice: { kind: 'save-failed', seq: 1 } });
    expect(announce.mock.calls.slice(1)).toEqual([[strings['record.saveFailed'], 'assertive']]);
  });

  it('a saved take with storage not full says nothing (RecordingAnnouncer owns that)', () => {
    render(<StorageNoticeAnnouncer />);
    set({ ...LIVE, recording: 'recording' });
    set({ ...LIVE, savedSeq: 1, lastStopReason: 'user' });
    expect(announce).not.toHaveBeenCalled();
  });
});
