import { describe, expect, it } from 'vitest';
import { layoutTab, toText, type TabLayout } from '../../src/model/tab-render';
import type { Note, StringNo, Take } from '../../src/model/types';

let nextId = 0;
function note(string: StringNo, fret: number, startMs: number): Note {
  nextId += 1;
  return {
    id: `n${nextId}`,
    string,
    fret,
    startMs,
    endMs: startMs + 100,
    midi: 0,
    confidence: 1,
    locked: false,
    lowConfidence: false,
  };
}

/** The tab-format.md phrase, as [string, fret] pairs. */
const PHRASE: [StringNo, number][] = [
  [5, 3],
  [4, 2],
  [4, 4],
  [3, 0],
  [3, 2],
  [3, 4],
  [2, 1],
  [2, 3],
  [1, 0],
  [1, 3],
  [1, 5],
  [1, 3],
  [1, 0],
  [2, 3],
  [2, 1],
];

function phrase(): Note[] {
  return PHRASE.map(([s, f], i) => note(s, f, i * 125));
}

/** The golden sample from tab-format.md, verbatim. */
const GOLDEN = [
  'e|-----------------0-3-5-3-0--------|',
  'B|-------------1-3-----------3-1----|',
  'G|-------0-2-4----------------------|',
  'D|---2-4----------------------------|',
  'A|-3--------------------------------|',
  'E|----------------------------------|',
];

/** A seeded LCG in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomNotes(count: number, seed: number): Note[] {
  const r = rng(seed);
  let t = 0;
  const out: Note[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(note((1 + Math.floor(r() * 6)) as StringNo, Math.floor(r() * 25), t));
    t += Math.floor(r() * 1200);
  }
  return out;
}

function checkLayout(layout: TabLayout, notes: readonly Note[], width: number): void {
  const seen = new Map<string, number>();
  for (const system of layout.systems) {
    expect(system.lines).toHaveLength(6);
    const len = system.lines[0]!.length;
    for (const line of system.lines) {
      expect(line.length).toBeLessThanOrEqual(width);
      expect(line.length).toBe(len);
      expect(line.endsWith('---|')).toBe(true);
    }
    for (const cell of system.cells) {
      seen.set(cell.noteId, (seen.get(cell.noteId) ?? 0) + 1);
      const n = notes.find((x) => x.id === cell.noteId)!;
      expect(cell.string).toBe(n.string);
      expect(cell.width).toBe(String(n.fret).length);
      system.lines.forEach((line, row) => {
        const text = line.slice(cell.col, cell.col + cell.width);
        expect(text).toBe(row === n.string - 1 ? String(n.fret) : '-'.repeat(cell.width));
      });
    }
    for (const col of system.barCols) {
      for (const line of system.lines) expect(line[col]).toBe('|');
    }
  }
  expect(seen.size).toBe(notes.length);
  // Cells across systems follow played order (a stable sort by startMs).
  const played = notes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => a.n.startMs - b.n.startMs || a.i - b.i)
    .map(({ n }) => n.id);
  expect(layout.systems.flatMap((s) => s.cells.map((c) => c.noteId))).toEqual(played);
  for (const count of seen.values()) expect(count).toBe(1);
}

describe('layoutTab', () => {
  it('renders the tab-format.md golden sample exactly', () => {
    for (const width of [37, 80, 200]) {
      const layout = layoutTab(phrase(), width);
      expect(layout.systems).toHaveLength(1);
      expect(layout.systems[0]!.lines).toEqual(GOLDEN);
      expect(layout.systems[0]!.barCols).toEqual([]);
    }
    expect(GOLDEN[0]).toHaveLength(37);
  });

  it('sorts a copy of the notes by startMs', () => {
    const notes = phrase();
    const shuffled = [...notes].reverse();
    expect(layoutTab(shuffled, 80).systems[0]!.lines).toEqual(GOLDEN);
    expect(shuffled[0]).toBe(notes[notes.length - 1]);
  });

  it('renders no notes as one empty system', () => {
    const layout = layoutTab([], 80, 120);
    expect(layout.systems).toEqual([
      {
        lines: ['e|----|', 'B|----|', 'G|----|', 'D|----|', 'A|----|', 'E|----|'],
        cells: [],
        barCols: [],
      },
    ]);
  });

  it('renders a single note', () => {
    const layout = layoutTab([note(3, 7, 500)], 80);
    expect(layout.systems[0]!.lines).toEqual([
      'e|------|',
      'B|------|',
      'G|-7----|',
      'D|------|',
      'A|------|',
      'E|------|',
    ]);
    expect(layout.systems[0]!.cells).toEqual([
      { noteId: expect.any(String), col: 3, width: 1, string: 3 },
    ]);
  });

  it('keeps all six lines equal with two-digit frets', () => {
    const notes = [note(1, 10, 0), note(2, 3, 125), note(3, 24, 250)];
    const layout = layoutTab(notes, 80);
    expect(layout.systems[0]!.lines).toEqual([
      'e|-10---------|',
      'B|----3-------|',
      'G|------24----|',
      'D|------------|',
      'A|------------|',
      'E|------------|',
    ]);
    checkLayout(layout, notes, 80);
  });

  it('spaces notes by the gap to the next start, clamped to 1..8 dashes', () => {
    const notes = [note(1, 0, 0), note(1, 1, 0), note(1, 2, 300), note(1, 3, 5000)];
    expect(layoutTab(notes, 80).systems[0]!.lines[0]).toBe(
      ['e|-', '0-', '1--', '2--------', '3-', '---|'].join(''),
    );
  });

  for (const width of [80, 40]) {
    it(`wraps a 200-note take within ${width} characters`, () => {
      const notes = randomNotes(200, width);
      const layout = layoutTab(notes, width);
      expect(layout.systems.length).toBeGreaterThan(1);
      checkLayout(layout, notes, width);
      const withBars = layoutTab(notes, width, 100);
      checkLayout(withBars, notes, width);
      expect(withBars.systems.some((s) => s.barCols.length > 0)).toBe(true);
    });
  }

  it('draws a bar line before the note at 1000 ms at 240 BPM', () => {
    const notes = phrase();
    const layout = layoutTab(notes, 80, 240);
    // The bar line (|-) sits after the eighth note's spacing: column 3 + 8 × 2.
    expect(layout.systems[0]!.lines).toEqual(
      GOLDEN.map((l) => l.slice(0, 19) + '|-' + l.slice(19)),
    );
    expect(layout.systems[0]!.barCols).toEqual([19]);
    expect(layout.systems[0]!.cells[8]).toMatchObject({ noteId: notes[8]!.id, col: 21 });
    checkLayout(layout, notes, 80);
  });

  it('draws a bar line at each 2 s boundary at 120 BPM, a note on the boundary after it', () => {
    const notes = [
      note(1, 0, 0),
      note(1, 1, 1500),
      note(1, 2, 2500),
      note(1, 3, 4000),
      note(1, 5, 5500),
    ];
    const layout = layoutTab(notes, 80, 120);
    const system = layout.systems[0]!;
    expect(system.lines[0]).toBe(
      ['e|-', '0--------', '1--------', '|-', '2--------', '|-', '3--------', '5-', '---|'].join(
        '',
      ),
    );
    expect(system.lines[5]).toBe(
      'E|-' + '-'.repeat(18) + '|-' + '-'.repeat(9) + '|-' + '-'.repeat(11) + '---|',
    );
    expect(system.barCols).toEqual([21, 32]);
    expect(system.cells.map((c) => c.col)).toEqual([3, 12, 23, 34, 43]);
  });

  it('draws a bar line before a first note that starts after a boundary', () => {
    const layout = layoutTab([note(1, 0, 2100)], 80, 120);
    expect(layout.systems[0]!.lines[0]).toBe('e|-|-0----|');
    expect(layout.systems[0]!.barCols).toEqual([3]);
  });

  it('keeps empty bars visible', () => {
    const layout = layoutTab([note(1, 0, 0), note(1, 1, 5000)], 80, 120);
    expect(layout.systems[0]!.lines[0]).toBe('e|-0--------|-|-1----|');
    expect(layout.systems[0]!.barCols).toEqual([12, 14]);
  });

  it('drops a bar line at a wrap; the next system starts with its note', () => {
    const notes = Array.from({ length: 16 }, (_, i) => note(1, 0, i * 125));
    const eight = 'e|-' + '0-'.repeat(8) + '---|';
    // The bar is the unit that does not fit.
    const tight = layoutTab(notes, 23, 240);
    expect(tight.systems.map((s) => s.lines[0])).toEqual([eight, eight]);
    expect(tight.systems.map((s) => s.barCols)).toEqual([[], []]);
    // The bar fits but sits in the system's last third, so the break prefers it.
    const roomy = layoutTab(notes, 27, 240);
    expect(roomy.systems.map((s) => s.lines[0])).toEqual([eight, eight]);
    expect(roomy.systems[1]!.cells[0]).toMatchObject({ noteId: notes[8]!.id, col: 3 });
    // Without bar lines the same width packs ten notes.
    const plain = layoutTab(notes, 27);
    expect(plain.systems.map((s) => s.cells.length)).toEqual([10, 6]);
    checkLayout(roomy, notes, 27);
  });

  it('gives an over-wide note a system of its own', () => {
    const notes = [note(1, 12, 0), note(1, 13, 1000)];
    const layout = layoutTab(notes, 8);
    expect(layout.systems.map((s) => s.lines[0])).toEqual(['e|-12-----------|', 'e|-13----|']);
  });

  it('breaks before the note that does not fit when the bar is in the first two-thirds', () => {
    const notes = Array.from({ length: 16 }, (_, i) => note(1, 0, i * 125));
    const layout = layoutTab(notes, 37, 240);
    expect(layout.systems.map((s) => s.lines[0])).toEqual([
      'e|-' + '0-'.repeat(8) + '|-' + '0-'.repeat(6) + '---|',
      'e|-0-0----|',
    ]);
    expect(layout.systems.map((s) => s.barCols)).toEqual([[19], []]);
    checkLayout(layout, notes, 37);
  });

  it('never ends a system with a bar line', () => {
    const notes = [note(1, 12, 0), note(1, 13, 2100)];
    expect(layoutTab(notes, 27, 120).systems.map((s) => s.lines[0])).toEqual([
      'e|-12--------|-13----|',
    ]);
    const narrow = layoutTab(notes, 17, 120);
    expect(narrow.systems.map((s) => s.lines[0])).toEqual(['e|-12-----------|', 'e|-13----|']);
    expect(narrow.systems.map((s) => s.barCols)).toEqual([[], []]);
  });

  it('drops one bar of a run of two at a break and carries the other', () => {
    const notes = [note(1, 0, 0), note(1, 1, 5000)];
    const layout = layoutTab(notes, 18, 120);
    expect(layout.systems.map((s) => s.lines)).toEqual([
      [
        'e|-0-----------|',
        'B|-------------|',
        'G|-------------|',
        'D|-------------|',
        'A|-------------|',
        'E|-------------|',
      ],
      ['e|-|-1----|', 'B|-|------|', 'G|-|------|', 'D|-|------|', 'A|-|------|', 'E|-|------|'],
    ]);
    expect(layout.systems.map((s) => s.barCols)).toEqual([[], [3]]);
    checkLayout(layout, notes, 18);
  });

  it('drops one bar of a run of three at a break and carries the other two', () => {
    const notes = [note(1, 0, 0), note(1, 1, 7000)];
    const layout = layoutTab(notes, 18, 120);
    expect(layout.systems.map((s) => s.lines[0])).toEqual(['e|-0-----------|', 'e|-|-|-1----|']);
    expect(layout.systems.map((s) => s.lines[5])).toEqual(['E|-------------|', 'E|-|-|------|']);
    expect(layout.systems.map((s) => s.barCols)).toEqual([[], [3, 5]]);
    checkLayout(layout, notes, 18);
  });

  it('treats a count-in that is not finite or outside (0, 1000] as none', () => {
    for (const bpm of [Infinity, -Infinity, NaN, 1e9, 1001, -120, 0]) {
      expect(layoutTab(phrase(), 80, bpm).systems[0]!.lines).toEqual(GOLDEN);
    }
    expect(layoutTab(phrase(), 80, 1000).systems[0]!.barCols.length).toBeGreaterThan(0);
  });

  it('draws no bar lines without a count-in', () => {
    expect(layoutTab(phrase(), 80, undefined).systems[0]!.lines).toEqual(GOLDEN);
    expect(layoutTab(phrase(), 80, 0).systems[0]!.lines).toEqual(GOLDEN);
  });
});

describe('toText', () => {
  const take: Take = {
    id: 't1',
    title: 'Morning riff',
    createdAt: new Date(2026, 9, 4, 9, 5).toISOString(),
    status: 'analyzed',
    durationMs: 300_000,
    sampleRate: 48_000,
    tuning: 'EADGBE',
    micLabel: 'Mic',
    audioMime: null,
    trimStartMs: 0,
    trimEndMs: null,
    countInBpm: 100,
    settings: { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 },
    analysisVersion: '1',
    updatedAt: new Date(2026, 9, 4, 9, 6).toISOString(),
  };

  it('writes the header, a blank line, then systems at 80 separated by blank lines', () => {
    const notes = randomNotes(200, 7);
    const text = toText(take, notes);
    expect(text.endsWith('|\n')).toBe(true);
    expect(text).not.toContain('\r');
    const lines = text.slice(0, -1).split('\n');
    expect(lines.slice(0, 4)).toEqual([
      'TabCreator — Morning riff',
      'Tuning: E A D G B E (standard)',
      'Recorded: 2026-10-04 09:05',
      '',
    ]);
    const { systems } = layoutTab(notes, 80, 100);
    expect(systems.length).toBeGreaterThan(1);
    const expected = systems.flatMap((s, i) => (i > 0 ? ['', ...s.lines] : s.lines));
    expect(lines.slice(4)).toEqual(expected);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
  });

  it('draws no bar lines for a take without a count-in', () => {
    const plain: Take = { ...take };
    delete plain.countInBpm;
    const notes = randomNotes(200, 11);
    const tabLines = toText(plain, notes)
      .split('\n')
      .slice(4)
      .filter((l) => l !== '');
    expect(tabLines.length).toBeGreaterThan(6);
    for (const line of tabLines) {
      expect(line.endsWith('|')).toBe(true);
      expect(line.slice(2, -1)).not.toContain('|');
    }
  });

  it('flattens line breaks in the title to a single space', () => {
    const text = toText({ ...take, title: 'Morning\r\nriff\n\ntwo\rthree' }, []);
    expect(text.split('\n')[0]).toBe('TabCreator — Morning riff two three');
    expect(text.split('\n')[1]).toBe('Tuning: E A D G B E (standard)');
  });

  it('formats the recorded time in local time, zero-padded', () => {
    const t = { ...take, createdAt: new Date(2027, 0, 2, 3, 4).toISOString() };
    expect(toText(t, []).split('\n')[2]).toBe('Recorded: 2027-01-02 03:04');
    expect(toText(t, [])).toBe(
      [
        'TabCreator — Morning riff',
        'Tuning: E A D G B E (standard)',
        'Recorded: 2027-01-02 03:04',
        '',
        'e|----|',
        'B|----|',
        'G|----|',
        'D|----|',
        'A|----|',
        'E|----|',
        '',
      ].join('\n'),
    );
  });
});
