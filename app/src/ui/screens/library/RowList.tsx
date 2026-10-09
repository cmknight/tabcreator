// The Library's take list (story "Library list (tracer)", US-7.1; mockup library.html). A row
// shows the title and status badge, date · duration · note count · audio size, and the first 12
// notes; it opens the take's Tab (click or Enter), except a take still recording.
//
// Story "Rename, delete take and delete audio" (EXPERIENCE.md Library, mockup library.html): each
// row but a recording one has a "⋯" button opening its menu (`RowMenu`): Rename (the title becomes
// a field: Enter or blur saves, Esc cancels), Delete audio only (analysed takes with audio) and
// Delete take, each delete behind a Confirm dialog (Cancel first and focused). The writes go
// through library-session. Focus returns to the row's "⋯" button after the menu, a dialog or a
// rename; when the row itself goes (deleted), `onRowGone` moves it to the screen's heading. While
// a backup or restore runs the menu's writes are disabled with its reason ("Backing up…",
// "Restoring…"); a write library-session refuses meanwhile (`LibraryBusyError`, e.g. a rename
// field blurred after Back up, story 7.17) is a toast with what to wait for, not the failure text.
//
// Story "Search 500 takes": above `VIRTUAL_ABOVE` rows the list is virtualised: only the rows in
// and near the viewport (plus any row with focus, its menu, a dialog or its rename open) are
// rendered, the gaps held by margins and padding, so scrolling reaches every row (CAP-17).
// Unrendered rows are not in the DOM, so find-in-page and a screen reader's virtual cursor do not
// reach them: the search field is the way to find a take in a long library.

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { capTitle } from '../../../model/title';
import { formatMegabytes } from '../../../model/library';
import type { LibraryRow, LibrarySession, LibraryStatus } from '../../../session/library-session';
import buttons from '../../components/buttons.module.css';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { CheckIcon, DeleteIcon, MoreIcon, MuteIcon, PencilIcon } from '../../components/icons';
import { RowMenu, type RowMenuItem } from '../../components/RowMenu';
import { formatElapsed, formatTakeDate } from '../../format';
import { routeToHash } from '../../router';
import { strings } from '../../strings';
import libraryStyles from '../Library.module.css';
import { toastFailure } from './feedback';

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
export type RowActions = Pick<LibrarySession, 'rename' | 'deleteTake' | 'deleteAudio'>;

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

/**
 * The take list. Up to `VIRTUAL_ABOVE` rows: every row. Above: the rows from just above to just
 * below the viewport (`OVERSCAN` each side), plus any row holding focus or busy (menu, dialog,
 * rename) wherever it is; each rendered row's top margin stands for the unrendered rows before
 * it and the list's bottom padding for those after the last, so the list keeps its full height.
 * Every row has the same height (one-line title, metadata and preview), measured once rendered.
 */
export function RowList({
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
