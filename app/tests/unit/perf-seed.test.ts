// Story "Latency gates and backup on the production build": the latency perf specs' seeds (the
// 500-note tab and the 500-take library, as backups the app's restore validation accepts) and
// their limits (budgets.json, the lowering overrides) and job-summary helpers.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIBRARY500_COUNT, library500Notes, library500Title } from '../../src/dev/library500';
import { validateBackup } from '../../src/storage/restore';
import { DEFAULT_PREFS } from '../../src/storage/prefs';
import {
  appendSummary,
  BUDGETS_PATH,
  limitLabel,
  markdownTable,
  PerfConfigError,
  percentile,
  readLimit,
  withinLimit,
  type Limit,
} from '../e2e/perf-helpers';
import {
  library500Seed,
  seedAnalysedTake,
  seedBackup,
  TAB500_IDS,
  tab500Seed,
} from '../e2e/seed-helpers';
import { tab500Notes } from '../e2e/tab500';

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'perf-seed-'));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

/** The zip's manifest validated as the app's restore validates it (no audio entries). */
function validate(zip: Buffer) {
  const files = unzipSync(zip);
  expect(Object.keys(files)).toEqual(['manifest.json']);
  return validateBackup(strFromU8(files['manifest.json']!), []);
}

describe('analysed seeds', () => {
  it('an analysed take with no audio, seeded analysis version and the default settings', () => {
    const notes = tab500Notes().slice(0, 3);
    const { take, tab } = seedAnalysedTake({
      id: 'x',
      title: 'X',
      notes,
      createdAt: '2026-10-07T10:00:00.000Z',
    });
    expect(take).toMatchObject({
      id: 'x',
      title: 'X',
      status: 'analyzed',
      analysisVersion: 'seeded',
      audioMime: null,
      settings: DEFAULT_PREFS.analysisDefaults,
      durationMs: notes.at(-1)!.endMs + 1000,
      createdAt: '2026-10-07T10:00:00.000Z',
    });
    expect(tab).toEqual({
      takeId: 'x',
      notes,
      updatedAt: '2026-10-07T10:00:00.000Z',
      deletedStartMs: [],
    });
  });

  it('the 500-note tab: phrased and one-phrase takes restore validation accepts', () => {
    const base = Date.parse('2026-10-07T10:00:00.000Z');
    const entries = tab500Seed(base);
    const valid = validate(seedBackup(entries));
    expect(valid.takes.map((t) => t.id)).toEqual([TAB500_IDS.phrased, TAB500_IDS.onePhrase]);
    expect(valid.takes.map((t) => t.createdAt)).toEqual([
      '2026-10-07T10:00:01.000Z',
      '2026-10-07T10:00:02.000Z',
    ]);
    expect(valid.takes.every((t) => t.status === 'analyzed' && t.audioMime === null)).toBe(true);
    expect(valid.tabs.map((t) => t.notes)).toEqual([
      tab500Notes(),
      tab500Notes({ onePhrase: true }),
    ]);
    expect(valid.audio.size).toBe(0);
  });

  it('the 500-take library: deterministic titles and tabs, take i at base + i s', () => {
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    const entries = library500Seed(base);
    expect(entries).toHaveLength(LIBRARY500_COUNT);
    const valid = validate(seedBackup(entries));
    expect(valid.takes).toHaveLength(LIBRARY500_COUNT);
    expect(valid.tabs).toHaveLength(LIBRARY500_COUNT);
    for (const i of [1, 17, 500]) {
      const take = valid.takes[i - 1]!;
      expect(take.title).toBe(library500Title(i));
      expect(take.createdAt).toBe(new Date(base + i * 1000).toISOString());
      expect(take).toMatchObject({
        status: 'analyzed',
        analysisVersion: 'seeded',
        audioMime: null,
      });
      expect(valid.tabs[i - 1]).toMatchObject({ takeId: take.id, notes: library500Notes(i) });
    }
    expect(new Set(valid.takes.map((t) => t.id)).size).toBe(LIBRARY500_COUNT);
  });
});

describe('perf limits', () => {
  const budgets = (value: unknown) => {
    const path = join(work, 'budgets.json');
    writeFileSync(path, JSON.stringify({ editP95Ms: value, searchP95Ms: 50 }));
    return path;
  };

  it('reads the real budgets', () => {
    const real = JSON.parse(readFileSync(BUDGETS_PATH, 'utf8')) as Record<string, number>;
    expect(readLimit('editP95Ms', {})).toEqual({
      key: 'editP95Ms',
      ms: real.editP95Ms,
      budgetMs: real.editP95Ms,
    });
    expect(readLimit('searchP95Ms', {}).ms).toBe(real.searchP95Ms);
  });

  it.each([undefined, 0, -1, '100', null, Number.NaN])('rejects editP95Ms %s', (value) => {
    expect(() => readLimit('editP95Ms', {}, budgets(value))).toThrow(
      /"editP95Ms" must be a positive number of milliseconds/,
    );
  });

  it('rejects a missing or malformed budgets file', () => {
    expect(() => readLimit('editP95Ms', {}, join(work, 'none.json'))).toThrow(
      /cannot read budgets/,
    );
    const bad = join(work, 'bad.json');
    writeFileSync(bad, '[1]');
    expect(() => readLimit('editP95Ms', {}, bad)).toThrow(/not a JSON object/);
  });

  it('an override lowers the limit, never raises it', () => {
    const path = budgets(100);
    const lowered = readLimit('editP95Ms', { TABCREATOR_EDIT_P95_MS: '1' }, path);
    expect(lowered).toEqual({
      key: 'editP95Ms',
      ms: 1,
      budgetMs: 100,
      override: 'TABCREATOR_EDIT_P95_MS',
    });
    expect(limitLabel(lowered)).toBe('1 ms (TABCREATOR_EDIT_P95_MS)');
    expect(limitLabel(readLimit('editP95Ms', { TABCREATOR_EDIT_P95_MS: '' }, path))).toBe(
      '100 ms (editP95Ms)',
    );
    expect(() => readLimit('editP95Ms', { TABCREATOR_EDIT_P95_MS: '101' }, path)).toThrow(
      /may only lower the limit/,
    );
    for (const raw of ['0', '-5', 'abc', '1e1'])
      expect(() => readLimit('editP95Ms', { TABCREATOR_EDIT_P95_MS: raw }, path)).toThrow(
        PerfConfigError,
      );
    // Each limit has its own variable.
    expect(readLimit('searchP95Ms', { TABCREATOR_EDIT_P95_MS: '1' }, path).ms).toBe(50);
  });
});

describe('perf report helpers', () => {
  it('nearest-rank percentile', () => {
    const values = Array.from({ length: 20 }, (_, i) => 20 - i);
    expect(percentile(values, 95)).toBe(19);
    expect(percentile(values, 50)).toBe(10);
    expect(percentile([7], 95)).toBe(7);
    expect(() => percentile([], 95)).toThrow(PerfConfigError);
  });

  it('a Markdown table, escaping pipes', () => {
    expect(markdownTable(['a', 'b'], [['1', 'x|y']])).toBe(
      '| a | b |\n| --- | --- |\n| 1 | x\\|y |',
    );
  });

  it('appends to $GITHUB_STEP_SUMMARY only when set', () => {
    const path = join(work, 'summary.md');
    writeFileSync(path, 'before\n');
    appendSummary('## Table\n', { GITHUB_STEP_SUMMARY: path });
    expect(readFileSync(path, 'utf8')).toBe('before\n## Table\n\n');
    appendSummary('ignored', {});
    expect(readFileSync(path, 'utf8')).toBe('before\n## Table\n\n');
  });

  it('a failed summary write warns and does not throw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A directory, not a file: the append fails.
      expect(() => appendSummary('## Table', { GITHUB_STEP_SUMMARY: work })).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/cannot append to the job summary/));
    } finally {
      warn.mockRestore();
    }
  });

  it('the gate verdict: within the limit gated, never for NaN', () => {
    const budget: Limit = { key: 'editP95Ms', ms: 100, budgetMs: 100 };
    const lowered: Limit = {
      key: 'editP95Ms',
      ms: 1,
      budgetMs: 100,
      override: 'TABCREATOR_EDIT_P95_MS',
    };
    expect(withinLimit(20, budget)).toBe(true);
    expect(withinLimit(100, budget)).toBe(true);
    expect(withinLimit(100.1, budget)).toBe(false);
    expect(withinLimit(20, lowered)).toBe(false);
    expect(withinLimit(Number.NaN, budget)).toBe(false);
    expect(withinLimit(Number.POSITIVE_INFINITY, budget)).toBe(false);
  });
});
