// Every app-initiated reload goes through here (spine AD-16, AD-19). A reload is refused while
// the recording store has a take in progress (counting in, starting, recording or stopping), so
// it never cuts a take short. Later stories add the analysing guard and await flushAll() first.

import { recordingSession, type RecordingSession } from './recording-session';

/**
 * Calls `reload` unless `session` has a take in progress. Returns whether it reloaded.
 * `reloadApp` is this with the app's store and `location.reload`.
 */
export function reloadUnlessBusy(
  session: Pick<RecordingSession, 'getSnapshot'>,
  reload: () => void,
): boolean {
  if (session.getSnapshot().recording !== 'idle') return false;
  reload();
  return true;
}

/** Reloads the app unless a take is in progress; returns whether it reloaded. */
export function reloadApp(): boolean {
  return reloadUnlessBusy(recordingSession, () => location.reload());
}
