// Tab text layout (story "Tab layout and text", US-6.1, CAP-12, CAP-24): turns notes into six-line
// ASCII tab systems for the Tab screen and the .txt export. Notes in played order, spacing
// roughly proportional to time, optional bar lines from the count-in tempo, wrapped to a width.
// Pure: times are take time, untrimmed, so bar lines never move with a trim.

import type { Note, StringNo, Take } from './types';

/** One note's place in a system: `col` is the 0-based index into the line, prefix included. */
export interface TabCell {
  noteId: string;
  col: number;
  /** The fret digits' width: 1 or 2. */
  width: number;
  string: StringNo;
}

/** Six lines of tab: `lines[0]` is `e` (string 1) and `lines[5]` is `E` (string 6). */
export interface TabSystem {
  lines: string[];
  cells: TabCell[];
  /** The column of each drawn bar-line `|` (the system's edges excluded). */
  barCols: number[];
}

export interface TabLayout {
  systems: TabSystem[];
}

/** Line letters, string 1 (high e) first. */
const LETTERS = ['e', 'B', 'G', 'D', 'A', 'E'] as const;
/** Milliseconds per spacing dash. */
const MS_PER_DASH = 125;
const MAX_DASHES = 8;
/** `x|-` before the content plus `---|` after it. */
const LINE_OVERHEAD = 3 + 4;
const LINE_END = '---|';

type Unit =
  | { kind: 'note'; note: Note; digits: string; spacing: number; width: number }
  | { kind: 'bar'; width: 2 };

function spacingFor(ioi: number | null): number {
  if (ioi === null) return 1;
  return Math.min(MAX_DASHES, Math.max(1, Math.round(ioi / MS_PER_DASH)));
}

/** Highest tempo taken as a count-in; anything not finite or outside (0, 1000] means none. */
const MAX_COUNT_IN_BPM = 1000;

function hasCountIn(countInBpm: number | undefined): countInBpm is number {
  return (
    countInBpm !== undefined &&
    Number.isFinite(countInBpm) &&
    countInBpm > 0 &&
    countInBpm <= MAX_COUNT_IN_BPM
  );
}

/** The note and bar-line units in played order (bar lines only with a count-in tempo). */
function buildUnits(notes: readonly Note[], countInBpm: number | undefined): Unit[] {
  const sorted = notes
    .map((note, i) => ({ note, i }))
    .sort((a, b) => a.note.startMs - b.note.startMs || a.i - b.i)
    .map(({ note }) => note);
  const barMs = hasCountIn(countInBpm) ? (4 * 60000) / countInBpm : null;
  const units: Unit[] = [];
  let nextBar = 1;
  sorted.forEach((note, i) => {
    if (barMs !== null) {
      // A note starting exactly on a boundary comes after its bar line.
      while (nextBar * barMs <= note.startMs) {
        units.push({ kind: 'bar', width: 2 });
        nextBar += 1;
      }
    }
    const next = sorted[i + 1];
    const spacing = spacingFor(next === undefined ? null : next.startMs - note.startMs);
    const digits = String(note.fret);
    units.push({ kind: 'note', note, digits, spacing, width: digits.length + spacing });
  });
  return units;
}

/**
 * Splits the units into systems whose content fits `available`. At each break exactly one bar
 * line is dropped (the system edge stands in for it): a system never ends with a bar line, and
 * any other bar lines of the run carry to the start of the next system, so empty bars stay visible.
 */
function packUnits(units: readonly Unit[], available: number): Unit[][] {
  const systems: Unit[][] = [];
  let start = 0;
  while (start < units.length) {
    // Grow the system until a unit does not fit; until it holds a note, anything goes in.
    let end = start;
    let used = 0;
    let hasNote = false;
    let lastBarInLastThird = -1;
    for (let unit = units[end]; unit !== undefined; unit = units[end]) {
      if (hasNote && used + unit.width > available) break;
      if (unit.kind === 'bar' && hasNote && used >= (available * 2) / 3) lastBarInLastThird = end;
      if (unit.kind === 'note') hasNote = true;
      used += unit.width;
      end += 1;
    }
    if (end < units.length && lastBarInLastThird >= 0) end = lastBarInLastThird;
    // Never end a system with a bar line: trailing bars carry to the next system.
    while (end < units.length && units[end - 1]?.kind === 'bar') end -= 1;
    systems.push(units.slice(start, end));
    start = end;
    // The break falls on a bar line: drop it.
    if (units[start]?.kind === 'bar') start += 1;
  }
  return systems;
}

function renderSystem(units: readonly Unit[]): TabSystem {
  const lines = LETTERS.map((letter) => `${letter}|-`);
  const cells: TabCell[] = [];
  const barCols: number[] = [];
  let col = 3; // after `x|-`
  for (const unit of units) {
    if (unit.kind === 'bar') {
      barCols.push(col);
      for (let s = 0; s < 6; s += 1) lines[s] += '|-';
      col += 2;
      continue;
    }
    const { note, digits, spacing } = unit;
    const row = note.string - 1;
    const gap = '-'.repeat(spacing);
    for (let s = 0; s < 6; s += 1) {
      lines[s] += (s === row ? digits : '-'.repeat(digits.length)) + gap;
    }
    cells.push({ noteId: note.id, col, width: digits.length, string: note.string });
    col += unit.width;
  }
  return { lines: lines.map((line) => line + LINE_END), cells, barCols };
}

/**
 * Lays notes out as tab systems of six lines no wider than `widthChars` (a single note wider
 * than that still gets a system of its own). Notes go in `startMs` order; after each comes
 * `clamp(round(gap / 125), 1, 8)` dashes (the last note gets one). With `countInBpm` > 0, a bar
 * line is drawn at every 4-beat boundary up to the last note's start; a bar line at a wrap is
 * dropped, and wraps prefer a bar line in the system's last third.
 */
export function layoutTab(
  notes: readonly Note[],
  widthChars: number,
  countInBpm?: number,
): TabLayout {
  const units = buildUnits(notes, countInBpm);
  if (units.length === 0) {
    return {
      systems: [
        { lines: LETTERS.map((letter) => `${letter}|-${LINE_END}`), cells: [], barCols: [] },
      ],
    };
  }
  const available = widthChars - LINE_OVERHEAD;
  return { systems: packUnits(units, available).map(renderSystem) };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `YYYY-MM-DD HH:mm` in local time. */
function formatRecorded(iso: string): string {
  const d = new Date(iso);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  );
}

/**
 * The .txt export: a header (title, tuning, local recording time), a blank line, then the tab
 * at 80 characters per line with bar lines when the take had a count-in, systems separated by
 * one blank line. `\n` line endings and a trailing newline.
 */
export function toText(
  take: Pick<Take, 'title' | 'createdAt' | 'countInBpm'>,
  notes: readonly Note[],
): string {
  const out = [
    `TabCreator — ${take.title.replace(/[\r\n]+/g, ' ')}`,
    'Tuning: E A D G B E (standard)',
    `Recorded: ${formatRecorded(take.createdAt)}`,
    '',
  ];
  layoutTab(notes, 80, take.countInBpm).systems.forEach((system, i) => {
    if (i > 0) out.push('');
    out.push(...system.lines);
  });
  return out.join('\n') + '\n';
}
