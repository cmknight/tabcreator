// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CAP25_STATES, SPEC_EXTRA_STATE, type Lane, type StateEntry } from '../cap25-states';

// CAP-25 states sweep: every row of EXPERIENCE.md's State Patterns table is mapped, with its
// surface, to tests that reach it (tests/cap25-states.ts), and every mapped test still exists
// under that title in the lane given. A new or
// renamed row, a stale entry and a renamed or removed test all fail here.

const TESTS = fileURLToPath(new URL('..', import.meta.url));
const EXPERIENCE = fileURLToPath(
  new URL(
    '../../../_bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/EXPERIENCE.md',
    import.meta.url,
  ),
);

/** A Markdown table row's cells, trimmed (`\|` inside a cell is not a separator). */
function cells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.trim());
}

/** One State Patterns row: its State and Surface cells. */
interface StateRow {
  state: string;
  surface: string;
}

const isTableLine = (l: string) => /^\s*\|/.test(l);

/**
 * The State and Surface cells of every body row of the first table under `## State Patterns`:
 * the first contiguous run of table lines after the heading (and before the next `## `). Throws
 * when the section or its table is missing.
 */
function parseStatePatterns(markdown: string): StateRow[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === '## State Patterns');
  if (start < 0) throw new Error('no "## State Patterns" section');
  const next = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  const section = lines.slice(start + 1, next < 0 ? undefined : next);
  const first = section.findIndex(isTableLine);
  const after = first < 0 ? -1 : section.findIndex((l, i) => i > first && !isTableLine(l));
  const rows = first < 0 ? [] : section.slice(first, after < 0 ? undefined : after);
  if (rows.length < 2 || !/^[\s|:-]+$/.test(rows[1]!)) throw new Error('no State Patterns table');
  return rows.slice(2).map((r) => {
    const [state = '', surface = ''] = cells(r);
    return { state, surface };
  });
}

/** The problems between the table's `rows` and the checklist's `entries` (minus the SPEC extra). */
function stateMismatches(rows: readonly StateRow[], entries: readonly StateEntry[]): string[] {
  const mapped = entries.filter((e) => e.state !== SPEC_EXTRA_STATE);
  const states = mapped.map((e) => e.state);
  const problems: string[] = [];
  for (const row of rows)
    if (!states.includes(row.state)) problems.push(`State Patterns row not mapped: "${row.state}"`);
  for (const entry of mapped) {
    const row = rows.find((r) => r.state === entry.state);
    if (!row) problems.push(`checklist entry not in State Patterns: "${entry.state}"`);
    else if (row.surface !== entry.surface)
      problems.push(
        `"${entry.state}": surface "${entry.surface}", the table says "${row.surface}"`,
      );
  }
  for (const state of new Set(states))
    if (states.filter((s) => s === state).length > 1) problems.push(`mapped twice: "${state}"`);
  return problems;
}

/**
 * The titles of every `test(…)` / `it(…)` call in `source`, as written: a string's value, or a
 * template's text between its backticks (`${…}` kept). The source is parsed, so comments are
 * stripped: a commented-out test does not count.
 */
function testTitles(source: string): string[] {
  const file = ts.createSourceFile('spec.ts', source, ts.ScriptTarget.Latest, true);
  const titles: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === 'test' || node.expression.text === 'it')
    ) {
      const arg = node.arguments[0];
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)))
        titles.push(arg.text);
      else if (arg && ts.isTemplateExpression(arg)) titles.push(arg.getText(file).slice(1, -1));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return titles;
}

/** Whether `source` has a `test(` or `it(` call whose title is `title`, in any quote style. */
const hasTestTitle = (source: string, title: string): boolean => testTitles(source).includes(title);

/** The Playwright project (or `unit`) that runs `file` (playwright.config.ts's file patterns). */
function laneOf(file: string): Lane {
  if (file.startsWith('unit/')) return 'unit';
  if (/\.perf\.spec\.ts$/.test(file)) return 'perf';
  if (/\.dev\.spec\.ts$/.test(file)) return 'dev';
  if (/\.prod\.spec\.ts$/.test(file)) return 'prod-mic';
  if (/subpath\.spec\.ts$/.test(file)) return 'subpath';
  return 'chromium';
}

const FIXTURE = `# Doc

## State Patterns

Intro text.

| State | Surface | Treatment |
| --- | --- | --- |
| Mapped state | Record | "A message" with <a\\|b> and an action. |
| Unmapped state | Tab | Something. |

| Second | Table |
| --- | --- |
| Not a state | row |

## Next section

| Not | A state |
| --- | --- |
| Ignored | row |
`;

describe('the State Patterns parser', () => {
  it('reads State and Surface from the first table under State Patterns only', () => {
    expect(parseStatePatterns(FIXTURE)).toEqual([
      { state: 'Mapped state', surface: 'Record' },
      { state: 'Unmapped state', surface: 'Tab' },
    ]);
    expect(cells('| a \\| b | c |')).toEqual(['a \\| b', 'c']);
  });

  it('fails on a row with no checklist entry, naming it, on a stale entry, a wrong surface and a state mapped twice', () => {
    const entries: StateEntry[] = [
      { state: 'Mapped state', surface: 'Record', tests: [] },
      { state: SPEC_EXTRA_STATE, surface: 'Tab', tests: [] },
    ];
    expect(stateMismatches(parseStatePatterns(FIXTURE), entries)).toEqual([
      'State Patterns row not mapped: "Unmapped state"',
    ]);
    const rows = [{ state: 'Mapped state', surface: 'Record' }];
    expect(
      stateMismatches(rows, [...entries, { state: 'Gone', surface: 'Tab', tests: [] }]),
    ).toEqual(['checklist entry not in State Patterns: "Gone"']);
    expect(stateMismatches(rows, [{ state: 'Mapped state', surface: 'Tab', tests: [] }])).toEqual([
      '"Mapped state": surface "Tab", the table says "Record"',
    ]);
    expect(stateMismatches(rows, [entries[0]!, entries[0]!])).toEqual([
      'mapped twice: "Mapped state"',
    ]);
  });

  it('throws when the section or its table is missing', () => {
    expect(() => parseStatePatterns('# Doc\n\n## Other\n')).toThrow('no "## State Patterns"');
    expect(() => parseStatePatterns('## State Patterns\n\nText only.\n')).toThrow('no State');
  });

  it('finds a test title in any quote style, and not a partial, non-test or commented-out one', () => {
    expect(hasTestTitle("test('a (b) c', async () => {})", 'a (b) c')).toBe(true);
    expect(hasTestTitle('  it(\n    "x \'y\'",\n () => {})', "x 'y'")).toBe(true);
    expect(hasTestTitle('test(`without ${api}: z`, () => {})', 'without ${api}: z')).toBe(true);
    expect(hasTestTitle("test('a b c', () => {})", 'a b')).toBe(false);
    expect(hasTestTitle("describe('a b', () => {})", 'a b')).toBe(false);
    expect(hasTestTitle("// test('gone', () => {});", 'gone')).toBe(false);
    expect(hasTestTitle("/*\ntest('gone', () => {});\n*/", 'gone')).toBe(false);
    expect(hasTestTitle("const u = 'http://x'; test('kept', () => {});", 'kept')).toBe(true);
  });

  it("infers each file pattern's lane as playwright.config.ts runs it", () => {
    expect(laneOf('unit/x.test.ts')).toBe('unit');
    expect(laneOf('e2e/edit-latency.perf.spec.ts')).toBe('perf');
    expect(laneOf('e2e/x.dev.spec.ts')).toBe('dev');
    expect(laneOf('e2e/x.prod.spec.ts')).toBe('prod-mic');
    expect(laneOf('e2e/backup-restore-subpath.spec.ts')).toBe('subpath');
    expect(laneOf('e2e/engine.spec.ts')).toBe('chromium');
  });
});

describe('the CAP-25 states checklist', () => {
  const rows = parseStatePatterns(readFileSync(EXPERIENCE, 'utf8'));

  it('maps every State Patterns row, and nothing else but the SPEC extra', () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(stateMismatches(rows, CAP25_STATES)).toEqual([]);
    expect(CAP25_STATES.map((e) => e.state)).toContain(SPEC_EXTRA_STATE);
    expect(CAP25_STATES).toHaveLength(rows.length + 1);
  });

  it('maps each state to at least one test, each in a file that has that title', () => {
    const missing: string[] = [];
    for (const { state, tests } of CAP25_STATES) {
      if (tests.length === 0) missing.push(`${state}: no test mapped`);
      for (const { file, title, lane } of tests) {
        const path = `${TESTS}${file}`;
        if (!existsSync(path)) {
          missing.push(`${state}: ${file} does not exist`);
          continue;
        }
        if (!hasTestTitle(readFileSync(path, 'utf8'), title))
          missing.push(`${state}: no test "${title}" in ${file}`);
        const expected = laneOf(file);
        if (lane !== expected) missing.push(`${state}: ${file} runs in ${expected}, not ${lane}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
