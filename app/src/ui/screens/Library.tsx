// The Library screen (story "Library list (tracer)", US-7.1; mockup library.html): every take,
// newest first, from library-session (the list, its rows and their menus: `library/RowList.tsx`).
// With no takes: "No takes yet" and Record; until the first read, "Loading…"; a failed read, one
// error line.
//
// Story "Search 500 takes" (EXPERIENCE.md Search, mockup library.html "libtools"): the Search
// takes field filters the rows by title as you type, ignoring case and accents (model/library
// `filterRows`); no match shows "No takes match …" and Clear search; the result count is announced
// once typing settles (`ANNOUNCE_AFTER_MS`). When the library empties, the search clears, focus in
// it moves to the heading, and a pending count is not announced.
//
// Around the list, from `library/`: the banners above the heading (`LibraryBanners.tsx`), Back up
// library and Restore from backup beside the search (`BackupRestore.tsx`), and the footer
// (`LibraryFooter.tsx`). The screen announces the backup-ready banner once per backup and the
// storage-full banner once each time it shows (AD-18), and marks the one-time storage notice as
// shown through the session the first time it shows (Dismiss hides it for this visit). A banner
// button that removes its banner moves focus to the heading first.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { filterRows } from '../../model/library';
import {
  librarySession,
  type LibrarySession,
  type PendingDownload,
} from '../../session/library-session';
import { announce } from '../a11y/announcer';
import buttons from '../components/buttons.module.css';
import { ErrorIcon, SearchIcon } from '../components/icons';
import { routeToHash } from '../router';
import { strings } from '../strings';
import {
  BackupProgress,
  BackupRestoreButtons,
  RestoreConfirmDialog,
  useBackupRestore,
} from './library/BackupRestore';
import { deliverBackup, readyText } from './library/feedback';
import {
  BackupReadyBanner,
  LibraryStorageFull,
  PersistNotice,
  RestoreErrorBanner,
} from './library/LibraryBanners';
import { LibraryFooter } from './library/LibraryFooter';
import { RowList } from './library/RowList';
import libraryStyles from './Library.module.css';
import styles from './Screen.module.css';

export { OVERSCAN, VIRTUAL_ABOVE } from './library/RowList';

/** How long typing must pause before the result count is announced. */
export const ANNOUNCE_AFTER_MS = 500;

export function Library({
  session = librarySession,
}: {
  session?: Pick<
    LibrarySession,
    | 'subscribe'
    | 'getSnapshot'
    | 'rename'
    | 'deleteTake'
    | 'deleteAudio'
    | 'backUp'
    | 'clearPendingDownload'
    | 'readBackup'
    | 'restore'
    | 'markPersistNoticeShown'
  >;
} = {}) {
  const { loading, rows, error, backup, restoring, storage, persistNotice, pendingDownload } =
    useSyncExternalStore(session.subscribe, session.getSnapshot);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusHeading = useCallback(() => heading.current?.focus(), []);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A backup kept while the player was away: its banner is announced once (AD-18).
  // Hidden while a newer backup runs (that one replaces or clears it).
  const ready = backup ? null : pendingDownload;
  const readyAnnounced = useRef<PendingDownload | null>(null);
  useEffect(() => {
    if (!ready || readyAnnounced.current === ready) return;
    readyAnnounced.current = ready;
    announce(readyText(ready));
  }, [ready]);

  // The storage-full banner is announced once each time it shows, including on mount (AD-18).
  // Storage filling while here is also announced by the shell's StorageNoticeAnnouncer: the
  // announcer drops the same text repeated within its repeat window, so it is heard once.
  const fullAnnounced = useRef(false);
  useEffect(() => {
    if (fullAnnounced.current === storage.full) return;
    fullAnnounced.current = storage.full;
    if (storage.full) announce(strings['global.storageFull'], 'assertive');
  }, [storage.full]);

  // The one-time storage notice: remembered as shown once it shows; Dismiss hides it this visit.
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const noticeShown = persistNotice && !noticeDismissed;
  const noticeMarked = useRef(false);
  useEffect(() => {
    if (!noticeShown || noticeMarked.current) return;
    noticeMarked.current = true;
    session.markPersistNoticeShown();
  }, [noticeShown, session]);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const shown = useMemo(() => filterRows(rows, query), [rows, query]);

  // The result count, announced once typing (or Clear search) settles; not for live updates.
  const latest = useRef({ shown, query });
  useLayoutEffect(() => {
    latest.current = { shown, query };
  });
  const typed = useRef(false);
  const announceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropAnnouncement = () => {
    if (announceTimer.current !== null) clearTimeout(announceTimer.current);
    announceTimer.current = null;
  };
  useEffect(() => {
    if (!typed.current) return;
    announceTimer.current = setTimeout(() => {
      announceTimer.current = null;
      const { shown: now, query: q } = latest.current;
      announce(
        now.length === 0
          ? strings['library.noMatch'](q)
          : strings['library.matchCount'](now.length),
      );
    }, ANNOUNCE_AFTER_MS);
    return dropAnnouncement;
  }, [query]);
  const changeQuery = (q: string) => {
    typed.current = true;
    setQuery(q);
  };

  // The library emptied (the last take deleted): the search goes with it. Its field is disabled,
  // so focus in it moves to the heading, and a count still pending is not announced.
  // (The query is cleared during render; this layout effect runs before the query effect, so
  // that clearing announces nothing either.)
  const empty = rows.length === 0;
  if (empty && query !== '') setQuery('');
  useLayoutEffect(() => {
    if (!empty) return;
    if (search.current && document.activeElement === search.current) focusHeading();
    typed.current = false;
    dropAnnouncement();
  }, [empty, focusHeading]);

  // Only takes that are not still recording are backed up.
  const canBackUp = rows.some((r) => r.status !== 'recording');
  const {
    backUp,
    restoreButton,
    startRestore,
    restoreError,
    confirmRestore,
    cancelRestore,
    confirmAndRestore,
  } = useBackupRestore({ session, canBackUp, backingUp: backup !== null, restoring, mounted });

  let body: ReactNode = null;
  if (shown.length > 0) {
    body = (
      <RowList
        rows={shown}
        actions={session}
        pausedBy={
          backup ? strings['library.backingUp'] : restoring ? strings['library.restoring'] : null
        }
        onRowGone={focusHeading}
      />
    );
  } else if (rows.length > 0) {
    body = (
      <div className={libraryStyles.empty}>
        <h2 className={libraryStyles.emptyTitle}>{strings['library.noMatch'](query)}</h2>
        <button
          type="button"
          className={buttons.secondary}
          onClick={() => {
            changeQuery('');
            search.current?.focus();
          }}
        >
          {strings['library.clearSearch']}
        </button>
      </div>
    );
  } else if (loading) {
    body = (
      <p className={libraryStyles.loading} aria-busy="true">
        {strings['library.loading']}
      </p>
    );
  } else if (!error) {
    body = (
      <div className={libraryStyles.empty}>
        <h2 className={libraryStyles.emptyTitle}>{strings['library.empty']}</h2>
        <a className={buttons.primary} href={routeToHash({ name: 'record' })}>
          {strings['library.emptyRecord']}
        </a>
      </div>
    );
  }

  return (
    <section className={styles.screen}>
      {noticeShown && (
        <PersistNotice
          backUpDisabled={!canBackUp || backup !== null || restoring}
          onBackUp={backUp}
          onDismiss={() => {
            // The button goes with the banner: focus moves to the heading first.
            focusHeading();
            setNoticeDismissed(true);
          }}
        />
      )}
      {ready && (
        <BackupReadyBanner
          ready={ready}
          onDownload={() => {
            // The button goes with the banner: focus moves to the heading first.
            focusHeading();
            deliverBackup(ready.result);
            session.clearPendingDownload(ready);
          }}
          onDismiss={() => {
            focusHeading();
            session.clearPendingDownload(ready);
          }}
        />
      )}
      {storage.full && <LibraryStorageFull />}
      <h1 ref={heading} className={styles.title} tabIndex={-1}>
        {strings['library.title']}
      </h1>
      <div className={libraryStyles.tools}>
        <div className={libraryStyles.search} role="search">
          <SearchIcon className={libraryStyles.searchIcon} />
          <input
            ref={search}
            type="search"
            className={libraryStyles.searchInput}
            aria-label={strings['library.search']}
            placeholder={strings['library.search']}
            value={query}
            disabled={rows.length === 0}
            onChange={(e) => changeQuery(e.currentTarget.value)}
          />
        </div>
        <span className={libraryStyles.grow} />
        <BackupRestoreButtons
          canBackUp={canBackUp}
          busy={backup !== null || restoring}
          restoring={restoring}
          restoreButton={restoreButton}
          onBackUp={backUp}
          onRestore={() => void startRestore()}
        />
      </div>
      {restoreError && <RestoreErrorBanner text={restoreError} />}
      {confirmRestore && (
        <RestoreConfirmDialog
          pending={confirmRestore}
          opener={() => restoreButton.current}
          onCancel={cancelRestore}
          onConfirm={() => confirmAndRestore(confirmRestore)}
        />
      )}
      {backup && <BackupProgress progress={backup.progress} />}
      {error && (
        <p className={libraryStyles.error} role="alert">
          <ErrorIcon className={libraryStyles.errorIcon} />
          {strings['library.loadFailed']}
        </p>
      )}
      {body}
      {rows.length > 0 && storage.usageBytes !== null && (
        <LibraryFooter takes={rows.length} usageBytes={storage.usageBytes} />
      )}
    </section>
  );
}
