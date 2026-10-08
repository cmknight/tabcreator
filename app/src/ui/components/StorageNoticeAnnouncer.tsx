import { useEffect } from 'react';
import { recordingSession } from '../../session/recording-session';
import { announce } from '../a11y/announcer';
import { strings } from '../strings';

/**
 * Announces the storage-full and failed-save stops assertively on whatever screen the player is
 * (spine AD-18): each once, as it happens, never on mount.
 *
 * - A take saved by a storage-full stop (a new `savedSeq` with `lastStopReason` `storage-full`,
 *   whatever storage reads by then): "Storage is full — recording stopped and saved".
 * - A stopped take that could not be saved (a new `save-failed` notice). The save-failed toast
 *   is silent: this is its one announcement.
 * - Storage becoming full outside a take (the recording store mirrors storage/persistence.ts's
 *   one storage-full status): the shared Storage full text. Full during a take, the take's stop
 *   speaks for it; a stop that says neither (a too-short take) gets the shared text then. An
 *   emit that announced a stop never also announces the shared text.
 *
 * The screens' own storage-full banners (Record's, the Library's) still announce once per
 * showing; the announcer drops the same text repeated within its repeat window, so the two
 * are heard once. Renders nothing. Mount exactly once, in the shell.
 */
export function StorageNoticeAnnouncer() {
  useEffect(() => {
    let previous = recordingSession.getSnapshot();
    /** Storage became full while a take was under way, and nothing has said so yet. */
    let fullDuringTake = false;
    return recordingSession.subscribe(() => {
      const next = recordingSession.getSnapshot();
      const before = previous;
      previous = next;
      let stopAnnounced = false;
      if (
        next.notice &&
        next.notice.seq !== before.notice?.seq &&
        next.notice.kind === 'save-failed'
      ) {
        stopAnnounced = true;
        announce(strings['record.saveFailed'], 'assertive');
      } else if (next.savedSeq !== before.savedSeq && next.lastStopReason === 'storage-full') {
        stopAnnounced = true;
        announce(strings['record.storageFull'], 'assertive');
      }
      if (stopAnnounced || !next.storageFull) {
        fullDuringTake = false;
        return;
      }
      if (!before.storageFull) {
        if (next.recording === 'idle') announce(strings['global.storageFull'], 'assertive');
        else fullDuringTake = true;
        return;
      }
      if (fullDuringTake && next.recording === 'idle') {
        fullDuringTake = false;
        announce(strings['global.storageFull'], 'assertive');
      }
    });
  }, []);
  return null;
}
