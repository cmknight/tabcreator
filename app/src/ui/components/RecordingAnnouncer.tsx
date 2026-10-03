import { useEffect } from 'react';
import { recordingSession } from '../../session/recording-session';
import { announce } from '../a11y/announcer';
import { strings } from '../strings';

/**
 * Announces the take's progress politely, on whatever screen the player is (spine AD-18: the
 * store emits, the UI announces): "Recording started" when the state enters `recording`,
 * "Recording stopped" when a take is saved (a new `savedSeq`), and "30 seconds left" when
 * `nearLimit` turns on (once per take). Renders nothing. Mount exactly once, in the shell.
 */
export function RecordingAnnouncer() {
  useEffect(() => {
    let previous = recordingSession.getSnapshot();
    return recordingSession.subscribe(() => {
      const next = recordingSession.getSnapshot();
      const before = previous;
      previous = next;
      if (next.recording === 'recording' && before.recording !== 'recording') {
        announce(strings['record.started']);
      }
      if (next.nearLimit && !before.nearLimit) announce(strings['record.nearLimit']);
      if (next.savedSeq !== before.savedSeq) announce(strings['record.stopped']);
    });
  }, []);
  return null;
}
