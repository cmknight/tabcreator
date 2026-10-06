// The Library row model (story "Library list (tracer)", US-7.1, EXPERIENCE.md Library row). Pure:
// library-session builds one row per take from the take, its Tab and its compressed file size;
// the Library screen words and lays it out. Stories 6.2, 6.3, 6.5–6.7 build on `LibraryRow`.

import { foldLatin } from './fold';
import { playedOrder, visibleNotes } from './notes';
import { STRING_LETTERS } from './tab-render';
import { preferredExtensions, type AudioExtension } from './audio-format';
import type { Note, Tab, Take, TakeStatus } from './types';

/**
 * The row's status badge: the take's status (`recording`, `recorded`, `analyzed`), shown as
 * Recording, Not analysed or Analysed.
 */
export type LibraryStatus = TakeStatus;

/** How many notes the preview shows. */
export const PREVIEW_NOTES = 12;

export interface LibraryRow {
  id: string;
  title: string;
  /** `searchKey(title)`: the title folded for search (story 6.3); set with the title (`withTitle`). */
  searchKey: string;
  /** ISO 8601, as stored; the sort key (newest first). */
  createdAt: string;
  status: LibraryStatus;
  durationMs: number;
  /** The visible notes (inside the trim); null before analysis; 0 for an analysed take without a Tab. */
  noteCount: number | null;
  /** The compressed file's byte size; null for a recording take, deleted audio or no file. */
  sizeBytes: number | null;
  /** `audioMime` is null (Delete audio only); never set on a recording take. */
  audioDeleted: boolean;
  /**
   * The first 12 visible notes in played order as `string|fret` pairs ("E|3 A|0 …", with a
   * trailing "…" when more follow); null when there are none or no analysis (shown as "—").
   */
  preview: string | null;
  /** Whether the row opens the take's Tab (`#/tab/{id}`); a recording take does not. */
  opens: boolean;
}

/** The preview text for notes already in the order they are shown. */
export function notePreview(notes: readonly Note[]): string | null {
  if (notes.length === 0) return null;
  const pairs = notes
    .slice(0, PREVIEW_NOTES)
    .map((n) => `${STRING_LETTERS[n.string - 1] ?? '?'}|${n.fret}`);
  if (notes.length > PREVIEW_NOTES) pairs.push('…');
  return pairs.join(' ');
}

/** One row. `tab` is the take's Tab or null; `sizeBytes` its compressed file's size or null. */
export function libraryRow(take: Take, tab: Tab | null, sizeBytes: number | null): LibraryRow {
  const status: LibraryStatus = take.status;
  const recording = status === 'recording';
  const notes =
    status === 'analyzed' ? (tab ? playedOrder(visibleNotes(tab.notes, take)) : []) : null;
  const audioDeleted = !recording && take.audioMime === null;
  return {
    id: take.id,
    title: take.title,
    searchKey: searchKey(take.title),
    createdAt: take.createdAt,
    status,
    durationMs: take.durationMs,
    noteCount: notes ? notes.length : null,
    sizeBytes: recording || audioDeleted ? null : sizeBytes,
    audioDeleted,
    preview: notes ? notePreview(notes) : null,
    opens: !recording,
  };
}

/**
 * Text folded for search (story "Search 500 takes", EXPERIENCE.md Search): `foldLatin` (accents
 * stripped, lowercased without the locale, ß ø æ œ ł đ folded), so "Café" and "CAFE" both give
 * "cafe" and "Øresund" gives "oresund".
 */
export function searchKey(text: string): string {
  return foldLatin(text);
}

/** `row` with a new title (and its search key); `row` itself when the title is unchanged. */
export function withTitle(row: LibraryRow, title: string): LibraryRow {
  return title === row.title ? row : { ...row, title, searchKey: searchKey(title) };
}

/**
 * The rows whose title contains `query` (trimmed), ignoring case and accents (`searchKey` on both
 * sides), in their order; every row (the same array) for an empty or whitespace-only query.
 */
export function filterRows(rows: readonly LibraryRow[], query: string): readonly LibraryRow[] {
  const key = searchKey(query.trim());
  if (key === '') return rows;
  return rows.filter((r) => r.searchKey.includes(key));
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Newest first by `createdAt` (compared as stored ISO strings, as the database's `createdAt`
 * index orders them); equal times by id, so the order is stable.
 */
export function compareRows(a: LibraryRow, b: LibraryRow): number {
  return cmp(b.createdAt, a.createdAt) || cmp(a.id, b.id);
}

/** A sorted copy: newest first. */
export function sortRows(rows: readonly LibraryRow[]): LibraryRow[] {
  return [...rows].sort(compareRows);
}

/**
 * A byte size in decimal megabytes to one place, as the row shows it before " MB": 210 000
 * bytes is "0.2"; any non-empty file shows at least "0.1".
 */
export function formatMegabytes(bytes: number): string {
  if (bytes <= 0) return '0.0';
  return Math.max(0.1, Math.round(bytes / 100_000) / 10).toFixed(1);
}

/**
 * The size to show for a take from its compressed files (normally one): the file matching the
 * take's `audioMime`, else the first in `AUDIO_FORMATS` order; null with none.
 */
export function pickSize(
  files: readonly { ext: AudioExtension; size: number }[],
  audioMime: string | null,
): number | null {
  for (const ext of preferredExtensions(audioMime)) {
    const file = files.find((f) => f.ext === ext);
    if (file) return file.size;
  }
  return null;
}
