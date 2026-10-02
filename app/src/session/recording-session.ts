// Recording store (spine AD-3). For now it owns the mic: the setup → live path, the open input
// (kept across screens, so leaving Record does not close the mic) and the level read by the
// meter. Read it with useSyncExternalStore; the level is read on demand with `readLevel()`
// inside the UI's animation frame, so the store notifies only on state changes.
//
// Decision (epic 2, 2026-10-02): this store writes `micGranted` through storage/prefs.ts
// (`micDeviceId` follows with device select, story 2.7), although AD-3 names settings-session
// as the prefs store.

import { openInput, requestMic, type MicInput } from '../audio/mic';
import { AppError, isAppError, type AppErrorCode } from '../model/errors';
import { updatePrefs } from '../storage/prefs';

export type MicState = 'setup' | 'requesting' | 'live' | 'error';

export interface RecordingSnapshot {
  mic: MicState;
  errorCode?: AppErrorCode;
}

export interface RecordingSession {
  subscribe(listener: () => void): () => void;
  getSnapshot(): RecordingSnapshot;
  /** Requests the mic (the Allow microphone click). A no-op while requesting or live. */
  allowMic(): Promise<void>;
  /** Linear RMS (0..1) of the live input's current frame; 0 when the mic is not live. */
  readLevel(): number;
  /** The live input's analyser, for the meter and tuner slices; null when not live. */
  getAnalyser(): AnalyserNode | null;
}

/** The shell functions the store drives; injected so tests can fake audio/ and storage/. */
export interface RecordingDeps {
  requestMic: (deviceId?: string) => Promise<MediaStream>;
  openInput: (stream: MediaStream) => Pick<MicInput, 'analyser' | 'readRms' | 'close'>;
  updatePrefs: (patch: { micGranted: boolean }) => unknown;
}

export function createRecordingSession(deps: RecordingDeps): RecordingSession {
  let snapshot: RecordingSnapshot = { mic: 'setup' };
  let input: ReturnType<RecordingDeps['openInput']> | null = null;
  const listeners = new Set<() => void>();

  function set(next: RecordingSnapshot) {
    snapshot = next;
    for (const l of listeners) l();
  }

  async function allowMic() {
    if (snapshot.mic === 'requesting' || snapshot.mic === 'live') return;
    set({ mic: 'requesting' });
    try {
      const stream = await deps.requestMic();
      input = deps.openInput(stream);
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

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    allowMic,
    readLevel: () => (input ? input.readRms() : 0),
    getAnalyser: () => input?.analyser ?? null,
  };
}

export const recordingSession: RecordingSession = createRecordingSession({
  requestMic,
  openInput,
  updatePrefs,
});
