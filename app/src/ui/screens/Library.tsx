// The Library screen (story "Library list (tracer)", US-7.1; mockup library.html): every take,
// newest first, from library-session. A row shows the title and status badge, date · duration ·
// note count · audio size, and the first 12 notes; it opens the take's Tab (click or Enter),
// except a take still recording. With no takes: "No takes yet" and Record.

import { useId, useSyncExternalStore, type ReactNode } from 'react';
import { formatMegabytes } from '../../model/library';
import {
  librarySession,
  type LibraryRow,
  type LibrarySession,
  type LibraryStatus,
} from '../../session/library-session';
import buttons from '../components/buttons.module.css';
import { CheckIcon, ErrorIcon } from '../components/icons';
import { formatElapsed, formatTakeDate } from '../format';
import { routeToHash } from '../router';
import { strings } from '../strings';
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

function RowBody({ row, ids }: { row: LibraryRow; ids: RowIds }) {
  return (
    <>
      <div className={libraryStyles.titleLine}>
        <span id={ids.title} className={libraryStyles.title}>
          {row.title}
        </span>
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

function Row({ row }: { row: LibraryRow }) {
  const base = useId();
  const ids: RowIds = {
    title: `${base}-title`,
    badge: `${base}-badge`,
    meta: `${base}-meta`,
    preview: `${base}-preview`,
  };
  return (
    <li className={libraryStyles.row} data-take-id={row.id}>
      {row.opens ? (
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
          <RowBody row={row} ids={ids} />
        </div>
      )}
    </li>
  );
}

export function Library({
  session = librarySession,
}: { session?: Pick<LibrarySession, 'subscribe' | 'getSnapshot'> } = {}) {
  const { loading, rows, error } = useSyncExternalStore(session.subscribe, session.getSnapshot);

  let body: ReactNode = null;
  if (rows.length > 0) {
    body = (
      <ul className={libraryStyles.list} aria-label={strings['library.listLabel']}>
        {rows.map((row) => (
          <Row key={row.id} row={row} />
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
      <h1 className={styles.title}>{strings['library.title']}</h1>
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
