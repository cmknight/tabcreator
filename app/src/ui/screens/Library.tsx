// The Library screen (story "Library list (tracer)", US-7.1; mockup library.html): every take,
// newest first, from library-session. A row shows the title and status badge, date · duration ·
// note count · audio size, and the first 12 notes; it opens the take's Tab (click or Enter),
// except a take still recording. With no takes: "No takes yet" and Record.
//
// Story "Rename, delete take and delete audio" (EXPERIENCE.md Library, mockup library.html): each
// row but a recording one has a "⋯" button opening its menu (`RowMenu`): Rename (the title becomes
// a field: Enter or blur saves, Esc cancels), Delete audio only (analysed takes with audio) and
// Delete take, each delete behind a Confirm dialog (Cancel first and focused). The writes go
// through library-session. Focus returns to the row's "⋯" button after the menu, a dialog or a
// rename; when the row itself goes (deleted), it moves to the screen's heading.
//
// Story "Search 500 takes" (EXPERIENCE.md Search, mockup library.html "libtools"): the Search
// takes field filters the rows by title as you type, ignoring case and accents (model/library
// `filterRows`); no match shows "No takes match …" and Clear search; the result count is announced
// once typing settles. Above `VIRTUAL_ABOVE` rows the list is virtualised: only the rows in and
// near the viewport (plus any row with focus, its menu, a dialog or its rename open) are rendered,
// the gaps held by margins and padding, so scrolling reaches every row (CAP-17). Unrendered rows
// are not in the DOM, so find-in-page and a screen reader's virtual cursor do not reach them:
// the search field is the way to find a take in a long library.
//
// Story "Back up the library" (US-7.3; EXPERIENCE.md :85, mockup library.html (f·1)): Back up
// library, beside the search, builds the backup zip through library-session (in a worker) while
// "Backing up…" and a progress bar show under the header; then the browser downloads
// `tabcreator-backup-YYYYMMDD.zip` (ui/platform.ts). The button is disabled unless a take not
// still recording exists, and while a backup runs; there is no Cancel. Meanwhile the row menus'
// Rename and deletes are disabled ("Backing up…"). The start and the takes backed up are
// announced politely; missing or unsupported audio and a failure are toasts, the failure also
// announced assertively.
//
// Story "Restore from a backup" (US-7.3, Flow 4; EXPERIENCE.md :85, :115, :117, mockup
// library.html (f·2)): Restore from backup, after Back up library, is enabled even with an empty
// library. It picks a .zip (ui/platform.ts), has library-session read and check it in full
// (nothing written), then a Confirm dialog ("Restore 3 takes from <file>?", counting the takes
// not already present, Cancel first) imports them; with none new there is no dialog, just the
// summary. Meanwhile the button reads "Restoring…" and is
// aria-disabled, Back up library too, and the row menus' writes are paused ("Restoring…"). The
// summary ("Imported 2 takes, skipped 1 already in your library") is a toast and a polite
// announcement; the list refreshes through `library-restored`. An invalid file, or a failed
// write, shows an error banner (announced assertively) until the next restore attempt or leaving
// the Library; nothing was changed. Cancelling the picker or the dialog changes nothing. Story
// "Streaming restore and restore races": a failed restore whose rollback could not remove every
// file it wrote (`RestoreLeftFilesError`) says so instead ("some files were left behind…").
//
// Story "Storage protection and Library states" (6.7, CAP-19, CAP-25; mockup library.html (d),
// (e), .libfoot): above the heading, the one-time storage notice (a warning banner, role status,
// when the browser has not persisted storage: Back up library starts the backup, Dismiss hides it
// for this visit; showing it sets `prefs.persistNoticeShown` through the session, so no later
// visit shows it) and the storage-full banner (`StorageFullBannerView`: no role, no Dismiss and no
// link, announced assertively once per showing; shown while storage/persistence.ts's one status
// is set, which only freed space clears). After the list, the footer: "23 takes · 41.0 MB
// used", the whole library's count even while searching, with no footer for an empty library or
// an unknown usage.
//
// Story "Library robustness during backup and restore" (7.17): a row write library-session refuses
// while a backup or restore runs (`LibraryBusyError`, e.g. a rename field blurred after Back up)
// is a toast with its reason ("Wait for the backup to finish"), not the failure text. A backup
// that finished after the player left the Library shows a global toast then ("Backup ready —
// download it from the Library") and, on the next visit, the "Your backup is ready" banner with
// its take count and time (Download, Dismiss; announced once, no role, as the storage-full
// banner; hidden while a newer backup runs). A file chosen after the picker already settled null
// (its fallback) still starts the restore (`onLate`), or, while a backup or restore runs, is
// refused with the same toast. Restore always opens a new picker, superseding one still open.

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { capTitle } from '../../model/title';
import { filterRows, formatMegabytes } from '../../model/library';
import { isAppError } from '../../model/errors';
import {
  librarySession,
  RestoreLeftFilesError,
  type BackupResult,
  type LibraryBusyReason,
  type LibraryRow,
  type LibrarySession,
  type LibraryStatus,
  type PendingDownload,
  type RestorePlan,
} from '../../session/library-session';
import { announce } from '../a11y/announcer';
import buttons from '../components/buttons.module.css';
import { ConfirmDialog } from '../components/ConfirmDialog';
import {
  BackupIcon,
  CheckIcon,
  DeleteIcon,
  ErrorIcon,
  MoreIcon,
  MuteIcon,
  PencilIcon,
  RestoreIcon,
  SearchIcon,
  WarnIcon,
} from '../components/icons';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';
import { StorageFullBannerView } from '../components/StorageFullBannerView';
import { formatClockTime, formatElapsed, formatTakeDate } from '../format';
import { downloadBlob, pickFile } from '../platform';
import { routeToHash } from '../router';
import { strings } from '../strings';
import { showToast } from '../toast';
import banner from '../components/banner.module.css';
import libraryStyles from './Library.module.css';
import styles from './Screen.module.css';

const STATUS_LABEL: Record<LibraryStatus, string> = {
  recording: strings['library.statusRecording'],
  recorded: strings['library.statusNotAnalysed'],
  analyzed: strings['library.statusAnalysed'],
};

function StatusBadge({ status, id }: { status: LibraryStatus; id: string }) {
  const analysed = status === 'analyzed';
  return (
    <span id={id} className={`${libraryStyles.badge} ${analysed ? libraryStyles.badgeOk : ''}`}>
      {analysed && <CheckIcon className={libraryStyles.badgeIcon} />}
      {STATUS_LABEL[status]}
    </span>
  );
}

function RowMeta({ row, id }: { row: LibraryRow; id: string }) {
  const parts: ReactNode[] = [formatTakeDate(row.createdAt)];
  // A take still recording has no duration yet (it is stored at stop).
  if (row.status !== 'recording') {
    parts.push(
      <span key="duration" className={libraryStyles.num}>
        {formatElapsed(row.durationMs)}
      </span>,
    );
  }
  if (row.noteCount !== null) parts.push(strings['library.notes'](row.noteCount));
  if (row.audioDeleted) parts.push(strings['library.audioDeleted']);
  else if (row.sizeBytes !== null) {
    parts.push(strings['library.size'](formatMegabytes(row.sizeBytes)));
  }
  return (
    <div id={id} className={libraryStyles.meta}>
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 && strings['library.metaSeparator']}
          {part}
        </span>
      ))}
    </div>
  );
}

interface RowIds {
  title: string;
  badge: string;
  meta: string;
  preview: string;
}

function RowBody({ row, ids, title }: { row: LibraryRow; ids: RowIds; title?: ReactNode }) {
  return (
    <>
      <div className={libraryStyles.titleLine}>
        {title ?? (
          <span id={ids.title} className={libraryStyles.title} title={row.title}>
            {row.title}
          </span>
        )}
        <StatusBadge status={row.status} id={ids.badge} />
      </div>
      <RowMeta row={row} id={ids.meta} />
      <div
        id={ids.preview}
        className={`${libraryStyles.preview} ${row.preview === null ? libraryStyles.previewNone : ''}`}
      >
        {row.preview ?? strings['library.noPreview']}
      </div>
    </>
  );
}

/** The library-session writes a row's menu uses. */
type RowActions = Pick<LibrarySession, 'rename' | 'deleteTake' | 'deleteAudio'>;

/**
 * A failed write's toast (the session logged the error and corrected the row); a write refused
 * while a backup or restore runs says what to wait for instead (nothing was changed).
 */
const toastFailure =
  (key: 'library.renameFailed' | 'library.deleteTakeFailed' | 'library.deleteAudioFailed') =>
  (err: unknown) => {
    if (isAppError(err) && err.code === 'library-busy') {
      const reason = (err as { reason?: unknown }).reason;
      toastBusy(reason === 'restore' ? 'restore' : 'backup');
    } else {
      showToast({ message: strings[key] });
    }
  };

/** The toast for something refused while a backup or restore runs: what to wait for. */
function toastBusy(reason: LibraryBusyReason) {
  showToast({
    message: strings[reason === 'backup' ? 'library.busyBackup' : 'library.busyRestore'],
  });
}

/** The ready banner's text: "Your backup is ready — 3 takes, made at 9:14 pm". */
const readyText = (pending: PendingDownload) =>
  strings['library.backupReady'](
    pending.result.takes,
    formatClockTime(new Date(pending.finishedAt)),
  );

/**
 * Downloads a finished backup and says so: "Backed up N takes" announced, and a toast for any
 * missing, unsupported or unfinished takes.
 */
function deliverBackup(result: BackupResult) {
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

/**
 * The inline rename field: focused with its text selected. Enter or blur saves, Esc cancels
 * (an Enter ending an IME composition does not save); `onDone` then says whether focus goes
 * back to the "⋯" button (Enter, Esc) or stays where the player put it (blur). Only an edited
 * draft is saved (an untouched field never writes its old title over a newer rename), trimmed
 * and capped at `TITLE_MAX` then.
 */
function RenameField({
  initial,
  onSave,
  onDone,
}: {
  initial: string;
  onSave(title: string): void;
  onDone(returnFocus: boolean): void;
}) {
  const [draft, setDraft] = useState(initial);
  const [edited, setEdited] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  /** Set once finished, so the blur from unmounting the field does not save again. */
  const finished = useRef(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  function finish(save: boolean, returnFocus: boolean) {
    if (finished.current) return;
    finished.current = true;
    if (save && edited) onSave(capTitle(draft.trim()));
    onDone(returnFocus);
  }

  return (
    <input
      ref={input}
      className={libraryStyles.titleInput}
      type="text"
      aria-label={strings['library.titleField']}
      value={draft}
      onChange={(e) => {
        setDraft(e.currentTarget.value);
        setEdited(true);
      }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true, true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(false, true);
        }
      }}
      onBlur={() => finish(true, false)}
    />
  );
}

type Confirming = 'delete-take' | 'delete-audio' | null;

function Row({
  row,
  pos,
  size,
  gapPx,
  actions,
  pausedBy,
  onRowGone,
  onBusy,
}: {
  row: LibraryRow;
  /** The row's position in the shown list (from 1) and the list's length (`aria-posinset`/`setsize`). */
  pos: number;
  size: number;
  /** The virtual list's space before the row, for the unrendered rows above it (0: none). */
  gapPx: number;
  actions: RowActions;
  /** A backup or restore is running (what it shows, "Backing up…"): the writes wait. */
  pausedBy: string | null;
  /** The row is going while focus is inside it (its take was deleted). */
  onRowGone(): void;
  /** The row's menu, a dialog or its rename opened (true) or closed (false): keep it rendered. */
  onBusy(id: string, busy: boolean): void;
}) {
  const base = useId();
  const ids: RowIds = {
    title: `${base}-title`,
    badge: `${base}-badge`,
    meta: `${base}-meta`,
    preview: `${base}-preview`,
  };
  const li = useRef<HTMLLIElement>(null);
  const kebab = useRef<HTMLButtonElement>(null);
  /** The "⋯" button while the menu is open. */
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  /** Whether focus goes back to the "⋯" button once the rename field is gone. */
  const refocus = useRef(false);

  const busy = menuAnchor !== null || editing || confirming !== null;
  useEffect(() => {
    if (!busy) return;
    onBusy(row.id, true);
    return () => onBusy(row.id, false);
  }, [busy, row.id, onBusy]);

  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    kebab.current?.focus();
  }, [editing]);

  // A row removed with focus inside it hands focus on (the element is still attached here).
  const gone = useRef(onRowGone);
  useLayoutEffect(() => {
    gone.current = onRowGone;
  });
  /** Set as the row goes: its open menu or dialog then hands focus back to nothing. */
  const removing = useRef(false);
  /** Where an open menu or dialog returns focus: the "⋯" button, unless the row is going. */
  const returnFocus = () => (removing.current ? null : kebab.current);
  // React runs this before the menu's or dialog's own release, with the row still attached.
  useLayoutEffect(() => {
    const el = li.current;
    removing.current = false;
    return () => {
      removing.current = true;
      if (el?.contains(document.activeElement)) gone.current();
    };
  }, []);

  const items: RowMenuItem[] = [
    {
      id: 'rename',
      label: strings['library.rename'],
      icon: <PencilIcon />,
    },
  ];
  // Only an analysed take, which keeps its tab, can lose its audio alone (one already deleted
  // has none to lose).
  if (row.status === 'analyzed' && !row.audioDeleted) {
    items.push({ id: 'delete-audio', label: strings['library.deleteAudio'], icon: <MuteIcon /> });
  }
  items.push({
    id: 'delete-take',
    label: strings['library.deleteTake'],
    icon: <DeleteIcon />,
    danger: true,
    separated: true,
  });
  // No write while a backup reads the library (the zip would not match what the player sees) or
  // a restore writes it.
  if (pausedBy !== null) {
    for (const item of items) item.disabledReason = pausedBy;
  }

  function choose(id: string) {
    if (id === 'rename') setEditing(true);
    else if (id === 'delete-take' || id === 'delete-audio') setConfirming(id);
  }

  const titleField = editing ? (
    <RenameField
      initial={row.title}
      onSave={(title) => {
        actions.rename(row.id, title).catch(toastFailure('library.renameFailed'));
      }}
      onDone={(returnFocus) => {
        refocus.current = returnFocus;
        setEditing(false);
      }}
    />
  ) : undefined;

  return (
    <li
      ref={li}
      className={libraryStyles.row}
      data-take-id={row.id}
      aria-posinset={pos}
      aria-setsize={size}
      style={gapPx > 0 ? { marginBlockStart: gapPx } : undefined}
    >
      {row.opens && !editing ? (
        // Named by the title alone; the badge, metadata and preview describe it.
        <a
          className={libraryStyles.main}
          href={routeToHash({ name: 'tab', takeId: row.id })}
          aria-labelledby={ids.title}
          aria-describedby={`${ids.badge} ${ids.meta} ${ids.preview}`}
        >
          <RowBody row={row} ids={ids} />
        </a>
      ) : (
        <div className={libraryStyles.main}>
          <RowBody row={row} ids={ids} title={titleField} />
        </div>
      )}
      {row.status !== 'recording' && (
        <button
          ref={kebab}
          type="button"
          className={`${buttons.secondary} ${buttons.toggle} ${libraryStyles.kebab}`}
          aria-label={strings['library.more'](row.title)}
          aria-haspopup="menu"
          aria-expanded={menuAnchor !== null}
          aria-controls={menuAnchor ? `${base}-menu` : undefined}
          onClick={(e) => {
            const button = e.currentTarget;
            setMenuAnchor((open) => (open ? null : button));
          }}
        >
          <MoreIcon className={libraryStyles.kebabIcon} />
        </button>
      )}
      {menuAnchor && (
        <RowMenu
          label={strings['library.menu'](row.title)}
          items={items}
          id={`${base}-menu`}
          anchor={menuAnchor}
          returnFocusTo={returnFocus}
          onSelect={choose}
          onClose={() => setMenuAnchor(null)}
        />
      )}
      {confirming === 'delete-take' && (
        <ConfirmDialog
          title={strings['library.deleteTakeTitle'](row.title)}
          body={strings['library.deleteTakeBody']}
          confirmLabel={strings['library.deleteTakeConfirm']}
          danger
          opener={returnFocus}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null);
            actions.deleteTake(row.id).catch(toastFailure('library.deleteTakeFailed'));
          }}
        />
      )}
      {confirming === 'delete-audio' && (
        <ConfirmDialog
          title={strings['library.deleteAudioTitle'](row.title)}
          body={strings['library.deleteAudioBody']}
          confirmLabel={strings['library.deleteAudioConfirm']}
          danger
          opener={returnFocus}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null);
            actions.deleteAudio(row.id).catch(toastFailure('library.deleteAudioFailed'));
          }}
        />
      )}
    </li>
  );
}

/** Lists longer than this are virtualised (only rows in and near the viewport are rendered). */
export const VIRTUAL_ABOVE = 100;
/** Rows rendered beyond each edge of the viewport in a virtualised list. */
export const OVERSCAN = 10;
/** A row's height before one has been measured (and where layout gives none, as in jsdom). */
const ROW_PX_GUESS = 80;
/** How long typing must pause before the result count is announced. */
export const ANNOUNCE_AFTER_MS = 500;

/**
 * The take list. Up to `VIRTUAL_ABOVE` rows: every row. Above: the rows from just above to just
 * below the viewport (`OVERSCAN` each side), plus any row holding focus or busy (menu, dialog,
 * rename) wherever it is; each rendered row's top margin stands for the unrendered rows before
 * it and the list's bottom padding for those after the last, so the list keeps its full height.
 * Every row has the same height (one-line title, metadata and preview), measured once rendered.
 */
function RowList({
  rows,
  actions,
  pausedBy,
  onRowGone,
}: {
  rows: readonly LibraryRow[];
  actions: RowActions;
  pausedBy: string | null;
  onRowGone(): void;
}) {
  const n = rows.length;
  const virtual = n > VIRTUAL_ABOVE;
  const list = useRef<HTMLUListElement>(null);
  const [rowPx, setRowPx] = useState(ROW_PX_GUESS);
  /** The rows in and near the viewport: [start, end). */
  const [range, setRange] = useState<readonly [number, number]>([0, 0]);
  /** Rows to keep rendered: busy ones and the one with focus. */
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const onBusy = useCallback((id: string, busy: boolean) => {
    setBusyIds((prev) => {
      if (prev.has(id) === busy) return prev;
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const updateRange = useCallback(() => {
    const ul = list.current;
    if (!ul) return;
    const top = ul.getBoundingClientRect().top;
    const first = Math.floor(-top / rowPx) - OVERSCAN;
    const last = Math.ceil((window.innerHeight - top) / rowPx) + OVERSCAN;
    const start = Math.min(n, Math.max(0, first));
    const end = Math.min(n, Math.max(start, last));
    setRange((r) => (r[0] === start && r[1] === end ? r : [start, end]));
  }, [n, rowPx]);

  /**
   * Measures a row (any but the first, which has no top border; the smallest of a few), with
   * fractional pixels.
   */
  const measureRow = useCallback(() => {
    const ul = list.current;
    if (!ul) return;
    let px = Infinity;
    for (const li of Array.from(ul.children).slice(1, 6)) {
      const h = li.getBoundingClientRect().height;
      if (h > 0) px = Math.min(px, h);
    }
    if (px !== Infinity) setRowPx((old) => (Math.abs(px - old) >= 0.5 ? px : old));
  }, []);

  // The range follows scrolling, the window's size and any layout change that resizes the list
  // or moves it (a banner above it, a narrower window).
  useLayoutEffect(() => {
    if (!virtual) return;
    updateRange();
    window.addEventListener('scroll', updateRange, { passive: true });
    window.addEventListener('resize', updateRange);
    const resized =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            measureRow();
            updateRange();
          });
    if (list.current) resized?.observe(list.current);
    resized?.observe(document.body);
    return () => {
      window.removeEventListener('scroll', updateRange);
      window.removeEventListener('resize', updateRange);
      resized?.disconnect();
    };
  }, [virtual, updateRange, measureRow]);

  // Measures once rendered, and again when the rendered rows change.
  useLayoutEffect(() => {
    if (virtual) measureRow();
  }, [virtual, measureRow, n, range]);

  let indices: number[];
  if (virtual) {
    const start = Math.min(range[0], n);
    const end = Math.min(range[1], n);
    const keep = new Set<number>();
    for (let i = start; i < end; i++) keep.add(i);
    for (const id of focusedId === null ? busyIds : [...busyIds, focusedId]) {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) keep.add(i);
    }
    indices = [...keep].sort((a, b) => a - b);
  } else {
    indices = rows.map((_, i) => i);
  }
  const lastIndex = indices.length > 0 ? indices[indices.length - 1]! : -1;

  return (
    // `role="list"`: a list styled without markers keeps its list semantics in every browser.
    <ul
      ref={list}
      role="list"
      className={libraryStyles.list}
      aria-label={strings['library.listLabel']}
      style={virtual ? { paddingBlockEnd: (n - 1 - lastIndex) * rowPx } : undefined}
      onFocus={(e) => {
        const li = (e.target as Element).closest<HTMLElement>('li[data-take-id]');
        setFocusedId(li?.dataset.takeId ?? null);
      }}
      onBlur={(e) => {
        // The window losing focus (another app, a devtools click) keeps the row: focus comes
        // back to it.
        if (e.relatedTarget === null && !document.hasFocus()) return;
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusedId(null);
      }}
    >
      {indices.map((i, k) => {
        const row = rows[i]!;
        const before = k === 0 ? i : i - indices[k - 1]! - 1;
        return (
          <Row
            key={row.id}
            row={row}
            pos={i + 1}
            size={n}
            gapPx={virtual ? before * rowPx : 0}
            actions={actions}
            pausedBy={pausedBy}
            onRowGone={onRowGone}
            onBusy={onBusy}
          />
        );
      })}
    </ul>
  );
}

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
  const backUp = () => {
    if (!canBackUp || backup || restoring) return;
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
  /** A checked backup waiting for the Confirm dialog, with its file's name. */
  const [confirmRestore, setConfirmRestore] = useState<{
    plan: RestorePlan;
    fileName: string;
  } | null>(null);
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
    if (backup || restoring) return;
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

  const backupPercent =
    backup && strings['library.backupPercent'](Math.floor(backup.progress * 100 + 1e-9));

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
            aria-disabled={!canBackUp || backup !== null || restoring || undefined}
            onClick={backUp}
          >
            {strings['library.backUp']}
          </button>
          <button
            type="button"
            className={libraryStyles.dismiss}
            aria-label={strings['library.persistNoticeDismiss']}
            onClick={() => {
              // The button goes with the banner: focus moves to the heading first.
              focusHeading();
              setNoticeDismissed(true);
            }}
          >
            {strings['global.dismiss']}
          </button>
        </div>
      )}
      {ready && (
        <div
          className={`${banner.banner} ${banner.warning} ${libraryStyles.topBanner}`}
          data-testid="backup-ready"
        >
          <BackupIcon className={banner.icon} />
          <p className={banner.text}>{readyText(ready)}</p>
          <button
            type="button"
            className={libraryStyles.noticeAction}
            onClick={() => {
              // The button goes with the banner: focus moves to the heading first.
              focusHeading();
              deliverBackup(ready.result);
              session.clearPendingDownload(ready);
            }}
          >
            {strings['library.backupReadyDownload']}
          </button>
          <button
            type="button"
            className={libraryStyles.dismiss}
            onClick={() => {
              focusHeading();
              session.clearPendingDownload(ready);
            }}
          >
            {strings['global.dismiss']}
          </button>
        </div>
      )}
      {storage.full && (
        <StorageFullBannerView
          text={strings['global.storageFull']}
          className={libraryStyles.topBanner}
          testId="library-storage-full"
          link={false}
        />
      )}
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
        {/* Native disabled with nothing to back up (no take but recording ones); aria-disabled
            while a backup runs, so focus stays. */}
        <button
          type="button"
          className={`${buttons.secondary} ${libraryStyles.backup}`}
          disabled={!canBackUp}
          aria-disabled={backup !== null || restoring || undefined}
          onClick={backUp}
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
          aria-disabled={backup !== null || restoring || undefined}
          onClick={() => void startRestore()}
        >
          <RestoreIcon className={buttons.icon} />
          {restoring ? strings['library.restoring'] : strings['library.restore']}
        </button>
      </div>
      {restoreError && (
        <div
          className={`${banner.banner} ${banner.error} ${libraryStyles.restoreBanner}`}
          data-testid="restore-error"
        >
          <ErrorIcon className={banner.icon} />
          <p className={banner.text}>{restoreError}</p>
        </div>
      )}
      {confirmRestore && (
        <ConfirmDialog
          title={strings['library.restoreTitle'](
            confirmRestore.plan.toImport,
            confirmRestore.fileName,
          )}
          body={strings['library.restoreBody'](confirmRestore.plan.toSkip)}
          confirmLabel={strings['library.restoreConfirm']}
          opener={() => restoreButton.current}
          onCancel={() => setConfirmRestore(null)}
          onConfirm={() => {
            setConfirmRestore(null);
            runRestore(confirmRestore.plan);
          }}
        />
      )}
      {backup && (
        <div className={libraryStyles.progressPanel} data-testid="backup-progress">
          <label className={libraryStyles.progressLabel} htmlFor="library-backup-progress">
            {strings['library.backingUp']}
          </label>
          <div className={libraryStyles.progressRow}>
            <progress
              id="library-backup-progress"
              className={libraryStyles.progress}
              max={1}
              value={backup.progress}
              aria-valuetext={backupPercent ?? undefined}
            />
            <span className={libraryStyles.percent}>{backupPercent}</span>
          </div>
        </div>
      )}
      {error && (
        <p className={libraryStyles.error} role="alert">
          <ErrorIcon className={libraryStyles.errorIcon} />
          {strings['library.loadFailed']}
        </p>
      )}
      {body}
      {rows.length > 0 && storage.usageBytes !== null && (
        <footer className={libraryStyles.footer} data-testid="library-footer">
          {strings['library.footer'](rows.length, formatMegabytes(storage.usageBytes))}
        </footer>
      )}
    </section>
  );
}
