// Recording store (spine AD-3). For now it owns the mic: the setup → live path, the open input
// (kept across screens, so leaving Record does not close the mic) and the level read by the
// meter. Read it with useSyncExternalStore; the level is read on demand with `readLevel()`
// inside the UI's animation frame, so the store notifies only on state changes.
//
// Decision (epic 2, 2026-10-02): this store writes `micGranted` through storage/prefs.ts
// (`micDeviceId` follows with device select, story 2.7), although AD-3 names settings-session
// as the prefs store.

import {
  micPermission,
  openInput,
  requestMic,
  type MicInput,
  type MicPermission,
} from '../audio/mic';
import { AppError, isAppError, type AppErrorCode } from '../model/errors';
import { loadPrefs, updatePrefs } from '../storage/prefs';

export type MicState = 'setup' | 'requesting' | 'live' | 'error';

export interface RecordingSnapshot {
  mic: MicState;
  /** Set in `error`; kept while a Try again is `requesting`, so the error card stays in place. */
  errorCode?: AppErrorCode;
}

export interface RecordingSession {
  subscribe(listener: () => void): () => void;
  getSnapshot(): RecordingSnapshot;
  /** Requests the mic (the Allow microphone or Try again click). A no-op while requesting or live. */
  allowMic(): Promise<void>;
  /**
   * On entering a mic screen: from `setup` only, requests the mic without a click when the mic
   * was granted before (`micGranted`) and the browser still reports the permission `granted`.
   * Otherwise does nothing, so the setup card asks first. Never retries from `error`.
   */
  resume(): Promise<void>;
  /** Linear RMS (0..1) of the live input's current frame; 0 when the mic is not live. */
  readLevel(): number;
  /** The live input's analyser, for the meter and tuner slices; null when not live. */
  getAnalyser(): AnalyserNode | null;
}

/** The shell functions the store drives; injected so tests can fake audio/ and storage/. */
export interface RecordingDeps {
  requestMic: (deviceId?: string) => Promise<MediaStream>;
  openInput: (
    stream: MediaStream,
    onEnded: (error: AppError) => void,
  ) => Pick<MicInput, 'analyser' | 'readRms' | 'close'>;
  updatePrefs: (patch: { micGranted: boolean }) => unknown;
  loadPrefs: () => { micGranted: boolean };
  micPermission: () => Promise<MicPermission>;
}

export function createRecordingSession(deps: RecordingDeps): RecordingSession {
  let snapshot: RecordingSnapshot = { mic: 'setup' };
  let input: ReturnType<RecordingDeps['openInput']> | null = null;
  const listeners = new Set<() => void>();

  function set(next: RecordingSnapshot) {
    snapshot = next;
    for (const l of listeners) l();
  }

  /** The live track ended: close the input first, then show the lost card. */
  function lost(ended: ReturnType<RecordingDeps['openInput']>, error: AppError) {
    if (input !== ended) return;
    input = null;
    ended.close();
    set({ mic: 'error', errorCode: error.code });
  }

  async function allowMic() {
    if (snapshot.mic === 'requesting' || snapshot.mic === 'live') return;
    set(
      snapshot.errorCode
        ? { mic: 'requesting', errorCode: snapshot.errorCode }
        : { mic: 'requesting' },
    );
    try {
      const stream = await deps.requestMic();
      const opened = deps.openInput(stream, (error) => lost(opened, error));
      input = opened;
    } catch (err) {
      const error = isAppError(err)
        ? err
        : new AppError('mic-failed', 'Opening the microphone failed', { cause: err });
      set({ mic: 'error', errorCode: error.code });
      return;
    }
    try {
      deps.updatePrefs({ micGranted: true });
    } catch {
      // The mic works; a prefs write failure only loses the "granted before" hint.
    }
    set({ mic: 'live' });
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
    readLevel: () => (input ? input.readRms() : 0),
    getAnalyser: () => input?.analyser ?? null,
  };
}

export const recordingSession: RecordingSession = createRecordingSession({
  requestMic,
  openInput,
  updatePrefs,
  loadPrefs,
  micPermission,
});
