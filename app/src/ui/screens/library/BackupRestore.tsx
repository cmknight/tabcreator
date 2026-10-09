// The Library's backup and restore tools: `useBackupRestore` (the flows), the two tool buttons,
// the restore Confirm dialog and the backup progress panel.
//
// Story "Back up the library" (US-7.3; EXPERIENCE.md :85, mockup library.html (f·1)): Back up
// library, beside the search, builds the backup zip through library-session (in a worker) while
// "Backing up…" and a progress bar show under the header; then the browser downloads
// `tabcreator-backup-YYYYMMDD.zip` (ui/platform.ts). The button is disabled unless a take not
// still recording exists, and aria-disabled while a backup or restore runs; there is no Cancel.
// The start and the takes backed up are announced politely; missing or unsupported audio and a
// failure are toasts, the failure also announced assertively. A backup that finished after the
// player left the Library shows a global toast then ("Backup ready — download it from the
// Library", story 7.17).
//
// Story "Restore from a backup" (US-7.3, Flow 4; EXPERIENCE.md :85, :115, :117, mockup
// library.html (f·2)): Restore from backup, after Back up library, is enabled even with an empty
// library. It picks a .zip (ui/platform.ts), has library-session read and check it in full
// (nothing written), then a Confirm dialog ("Restore 3 takes from <file>?", counting the takes
// not already present, Cancel first) imports them; with none new there is no dialog, just the
// summary. Meanwhile the button reads "Restoring…" and is aria-disabled, Back up library too. The
// summary ("Imported 2 takes, skipped 1 already in your library") is a toast and a polite
// announcement; the list refreshes through `library-restored`. An invalid file, or a failed
// write, sets the error banner's text (announced assertively) until the next restore attempt or
// leaving the Library; nothing was changed. Cancelling the picker or the dialog changes nothing.
// Story "Streaming restore and restore races": a failed restore whose rollback could not remove
// every file it wrote (`RestoreLeftFilesError`) says so instead ("some files were left behind…").
// Story 7.17: a file chosen after the picker already settled null (its fallback) still starts the
// restore (`onLate`), or, while a backup or restore runs, is refused with a toast saying what to
// wait for. Restore always opens a new picker, superseding one still open.

import { useRef, useState, type RefObject } from 'react';
import { isAppError } from '../../../model/errors';
import {
  RestoreLeftFilesError,
  type LibrarySession,
  type RestorePlan,
} from '../../../session/library-session';
import { announce } from '../../a11y/announcer';
import buttons from '../../components/buttons.module.css';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { BackupIcon, RestoreIcon } from '../../components/icons';
import { pickFile } from '../../platform';
import { strings } from '../../strings';
import { showToast } from '../../toast';
import libraryStyles from '../Library.module.css';
import { deliverBackup, toastBusy } from './feedback';

/** A checked backup waiting for the Confirm dialog, with its file's name. */
export interface ConfirmRestore {
  plan: RestorePlan;
  fileName: string;
}

/**
 * The Back up and Restore flows. `canBackUp`: a take not still recording exists; `mounted`:
 * whether the screen is still mounted (a backup finishing after it went is a global toast).
 */
export function useBackupRestore({
  session,
  canBackUp,
  backingUp,
  restoring,
  mounted,
}: {
  session: Pick<LibrarySession, 'getSnapshot' | 'backUp' | 'readBackup' | 'restore'>;
  canBackUp: boolean;
  backingUp: boolean;
  restoring: boolean;
  mounted: RefObject<boolean>;
}) {
  const backUp = () => {
    if (!canBackUp || backingUp || restoring) return;
    announce(strings['library.backingUp']);
    session.backUp().then(
      (result) => {
        // Null: another one runs, or it finished with no screen (kept as pendingDownload): then
        // a global toast (announced politely by the toast host) says where to get it.
        if (result) deliverBackup(result);
        else if (!mounted.current && session.getSnapshot().pendingDownload) {
          showToast({ message: strings['global.backupReady'] });
        }
      },
      () => {
        // The session logged the error and cleared its backup state.
        showToast({ message: strings['library.backupFailed'] });
        announce(strings['library.backupFailed'], 'assertive');
      },
    );
  };
  // Restore: pick, read and check, confirm, import.
  const restoreButton = useRef<HTMLButtonElement>(null);
  const [confirmRestore, setConfirmRestore] = useState<ConfirmRestore | null>(null);
  /** The error banner's text: the last restore attempt failed. */
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const restoreFailed = (err: unknown) => {
    // The session logged it. Nothing was written, unless its rollback left files behind.
    const text =
      err instanceof RestoreLeftFilesError
        ? strings['library.restoreLeftFiles']
        : isAppError(err) && err.code === 'backup-invalid'
          ? strings['library.restoreInvalid']
          : strings['library.restoreFailed'];
    setRestoreError(text);
    announce(text, 'assertive');
  };
  const startRestore = async () => {
    if (backingUp || restoring) return;
    setRestoreError(null);
    // No guard for an open picker: a browser may report none of its closing (no cancel, focus or
    // visibility change), so each click opens a new one, which settles the pending one null. A
    // file chosen after a fallback null arrives through onLate and starts the same flow.
    const file = await pickFile('.zip,application/zip', {
      onLate: (late) => {
        if (!mounted.current) return;
        const now = session.getSnapshot();
        if (now.backup || now.restoring) {
          toastBusy(now.backup ? 'backup' : 'restore');
          return;
        }
        setRestoreError(null);
        readPicked(late);
      },
    });
    if (file) readPicked(file);
  };
  /** Reads and checks a picked backup file, then asks to restore it. */
  const readPicked = (file: File) => {
    const fileName = file.name;
    announce(strings['library.restoring']);
    session.readBackup(file).then((plan) => {
      if (!plan) return;
      // Nothing new to import: no question to ask, just the summary.
      if (plan.toImport === 0) runRestore(plan);
      else setConfirmRestore({ plan, fileName });
    }, restoreFailed);
  };
  const runRestore = (plan: RestorePlan) => {
    session.restore(plan.backup).then((result) => {
      if (!result) return;
      const summary = strings['library.restored'](result.imported, result.skipped);
      showToast({ message: summary });
      announce(summary);
    }, restoreFailed);
  };

  return {
    backUp,
    restoreButton,
    startRestore,
    restoreError,
    confirmRestore,
    cancelRestore: () => setConfirmRestore(null),
    confirmAndRestore: (pending: ConfirmRestore) => {
      setConfirmRestore(null);
      runRestore(pending.plan);
    },
  };
}

/** Back up library and Restore from backup, the tools row's buttons. */
export function BackupRestoreButtons({
  canBackUp,
  busy,
  restoring,
  restoreButton,
  onBackUp,
  onRestore,
}: {
  canBackUp: boolean;
  /** A backup or restore runs: both are aria-disabled. */
  busy: boolean;
  restoring: boolean;
  restoreButton: RefObject<HTMLButtonElement | null>;
  onBackUp(): void;
  onRestore(): void;
}) {
  return (
    <>
      {/* Native disabled with nothing to back up (no take but recording ones); aria-disabled
          while a backup or restore runs, so focus stays. */}
      <button
        type="button"
        className={`${buttons.secondary} ${libraryStyles.backup}`}
        disabled={!canBackUp}
        aria-disabled={busy || undefined}
        onClick={onBackUp}
      >
        <BackupIcon className={buttons.icon} />
        {strings['library.backUp']}
      </button>
      {/* Enabled even with no takes (a fresh profile is when it is needed); aria-disabled while
          a backup or restore runs. */}
      <button
        ref={restoreButton}
        type="button"
        className={`${buttons.secondary} ${libraryStyles.backup}`}
        aria-disabled={busy || undefined}
        onClick={onRestore}
      >
        <RestoreIcon className={buttons.icon} />
        {restoring ? strings['library.restoring'] : strings['library.restore']}
      </button>
    </>
  );
}

/** "Restore 3 takes from <file>?": Cancel first. */
export function RestoreConfirmDialog({
  pending,
  opener,
  onCancel,
  onConfirm,
}: {
  pending: ConfirmRestore;
  opener(): HTMLElement | null;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <ConfirmDialog
      title={strings['library.restoreTitle'](pending.plan.toImport, pending.fileName)}
      body={strings['library.restoreBody'](pending.plan.toSkip)}
      confirmLabel={strings['library.restoreConfirm']}
      opener={opener}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

/** "Backing up…" and its progress bar, under the tools. */
export function BackupProgress({ progress }: { progress: number }) {
  const percent = strings['library.backupPercent'](Math.floor(progress * 100 + 1e-9));
  return (
    <div className={libraryStyles.progressPanel} data-testid="backup-progress">
      <label className={libraryStyles.progressLabel} htmlFor="library-backup-progress">
        {strings['library.backingUp']}
      </label>
      <div className={libraryStyles.progressRow}>
        <progress
          id="library-backup-progress"
          className={libraryStyles.progress}
          max={1}
          value={progress}
          aria-valuetext={percent}
        />
        <span className={libraryStyles.percent}>{percent}</span>
      </div>
    </div>
  );
}
