// Every app-initiated reload goes through here (spine AD-16, AD-19). A reload is refused while
// the recording store is busy (`isBusy`: a take counting in, starting, recording or stopping, a
// failed stop's re-offer, or a recovered take being rebuilt), the same answer its `beforeunload`
// guard uses, so it never cuts a take or a save short. The caller tells the player why (story
// 5.2). Later stories add the analysing guard and await flushAll() first.

import { recordingSession, type RecordingSession } from './recording-session';

/**
 * Calls `reload` unless `session` is busy. Returns whether it reloaded. `reloadApp` is this
 * with the app's store and `location.reload`.
 */
export function reloadUnlessBusy(
  session: Pick<RecordingSession, 'isBusy'>,
  reload: () => void,
): boolean {
  if (session.isBusy()) return false;
  reload();
  return true;
}

/** Reloads the app unless the recording store is busy; returns whether it reloaded. */
export function reloadApp(): boolean {
  return reloadUnlessBusy(recordingSession, () => location.reload());
}
