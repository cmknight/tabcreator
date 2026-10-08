import { useEffect } from 'react';
import { recordingSession } from '../../session/recording-session';
import { announce } from '../a11y/announcer';
import { micErrorCode, micErrorKey } from '../mic-error';
import { strings } from '../strings';

/**
 * Announces the mic error card's title assertively on each transition into the error state,
 * on whatever screen the player is (spine AD-18: the card itself is not a live region).
 * Renders nothing. Mount exactly once, in the shell.
 */
export function MicErrorAnnouncer() {
  useEffect(() => {
    let previous = recordingSession.getSnapshot();
    return recordingSession.subscribe(() => {
      const next = recordingSession.getSnapshot();
      const entered = next.mic === 'error' && previous.mic !== 'error';
      previous = next;
      if (!entered) return;
      const code = micErrorCode(next.errorCode) ?? 'mic-failed';
      // Each entry is a new failure, even the same one again on a Try again: never a duplicate.
      announce(strings[micErrorKey(code, 'Title')], 'assertive', { repeat: true });
    });
  }, []);
  return null;
}
