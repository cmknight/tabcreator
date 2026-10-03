import { useEffect } from 'react';
import { recordingSession } from '../../session/recording-session';
import { showToast } from '../toast';
import { strings } from '../strings';

/**
 * Shows a toast for each new recording-session notice (a new `notice.seq`): the input switched
 * after an unplug, or a too-short take discarded. On whatever screen the player is: the store
 * emits, the shell shows (spine AD-3, AD-18). Renders nothing. Mount exactly once, in the shell.
 */
export function MicNotices() {
  useEffect(() => {
    let seen = recordingSession.getSnapshot().notice?.seq;
    return recordingSession.subscribe(() => {
      const { notice, devices, activeDeviceId } = recordingSession.getSnapshot();
      if (!notice || notice.seq === seen) return;
      seen = notice.seq;
      if (notice.kind === 'too-short') {
        showToast({ message: strings['record.tooShort'] });
        return;
      }
      // An unlabelled input is named as the Microphone select names it.
      const n = devices.findIndex((d) => d.deviceId === activeDeviceId) + 1 || 1;
      const label = notice.label || strings['global.microphoneUnnamed'](n);
      showToast({ message: strings['global.micSwitched'](label) });
    });
  }, []);
  return null;
}
