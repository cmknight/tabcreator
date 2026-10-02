// Recording store (spine AD-3). For now it owns the mic: the setup → live path, the open input
// (kept across screens, so leaving Record does not close the mic) and the level read by the
// meter. Read it with useSyncExternalStore; the levels are read on demand with `readLevels(now)`
// inside the UI's animation frame, which also advances the level warning, so the store notifies
// only on state changes (a mic transition or a warning change), never per frame.
//
// It also owns the input device list (refreshed on `devicechange` while live), the chosen
// device (`micDeviceId`) and the fallback to the default input when the active one is unplugged.
//
// While live it also derives the input quality warning (story 2.8) from the live track's sample
// rate and the active input's label; Dismiss hides it for the rest of the page session (memory
// only, never prefs).
//
// Decision (epic 2, 2026-10-02): this store writes `micGranted` and `micDeviceId` through
// storage/prefs.ts, although AD-3 names settings-session as the prefs store.

import { levelsDbfs, type LevelsDbfs } from '../audio/level-meter';
import {
  activeDevice,
  listMics,
  micPermission,
  onDeviceChange,
  openInput,
  requestMic,
  type MicDevice,
  type MicInput,
  type MicPermission,
} from '../audio/mic';
import { AppError, isAppError, type AppErrorCode } from '../model/errors';
import { isPoorInput } from '../model/input-quality';
import {
  INITIAL_LEVEL_WARNING_STATE,
  nextWarning,
  type LevelWarning,
} from '../model/level-warnings';
import { loadPrefs, updatePrefs } from '../storage/prefs';

export type { MicDevice } from '../audio/mic';

export type MicState = 'setup' | 'requesting' | 'live' | 'error';

/** A one-off fact for the shell to show; `seq` grows with each new notice. */
export interface MicNotice {
  kind: 'switched';
  /** The label of the input now in use; "" when the browser gives none. */
  label: string;
  seq: number;
}

export interface RecordingSnapshot {
  mic: MicState;
  /** Set in `error`; kept while a Try again is `requesting`, so the error card stays in place. */
  errorCode?: AppErrorCode;
  /** The input level warning; only ever set while `live`. */
  levelWarning: LevelWarning | null;
  /** The selectable audio inputs; only filled while `live`. */
  devices: readonly MicDevice[];
  /** The listed device the live input runs on (or is switching to); null when not live. */
  activeDeviceId: string | null;
  /** The latest notice; kept until the next one replaces it. */
  notice?: MicNotice;
  /**
   * The live input is likely a Bluetooth headset in call mode or runs below 44.1 kHz. False
   * unless `live`; kept through a device switch until the new input opens.
   */
  inputQualityPoor: boolean;
  /** The quality warning was dismissed; in memory only, for the rest of the page session. */
  inputQualityDismissed: boolean;
}

/** A longer pause between level reads resets the warning machine. */
const READ_GAP_MS = 500;

const SILENCE: LevelsDbfs = { peakDb: -Infinity, rmsDb: -Infinity };

export interface RecordingSession {
  subscribe(listener: () => void): () => void;
  getSnapshot(): RecordingSnapshot;
  /**
   * Requests the mic (the Allow microphone or Try again click), on the saved device when there
   * is one, else (or when it is gone) the default. A no-op while requesting or live.
   */
  allowMic(): Promise<void>;
  /**
   * On entering a mic screen: from `setup` only, requests the mic without a click when the mic
   * was granted before (`micGranted`) and the browser still reports the permission `granted`.
   * Otherwise does nothing, so the setup card asks first. Never retries from `error`.
   */
  resume(): Promise<void>;
  /**
   * While live, switches to the listed device `deviceId`: closes the current input, opens that
   * device exactly and saves it as `micDeviceId`. A no-op when not live, while another switch
   * runs, or for the device already active. A failure shows its error card.
   */
  selectMic(deviceId: string): Promise<void>;
  /**
   * Peak and RMS in dBFS of the live input's current frame, and advances the level warning to
   * `now` (a monotonic clock, ms). Silence (`-Infinity`) when the mic is not live. Notifies
   * subscribers only when the warning changes.
   */
  readLevels(now: number): LevelsDbfs;
  /** The live input's analyser, for the meter and tuner slices; null when not live. */
  getAnalyser(): AnalyserNode | null;
  /** Hides the input quality warning until the page reloads, whatever input is chosen. */
  dismissInputQuality(): void;
}

type OpenedInput = Pick<
  MicInput,
  'analyser' | 'readFrame' | 'close' | 'deviceId' | 'groupId' | 'label' | 'sampleRate'
>;

/** The shell functions the store drives; injected so tests can fake audio/ and storage/. */
export interface RecordingDeps {
  requestMic: (deviceId?: string) => Promise<MediaStream>;
  openInput: (stream: MediaStream, onEnded: (error: AppError) => void) => OpenedInput;
  listMics: () => Promise<MicDevice[]>;
  onDeviceChange: (listener: () => void) => () => void;
  updatePrefs: (patch: { micGranted?: boolean; micDeviceId?: string | null }) => unknown;
  loadPrefs: () => { micGranted: boolean; micDeviceId?: string | null };
  micPermission: () => Promise<MicPermission>;
}

const asAppError = (err: unknown) =>
  isAppError(err)
    ? err
    : new AppError('mic-failed', 'Opening the microphone failed', { cause: err });

export function createRecordingSession(deps: RecordingDeps): RecordingSession {
  let snapshot: RecordingSnapshot = {
    mic: 'setup',
    levelWarning: null,
    devices: [],
    activeDeviceId: null,
    inputQualityPoor: false,
    inputQualityDismissed: false,
  };
  let input: OpenedInput | null = null;
  let warnings = INITIAL_LEVEL_WARNING_STATE;
  /** When `readLevels` last ran; null since the last mic transition. */
  let lastReadAt: number | null = null;
  /** A device switch or an ended-track fallback is running. */
  let busy = false;
  /** Bumped on every device list request, so an older answer never replaces a newer one. */
  let listSeq = 0;
  let noticeSeq = 0;
  let stopDeviceChange: (() => void) | null = null;
  const listeners = new Set<() => void>();

  function notify(next: RecordingSnapshot) {
    snapshot = next;
    for (const l of listeners) l();
  }

  /** A mic transition: the level warning starts afresh with every transition. */
  function set(next: {
    mic: MicState;
    errorCode?: AppErrorCode;
    devices?: readonly MicDevice[];
    activeDeviceId?: string | null;
    notice?: MicNotice;
  }) {
    warnings = INITIAL_LEVEL_WARNING_STATE;
    lastReadAt = null;
    const live = next.mic === 'live';
    const notice = next.notice ?? snapshot.notice;
    const devices = live ? (next.devices ?? snapshot.devices) : [];
    notify({
      mic: next.mic,
      ...(next.errorCode ? { errorCode: next.errorCode } : {}),
      levelWarning: null,
      devices,
      activeDeviceId: !live
        ? null
        : 'activeDeviceId' in next
          ? (next.activeDeviceId ?? null)
          : snapshot.activeDeviceId,
      ...(notice ? { notice } : {}),
      // While a switch runs there is no input: keep the last answer until the new one opens.
      inputQualityPoor: !live
        ? false
        : input
          ? poorInput(input, devices)
          : snapshot.inputQualityPoor,
      inputQualityDismissed: snapshot.inputQualityDismissed,
    });
    if (live && !stopDeviceChange) stopDeviceChange = deps.onDeviceChange(refreshDevices);
    if (!live && stopDeviceChange) {
      stopDeviceChange();
      stopDeviceChange = null;
    }
  }

  function readLevels(now: number): LevelsDbfs {
    if (!input || snapshot.mic !== 'live') return SILENCE;
    // The warnings advance only while a meter reads them: after a gap (meter unmounted, tab
    // hidden) the old timings say nothing about the input, so start afresh.
    if (lastReadAt !== null && now - lastReadAt > READ_GAP_MS) {
      warnings = INITIAL_LEVEL_WARNING_STATE;
    }
    lastReadAt = now;
    const levels = levelsDbfs(input.readFrame());
    warnings = nextWarning(warnings, { ...levels, now });
    if (warnings.warning !== snapshot.levelWarning) {
      notify({ ...snapshot, levelWarning: warnings.warning });
    }
    return levels;
  }

  async function listDevices(): Promise<MicDevice[]> {
    try {
      return await deps.listMics();
    } catch {
      return [];
    }
  }

  /** The listed id of `opened`'s device, or its own id when it is not listed. */
  const activeId = (opened: OpenedInput, devices: readonly MicDevice[]) =>
    activeDevice(opened, devices)?.deviceId ?? opened.deviceId;

  /** The quality rule on `opened`'s rate and label: the listed device's, else the track's. */
  const poorInput = (opened: OpenedInput, devices: readonly MicDevice[]) =>
    isPoorInput({
      sampleRate: opened.sampleRate,
      label: activeDevice(opened, devices)?.label || opened.label,
    });

  /**
   * Re-reads the device list while live (a `devicechange`), keeping the active id resolved and
   * the quality warning current (a relabelled input).
   */
  async function refreshDevices() {
    const seq = ++listSeq;
    const devices = await listDevices();
    if (seq !== listSeq || snapshot.mic !== 'live') return;
    const settled = input && !busy ? input : null;
    const activeDeviceId = settled ? activeId(settled, devices) : snapshot.activeDeviceId;
    const inputQualityPoor = settled ? poorInput(settled, devices) : snapshot.inputQualityPoor;
    notify({ ...snapshot, devices, activeDeviceId, inputQualityPoor });
  }

  function dismissInputQuality() {
    if (snapshot.inputQualityDismissed) return;
    notify({ ...snapshot, inputQualityDismissed: true });
  }

  /** Opens `stream` as the live input, then lists the devices. Throws `AppError`. */
  async function goLive(stream: MediaStream): Promise<{
    opened: OpenedInput;
    devices: MicDevice[];
    activeDeviceId: string | null;
  }> {
    const opened = deps.openInput(stream, () => void ended(opened));
    input = opened;
    ++listSeq;
    const devices = await listDevices();
    return { opened, devices, activeDeviceId: activeId(opened, devices) };
  }

  /**
   * Whether `opened` is still the live input (a track that ended meanwhile replaced it). A
   * function, so TypeScript does not narrow `input` across the awaits that may change it.
   */
  const holds = (opened: OpenedInput) => input === opened;

  function savePrefs(patch: { micGranted?: boolean; micDeviceId?: string | null }) {
    try {
      deps.updatePrefs(patch);
    } catch {
      // The mic works; a prefs write failure only loses the remembered hint.
    }
  }

  /** Requests the saved device, or the default when there is none or it is gone. */
  async function requestPreferred(): Promise<MediaStream> {
    let saved: string | null = null;
    try {
      saved = deps.loadPrefs().micDeviceId ?? null;
    } catch {
      // Unreadable prefs: use the default input.
    }
    if (!saved) return deps.requestMic();
    try {
      return await deps.requestMic(saved);
    } catch (err) {
      if (!isAppError(err) || err.code !== 'mic-no-device') throw err;
    }
    savePrefs({ micDeviceId: null });
    return deps.requestMic();
  }

  async function allowMic() {
    if (snapshot.mic === 'requesting' || snapshot.mic === 'live') return;
    set(
      snapshot.errorCode
        ? { mic: 'requesting', errorCode: snapshot.errorCode }
        : { mic: 'requesting' },
    );
    let live;
    try {
      live = await goLive(await requestPreferred());
    } catch (err) {
      input = null;
      set({ mic: 'error', errorCode: asAppError(err).code });
      return;
    }
    if (!holds(live.opened)) return;
    savePrefs({ micGranted: true });
    set({ mic: 'live', devices: live.devices, activeDeviceId: live.activeDeviceId });
  }

  async function selectMic(deviceId: string) {
    if (snapshot.mic !== 'live' || busy || deviceId === snapshot.activeDeviceId) return;
    busy = true;
    try {
      // Close (stop the tracks) before asking for the new device; the select shows the choice.
      const old = input;
      input = null;
      old?.close();
      set({ mic: 'live', activeDeviceId: deviceId });
      let live;
      try {
        live = await goLive(await deps.requestMic(deviceId));
      } catch (err) {
        input = null;
        set({ mic: 'error', errorCode: asAppError(err).code });
        return;
      }
      if (!holds(live.opened)) return;
      savePrefs({ micDeviceId: deviceId });
      set({ mic: 'live', devices: live.devices, activeDeviceId: live.activeDeviceId });
    } finally {
      busy = false;
    }
  }

  /**
   * The live track ended on its own. When its device is no longer listed and another remains
   * (an unplug), open the default input and post a `switched` notice; otherwise (a revoke, or
   * the only device gone) close the input and show the lost card.
   */
  async function ended(endedInput: OpenedInput) {
    if (input !== endedInput) return;
    // Only an id that resolved to a listed device can be found missing later; an unresolved
    // one (Chrome's `default` alias, or none) counts as still present: the lost card.
    const endedId = snapshot.devices.some((d) => d.deviceId === snapshot.activeDeviceId)
      ? snapshot.activeDeviceId
      : null;
    input = null;
    endedInput.close();
    busy = true;
    try {
      ++listSeq;
      const devices = await listDevices();
      const unplugged = endedId !== null && !devices.some((d) => d.deviceId === endedId);
      if (!unplugged || devices.length === 0) {
        set({ mic: 'error', errorCode: 'mic-lost' });
        return;
      }
      let live;
      try {
        live = await goLive(await deps.requestMic());
      } catch (err) {
        input = null;
        set({ mic: 'error', errorCode: asAppError(err).code });
        return;
      }
      if (!holds(live.opened)) return;
      const now = activeDevice(live.opened, live.devices);
      set({
        mic: 'live',
        devices: live.devices,
        activeDeviceId: live.activeDeviceId,
        notice: {
          kind: 'switched',
          label: now?.label || live.opened.label || '',
          seq: ++noticeSeq,
        },
      });
    } finally {
      busy = false;
    }
  }

  let resuming = false;

  async function resume() {
    if (snapshot.mic !== 'setup' || resuming) return;
    resuming = true;
    try {
      let granted = false;
      try {
        granted = deps.loadPrefs().micGranted;
      } catch {
        // Unreadable prefs: treat as a first visit.
      }
      if (!granted) return;
      if ((await deps.micPermission()) !== 'granted') return;
      if (snapshot.mic !== 'setup') return;
      await allowMic();
    } finally {
      resuming = false;
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    allowMic,
    resume,
    selectMic,
    readLevels,
    getAnalyser: () => input?.analyser ?? null,
    dismissInputQuality,
  };
}

export const recordingSession: RecordingSession = createRecordingSession({
  requestMic,
  openInput,
  listMics,
  onDeviceChange,
  updatePrefs,
  loadPrefs,
  micPermission,
});
