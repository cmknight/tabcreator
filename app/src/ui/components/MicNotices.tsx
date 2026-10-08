import { useEffect } from 'react';
import { recordingSession } from '../../session/recording-session';
import { inputDisplayName } from '../format';
import { showToast } from '../toast';
import { strings } from '../strings';

/**
 * Shows a toast for each new recording-session notice (a new `notice.seq`): the input switched
 * after an unplug, a take stopped and saved after its input was unplugged, a too-short take
 * discarded, or a stopped take that could not be saved. On whatever screen the player is: the store
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
      if (notice.kind === 'stopped-saved') {
        showToast({ message: strings['global.micStoppedSaved'] });
        return;
      }
      if (notice.kind === 'save-failed') {
        // Never the only place: the take is offered again by the recovered-take banner. Silent:
        // the shell's StorageNoticeAnnouncer announces it (one owner).
        showToast({ message: strings['record.saveFailed'], silent: true });
        return;
      }
      // An unlabelled input is named as the Microphone select names it.
      const n = devices.findIndex((d) => d.deviceId === activeDeviceId) + 1 || 1;
      showToast({ message: strings['global.micSwitched'](inputDisplayName(notice.label, n)) });
    });
  }, []);
  return null;
}
