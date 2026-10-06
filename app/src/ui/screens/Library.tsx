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

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { capTitle } from '../../model/title';
import { formatMegabytes } from '../../model/library';
import {
  librarySession,
  type LibraryRow,
  type LibrarySession,
  type LibraryStatus,
} from '../../session/library-session';
import buttons from '../components/buttons.module.css';
import { ConfirmDialog } from '../components/ConfirmDialog';
import {
  CheckIcon,
  DeleteIcon,
  ErrorIcon,
  MoreIcon,
  MuteIcon,
  PencilIcon,
} from '../components/icons';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';
import { formatElapsed, formatTakeDate } from '../format';
import { routeToHash } from '../router';
import { strings } from '../strings';
import { showToast } from '../toast';
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
          <span id={ids.title} className={libraryStyles.title}>
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

/** A failed write's toast (the session logged the error and corrected the row). */
const toastFailure =
  (key: 'library.renameFailed' | 'library.deleteTakeFailed' | 'library.deleteAudioFailed') => () =>
    showToast({ message: strings[key] });

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
  actions,
  onRowGone,
}: {
  row: LibraryRow;
  actions: RowActions;
  /** The row is going while focus is inside it (its take was deleted). */
  onRowGone(): void;
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
    <li ref={li} className={libraryStyles.row} data-take-id={row.id}>
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

export function Library({
  session = librarySession,
}: {
  session?: Pick<
    LibrarySession,
    'subscribe' | 'getSnapshot' | 'rename' | 'deleteTake' | 'deleteAudio'
  >;
} = {}) {
  const { loading, rows, error } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusHeading = () => heading.current?.focus();

  let body: ReactNode = null;
  if (rows.length > 0) {
    body = (
      <ul className={libraryStyles.list} aria-label={strings['library.listLabel']}>
        {rows.map((row) => (
          <Row key={row.id} row={row} actions={session} onRowGone={focusHeading} />
        ))}
      </ul>
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
      <h1 ref={heading} className={styles.title} tabIndex={-1}>
        {strings['library.title']}
      </h1>
      {error && (
        <p className={libraryStyles.error} role="alert">
          <ErrorIcon className={libraryStyles.errorIcon} />
          {strings['library.loadFailed']}
        </p>
      )}
      {body}
    </section>
  );
}
