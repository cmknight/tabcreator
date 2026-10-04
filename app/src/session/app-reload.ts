// Every app-initiated reload goes through here (spine AD-16, AD-19). A reload is refused while
// the recording store is busy (`isBusy`: a take counting in, starting, recording or stopping, a
// failed stop's re-offer, or a recovered take being rebuilt), so it never cuts a take or a save
// short, and while any take is being analysed (story 5.6). The recording store's `beforeunload`
// guard asks only in the first case: an analysis cut short by a reload starts again when its Tab
// opens. The caller tells the player why (story 5.2). A later story awaits flushAll() first.
import { analysis, type Analysis } from './analysis';
import { recordingSession, type RecordingSession } from './recording-session';

/**
 * Calls `reload` unless `session` is busy. Returns whether it reloaded. `reloadApp` is this
 * with the app's stores and `location.reload`.
 */
export function reloadUnlessBusy(
  session: Pick<RecordingSession, 'isBusy'>,
  reload: () => void,
): boolean {
  if (session.isBusy()) return false;
  reload();
  return true;
}

/** Busy for a reload: the recording store is busy, or an analysis is in flight. */
export function appBusy(
  recording: Pick<RecordingSession, 'isBusy'>,
  analyses: Pick<Analysis, 'isAnalysing'>,
): Pick<RecordingSession, 'isBusy'> {
  return { isBusy: () => recording.isBusy() || analyses.isAnalysing() };
}

/** Reloads the app unless recording or analysing; returns whether it reloaded. */
export function reloadApp(): boolean {
  return reloadUnlessBusy(appBusy(recordingSession, analysis), () => location.reload());
}
