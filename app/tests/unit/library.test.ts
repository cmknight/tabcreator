import { describe, expect, it, vi } from 'vitest';
import {
  filterRows,
  formatMegabytes,
  libraryRow,
  notePreview,
  pickSize,
  searchKey,
  sortRows,
  withTitle,
  type LibraryRow,
} from '../../src/model/library';
import type { Note, StringNo, Tab, Take } from '../../src/model/types';

function makeTake(overrides: Partial<Take> = {}): Take {
  return {
    id: 't1',
    title: 'Take 2026-09-27 21:14',
    createdAt: '2026-09-27T21:14:00.000Z',
    status: 'analyzed',
    durationMs: 13_400,
    sampleRate: 48_000,
    tuning: 'EADGBE',
    micLabel: 'Mic',
    audioMime: 'audio/webm;codecs=opus',
    trimStartMs: 0,
    trimEndMs: null,
    settings: { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 },
    analysisVersion: '1',
    updatedAt: '2026-09-27T21:15:00.000Z',
    ...overrides,
  };
}

function note(i: number, string: StringNo, fret: number, startMs = 1000 + i * 100): Note {
  return {
    id: `n${i}`,
    startMs,
    endMs: startMs + 80,
    midi: 40,
    confidence: 0.9,
    string,
    fret,
    locked: false,
    lowConfidence: false,
  };
}

function makeTab(notes: Note[], takeId = 't1'): Tab {
  return { takeId, notes, updatedAt: '', deletedStartMs: [] };
}

/** 38 notes cycling over the strings, low E first. */
const notes38 = Array.from({ length: 38 }, (_, i) => note(i, (6 - (i % 6)) as StringNo, i % 13));

describe('libraryRow', () => {
  it('an analysed take: badge, visible note count, size and a 12-note preview', () => {
    const row = libraryRow(makeTake(), makeTab(notes38), 210_000);
    expect(row).toEqual<LibraryRow>({
      id: 't1',
      title: 'Take 2026-09-27 21:14',
      searchKey: 'take 2026-09-27 21:14',
      createdAt: '2026-09-27T21:14:00.000Z',
      status: 'analyzed',
      durationMs: 13_400,
      noteCount: 38,
      sizeBytes: 210_000,
      audioDeleted: false,
      preview: 'E|0 A|1 D|2 G|3 B|4 e|5 E|6 A|7 D|8 G|9 B|10 e|11 …',
      opens: true,
    });
  });

  it('previews in played order, not stored order', () => {
    const tab = makeTab([note(0, 1, 3, 500), note(1, 6, 0, 100), note(2, 5, 2, 300)]);
    const row = libraryRow(makeTake(), tab, 1);
    expect(row.preview).toBe('E|0 A|2 e|3');
    expect(row.noteCount).toBe(3);
  });

  it('a not analysed take: no note count, no preview, its size', () => {
    const row = libraryRow(
      makeTake({ status: 'recorded', analysisVersion: null }),
      null,
      2_900_000,
    );
    expect(row).toMatchObject({
      status: 'recorded',
      noteCount: null,
      preview: null,
      sizeBytes: 2_900_000,
      audioDeleted: false,
      opens: true,
    });
  });

  it('an analysed take with no notes previews nothing and counts 0', () => {
    expect(libraryRow(makeTake(), makeTab([]), 5)).toMatchObject({ noteCount: 0, preview: null });
  });

  it('an analysed take with no Tab shows 0 notes and no preview', () => {
    expect(libraryRow(makeTake(), null, 5)).toMatchObject({
      status: 'analyzed',
      noteCount: 0,
      preview: null,
    });
  });

  it('deleted audio: "Audio deleted" in place of the size', () => {
    const row = libraryRow(makeTake({ audioMime: null }), makeTab(notes38), 123);
    expect(row).toMatchObject({ audioDeleted: true, sizeBytes: null, noteCount: 38 });
  });

  it('a recording take: Recording, no size or preview, not a link', () => {
    const row = libraryRow(makeTake({ status: 'recording' }), makeTab(notes38), 4096);
    expect(row).toMatchObject({
      status: 'recording',
      sizeBytes: null,
      audioDeleted: false,
      preview: null,
      noteCount: null,
      opens: false,
    });
  });

  it('a trimmed take counts and previews only the visible notes', () => {
    // Notes start at 1000 + 100 i: a trim from 1250 to 1650 keeps notes 3..6.
    const row = libraryRow(makeTake({ trimStartMs: 1250, trimEndMs: 1650 }), makeTab(notes38), 1);
    expect(row.noteCount).toBe(4);
    expect(row.preview).toBe('G|3 B|4 e|5 E|6');
  });
});

describe('notePreview', () => {
  it('exactly 12 notes has no ellipsis; none is null', () => {
    expect(notePreview(notes38.slice(0, 12))).toBe(
      'E|0 A|1 D|2 G|3 B|4 e|5 E|6 A|7 D|8 G|9 B|10 e|11',
    );
    expect(notePreview([])).toBeNull();
  });
});

describe('sortRows', () => {
  it('orders newest first by createdAt, ties by id, without changing the input', () => {
    const t1 = libraryRow(makeTake({ id: 'a', createdAt: '2026-09-25T10:00:00.000Z' }), null, null);
    const t2 = libraryRow(makeTake({ id: 'b', createdAt: '2026-09-27T10:00:00.000Z' }), null, null);
    const t3 = libraryRow(makeTake({ id: 'c', createdAt: '2026-09-27T10:00:00.000Z' }), null, null);
    const input = [t1, t3, t2];
    expect(sortRows(input).map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(input.map((r) => r.id)).toEqual(['a', 'c', 'b']);
  });
});

describe('pickSize', () => {
  const files = [
    { ext: 'wav' as const, size: 96_044 },
    { ext: 'webm' as const, size: 210_000 },
  ];
  it("prefers the file matching the take's audioMime, else AUDIO_FORMATS order", () => {
    expect(pickSize(files, 'audio/wav')).toBe(96_044);
    expect(pickSize(files, 'audio/webm;codecs=opus')).toBe(210_000);
    expect(pickSize(files, null)).toBe(210_000);
    expect(pickSize(files, 'audio/unknown')).toBe(210_000);
    expect(pickSize([], 'audio/wav')).toBeNull();
  });
});

describe('formatMegabytes', () => {
  it('is decimal megabytes to one place, at least 0.1 for a non-empty file', () => {
    expect(formatMegabytes(210_000)).toBe('0.2');
    expect(formatMegabytes(2_940_000)).toBe('2.9');
    expect(formatMegabytes(41_000_000)).toBe('41.0');
    expect(formatMegabytes(12_000)).toBe('0.1');
    expect(formatMegabytes(0)).toBe('0.0');
  });
});

// Story "Search 500 takes" (EXPERIENCE.md Search): titles match ignoring case and accents.
describe('searchKey', () => {
  it('folds case and strips accents (NFD, combining marks removed)', () => {
    expect(searchKey('Café Blues 017')).toBe('cafe blues 017');
    expect(searchKey('BLUES')).toBe('blues');
    expect(searchKey('Ångström Señor Über')).toBe('angstrom senor uber');
    // Already-decomposed input folds the same way.
    expect(searchKey('Cafe\u0301')).toBe('cafe');
    // Letters NFD does not split fold as the export slug does.
    expect(searchKey('Øresund Straße Æther Œuvre Łódź Đak')).toBe(
      'oresund strasse aether oeuvre lodz dak',
    );
  });

  it('ignores the locale: a Turkish locale still folds "I" to "i"', () => {
    const lower = vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (
      this: string,
    ) {
      // What tr-TR does: dotless ı for I.
      return this.replace(/I/g, 'ı').toLowerCase();
    });
    try {
      expect(searchKey('INTRO RIFF')).toBe('intro riff');
    } finally {
      lower.mockRestore();
    }
  });

  it('is set on the row from its title', () => {
    expect(libraryRow(makeTake({ title: 'Crème Brûlée' }), null, null).searchKey).toBe(
      'creme brulee',
    );
  });
});

describe('withTitle', () => {
  it('recomputes the search key with the title; an unchanged title keeps the row', () => {
    const row = libraryRow(makeTake({ title: 'Riff' }), null, null);
    expect(withTitle(row, 'Riff')).toBe(row);
    expect(withTitle(row, 'Élan')).toMatchObject({ title: 'Élan', searchKey: 'elan' });
    expect(row.title).toBe('Riff');
  });
});

describe('filterRows', () => {
  const rows = ['Café Blues', 'blues lick', 'Riff', 'Øresund', 'Riff Blues'].map((title, i) =>
    libraryRow(makeTake({ id: `t${i}`, title }), null, null),
  );
  const titles = (q: string) => filterRows(rows, q).map((r) => r.title);

  it('matches titles containing the query, ignoring case and accents, in order', () => {
    expect(titles('cafe')).toEqual(['Café Blues']);
    expect(titles('CAFÉ')).toEqual(['Café Blues']);
    expect(titles('BLUES')).toEqual(['Café Blues', 'blues lick', 'Riff Blues']);
    expect(titles('oresund')).toEqual(['Øresund']);
    expect(titles('lues l')).toEqual(['blues lick']);
    expect(titles('zzz')).toEqual([]);
  });

  it('trims the query: "blues " finds "Riff Blues"', () => {
    expect(titles('blues ')).toContain('Riff Blues');
    expect(titles('  riff blues  ')).toEqual(['Riff Blues']);
  });

  it('an empty or whitespace-only query keeps every row (the same array)', () => {
    expect(filterRows(rows, '')).toBe(rows);
    expect(filterRows(rows, '   ')).toBe(rows);
  });
});
