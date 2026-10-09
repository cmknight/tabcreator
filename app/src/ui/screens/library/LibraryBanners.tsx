// The Library's banners. Above the heading (story "Storage protection and Library states", 6.7,
// CAP-19, CAP-25; mockup library.html (d), (e)):
// - the one-time storage notice: a warning banner, role status, shown when the browser has not
//   persisted storage; Back up library starts the backup, Dismiss hides it for this visit;
// - the "Your backup is ready" banner (story 7.17): a backup that finished after the player left
//   the Library, with its take count and time; Download, Dismiss; no role; hidden while a newer
//   backup runs;
// - the storage-full banner (`StorageFullBannerView`): no role, no Dismiss and no link; shown
//   while storage/persistence.ts's one status is set, which only freed space clears.
// Under the tools, the restore error banner: the last restore attempt failed, and why.
// Library.tsx owns when each shows and their announcements.

import type { PendingDownload } from '../../../session/library-session';
import banner from '../../components/banner.module.css';
import { BackupIcon, ErrorIcon, WarnIcon } from '../../components/icons';
import { StorageFullBannerView } from '../../components/StorageFullBannerView';
import { strings } from '../../strings';
import libraryStyles from '../Library.module.css';
import { readyText } from './feedback';

/** The one-time storage notice: Back up library (aria-disabled when it cannot run) and Dismiss. */
export function PersistNotice({
  backUpDisabled,
  onBackUp,
  onDismiss,
}: {
  backUpDisabled: boolean;
  onBackUp(): void;
  onDismiss(): void;
}) {
  return (
    <div
      className={`${banner.banner} ${banner.warning} ${libraryStyles.topBanner}`}
      role="status"
      data-testid="persist-notice"
    >
      <WarnIcon className={banner.icon} />
      <p className={banner.text}>{strings['library.persistNotice']}</p>
      <button
        type="button"
        className={libraryStyles.noticeAction}
        aria-disabled={backUpDisabled || undefined}
        onClick={onBackUp}
      >
        {strings['library.backUp']}
      </button>
      <button
        type="button"
        className={libraryStyles.dismiss}
        aria-label={strings['library.persistNoticeDismiss']}
        onClick={onDismiss}
      >
        {strings['global.dismiss']}
      </button>
    </div>
  );
}

/** "Your backup is ready": Download and Dismiss. */
export function BackupReadyBanner({
  ready,
  onDownload,
  onDismiss,
}: {
  ready: PendingDownload;
  onDownload(): void;
  onDismiss(): void;
}) {
  return (
    <div
      className={`${banner.banner} ${banner.warning} ${libraryStyles.topBanner}`}
      data-testid="backup-ready"
    >
      <BackupIcon className={banner.icon} />
      <p className={banner.text}>{readyText(ready)}</p>
      <button type="button" className={libraryStyles.noticeAction} onClick={onDownload}>
        {strings['library.backupReadyDownload']}
      </button>
      <button type="button" className={libraryStyles.dismiss} onClick={onDismiss}>
        {strings['global.dismiss']}
      </button>
    </div>
  );
}

/** The storage-full banner, as the Library shows it: no link. */
export function LibraryStorageFull() {
  return (
    <StorageFullBannerView
      text={strings['global.storageFull']}
      className={libraryStyles.topBanner}
      testId="library-storage-full"
      link={false}
    />
  );
}

/** The last restore attempt failed: why. */
export function RestoreErrorBanner({ text }: { text: string }) {
  return (
    <div
      className={`${banner.banner} ${banner.error} ${libraryStyles.restoreBanner}`}
      data-testid="restore-error"
    >
      <ErrorIcon className={banner.icon} />
      <p className={banner.text}>{text}</p>
    </div>
  );
}
