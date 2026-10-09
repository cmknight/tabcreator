// The Library screen's shared feedback (split from Library.tsx by the refactor sweep): the toasts
// for a refused or failed write, the backup-ready banner's text and a finished backup's delivery.

import { isAppError } from '../../../model/errors';
import type {
  BackupResult,
  LibraryBusyReason,
  PendingDownload,
} from '../../../session/library-session';
import { announce } from '../../a11y/announcer';
import { formatClockTime } from '../../format';
import { downloadBlob } from '../../platform';
import { strings } from '../../strings';
import { showToast } from '../../toast';

/** The toast for something refused while a backup or restore runs: what to wait for. */
export function toastBusy(reason: LibraryBusyReason) {
  showToast({
    message: strings[reason === 'backup' ? 'library.busyBackup' : 'library.busyRestore'],
  });
}

/**
 * A failed write's toast (the session logged the error and corrected the row); a write refused
 * while a backup or restore runs says what to wait for instead (nothing was changed).
 */
export const toastFailure =
  (key: 'library.renameFailed' | 'library.deleteTakeFailed' | 'library.deleteAudioFailed') =>
  (err: unknown) => {
    if (isAppError(err) && err.code === 'library-busy') {
      const reason = (err as { reason?: unknown }).reason;
      toastBusy(reason === 'restore' ? 'restore' : 'backup');
    } else {
      showToast({ message: strings[key] });
    }
  };

/** The ready banner's text: "Your backup is ready — 3 takes, made at 9:14 pm". */
export const readyText = (pending: PendingDownload) =>
  strings['library.backupReady'](
    pending.result.takes,
    formatClockTime(new Date(pending.finishedAt)),
  );

/**
 * Downloads a finished backup and says so: "Backed up N takes" announced, and a toast for any
 * missing, unsupported or unfinished takes.
 */
export function deliverBackup(result: BackupResult) {
  downloadBlob(result.fileName, result.blob);
  announce(strings['library.backedUp'](result.takes));
  const notes: string[] = [];
  if (result.missingAudio > 0) notes.push(strings['library.backupMissing'](result.missingAudio));
  if (result.unsupportedAudio > 0) {
    notes.push(strings['library.backupUnsupported'](result.unsupportedAudio));
  }
  if (result.skippedUnfinished > 0) {
    notes.push(strings['library.backupUnfinished'](result.skippedUnfinished));
  }
  if (notes.length > 0) showToast({ message: notes.join(' · ') });
}
