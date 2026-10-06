import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { noteButton, noteButtons, tabArea } from './tab-helpers';

// Story "500-note edit latency" (CAP-14, AD-17): edit-to-paint on a 500-note tab, per edit kind.
// The dev page `#/__test/tab500` seeds the generated tab (src/dev/tab500.ts) and opens it. An
// edit's time runs from its key event's `timeStamp` to the first animation frame after the tab
// area's DOM reflects it (a MutationObserver, then the next requestAnimationFrame, read in a task
// after it so that frame's layout and paint count): the real engine's `mapFrets` round trip (the
// dev build's worker), React render, layout and paint included. The phrased shape (phrases of
// 16) is gated at p95 ≤ 100 ms per kind in its own test; the one-phrase shape (`?onePhrase`,
// one 500-note phrase) is reported only, in a separate test. It runs in the `perf` project
// (playwright.config.ts): one worker, after every other project, so nothing competes for the CPU.

/** The budget: every edit kind's p95 on the phrased shape. */
const BUDGET_MS = 100;
/** Measured samples per edit kind, each on a different note. */
const SAMPLES = 20;
/** Unmeasured warm-up edits per kind, before its samples. */
const WARM_UP = 3;

type Kind = 'set fret' | 'string move' | 'delete' | 'insert' | 'confirm' | 'undo' | 'redo';
const KINDS: readonly Kind[] = [
  'set fret',
  'string move',
  'confirm',
  'insert',
  'delete',
  'undo',
  'redo',
];

interface Row {
  shape: 'phrased' | 'one phrase';
  kind: Kind;
  n: number;
  medianMs: number;
  p95Ms: number;
  gated: boolean;
}

/** The nearest-rank percentile `p` (0–100) of `values`. */
function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

const round = (ms: number) => Math.round(ms * 10) / 10;

/** Opens the dev page (seeding a fresh take) and waits for its 500-note tab. */
async function openTab500(page: Page, onePhrase: boolean) {
  await page.goto(`./#/__test/tab500${onePhrase ? '?onePhrase' : ''}`);
  await expect(page).toHaveURL(/#\/tab\/[^/]+$/, { timeout: 15_000 });
  await expect(tabArea(page)).toBeVisible();
  await expect(noteButtons(page)).toHaveCount(500);
  await installProbe(page);
}

/**
 * Installs the in-page probe: a capturing keydown listener records the armed key's `timeStamp`;
 * `__latency.arm(what)` resolves with the edit-to-paint time once the tab area's signature (its
 * lines, its flagged-note count and its note count) changes and the next frame has been laid
 * out and painted (a requestAnimationFrame, then a task after it); after 10 s it rejects, naming
 * `what` (the edit kind and note).
 */
function installProbe(page: Page) {
  return page.evaluate(() => {
    const area = document.querySelector<HTMLElement>('[data-testid="tab-systems"]')!;
    const signature = () =>
      [
        Array.from(area.querySelectorAll('pre'), (p) => p.textContent).join('\n'),
        area.querySelectorAll('[aria-label$="check this note"]').length,
        area.querySelectorAll('[data-note-id]').length,
      ].join('#');
    const probe = {
      keyTs: null as number | null,
      result: null as Promise<number> | null,
      arm(what: string) {
        probe.keyTs = null;
        const before = signature();
        probe.result = new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => {
            observer.disconnect();
            reject(new Error(`${what}: the edit never reached the tab area within 10 s`));
          }, 10_000);
          const observer = new MutationObserver(() => {
            if (probe.keyTs === null || signature() === before) return;
            observer.disconnect();
            clearTimeout(timer);
            const keyTs = probe.keyTs;
            // The time is read after the frame's layout and paint: in a task queued from its
            // requestAnimationFrame callback (which runs before them).
            requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - keyTs), 0));
          });
          observer.observe(area, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
          });
        });
      },
    };
    window.addEventListener(
      'keydown',
      (e) => {
        // The edit key's own event, not a modifier's (Control before Z).
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
        if (probe.result !== null && probe.keyTs === null) probe.keyTs = e.timeStamp;
      },
      true,
    );
    (window as unknown as { __latency: typeof probe }).__latency = probe;
  });
}

/** Presses `key` with the probe armed; returns the edit-to-paint time. `what`: kind and note. */
async function measure(page: Page, key: string, what: string): Promise<number> {
  await page.evaluate(
    (w) => (window as unknown as { __latency: { arm(what: string): void } }).__latency.arm(w),
    what,
  );
  await page.keyboard.press(key);
  return page.evaluate(
    () => (window as unknown as { __latency: { result: Promise<number> } }).__latency.result,
  );
}

/** Presses `key` and waits for the tab area to reflect it, unmeasured. */
async function unmeasured(page: Page, key: string, what: string): Promise<void> {
  await measure(page, key, what);
}

/** Selects note `id` by focusing its button; returns what its label says now. */
async function select(page: Page, id: string): Promise<NoteInfo> {
  const button = noteButton(page, id);
  await button.focus();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  return noteInfo(id, (await button.getAttribute('aria-label')) ?? '');
}

interface NoteInfo {
  id: string;
  string: string;
  fret: number;
  flagged: boolean;
}

/** What note `id`'s label says; throws when the label does not parse. */
function noteInfo(id: string, label: string): NoteInfo {
  const m = /: (.+) string, fret (\d+),/.exec(label);
  if (!m) throw new Error(`note ${id}: unexpected label "${label}"`);
  return {
    id,
    string: m[1]!,
    fret: Number(m[2]),
    flagged: label.endsWith('check this note'),
  };
}

/** Every note button in played order, with what its label says. */
async function notesNow(page: Page): Promise<NoteInfo[]> {
  const raw = await noteButtons(page).evaluateAll((els) =>
    els.map((el) => [el.getAttribute('data-note-id')!, el.getAttribute('aria-label') ?? '']),
  );
  return raw.map(([id, label]) => noteInfo(id!, label!));
}

/**
 * `count` different notes spread over the tab that `ok` accepts (none in `used`): from evenly
 * spaced starting points, each the first acceptable note at or after its point.
 */
function spread(
  notes: readonly NoteInfo[],
  count: number,
  ok: (n: NoteInfo) => boolean,
  used: Set<string>,
): NoteInfo[] {
  const picked: NoteInfo[] = [];
  for (let j = 0; j < count; j += 1) {
    const from = Math.floor((j * notes.length) / count);
    for (let k = 0; k < notes.length; k += 1) {
      const note = notes[(from + k) % notes.length]!;
      if (used.has(note.id) || !ok(note)) continue;
      used.add(note.id);
      picked.push(note);
      break;
    }
  }
  if (picked.length < count) throw new Error(`only ${picked.length} of ${count} notes found`);
  return picked;
}

/** The key that changes note `n`'s fret: a digit other than its fret. */
const fretKey = (n: NoteInfo) => String((n.fret + 1) % 10);
/** The key that moves note `n` to another string: ↓ (thicker), or ↑ from the low E string. */
const moveKey = (n: NoteInfo) => (n.string === 'low E' ? 'ArrowUp' : 'ArrowDown');
/** Whether `moveKey` moves note `n` (the A string is 5 semitones above the low E). */
const movable = (n: NoteInfo) => n.string !== 'low E' || n.fret >= 5;
/** Spare notes for a kind whose note a re-fit may have made unsuitable since the list was read. */
const SPARE = 10;

/** Runs every edit kind on the open tab; returns each kind's samples. */
async function runKinds(page: Page): Promise<Map<Kind, number[]>> {
  const samples = new Map<Kind, number[]>();
  const per = WARM_UP + SAMPLES;
  /** Edits notes until `per` edits ran (`edit` returns null when it skips a note). */
  const run = async (
    kind: Kind,
    notes: NoteInfo[],
    edit: (n: NoteInfo) => Promise<number | null>,
  ) => {
    const times: number[] = [];
    let done = 0;
    for (const note of notes) {
      if (done === per) break;
      const ms = await edit(note);
      if (ms === null) continue;
      if (done >= WARM_UP) times.push(ms);
      done += 1;
    }
    samples.set(kind, times);
  };
  /** Selects note `n`, then measures `key` (from what its label says now: a re-fit since the
   * list was read may have moved it). */
  const edit = async (kind: Kind, n: NoteInfo, key: (now: NoteInfo) => string) =>
    measure(page, key(await select(page, n.id)), `${kind} on ${n.id}`);
  for (const kind of KINDS) {
    if (kind === 'redo') continue; // measured with undo
    const notes = await notesNow(page);
    const used = new Set<string>();
    switch (kind) {
      case 'set fret':
        await run(
          kind,
          spread(notes, per, () => true, used),
          (n) => edit(kind, n, fretKey),
        );
        break;
      case 'string move':
        await run(kind, spread(notes, per + SPARE, movable, used), async (n) => {
          const now = await select(page, n.id);
          return movable(now) ? measure(page, moveKey(now), `${kind} on ${n.id}`) : null;
        });
        break;
      case 'confirm':
        await run(
          kind,
          spread(notes, per, (n) => n.flagged, used),
          (n) => edit(kind, n, () => 'Enter'),
        );
        break;
      case 'insert':
        await run(
          kind,
          spread(notes, per, () => true, used),
          (n) => edit(kind, n, () => 'i'),
        );
        break;
      case 'delete':
        await run(
          kind,
          spread(notes, per, () => true, used),
          (n) => edit(kind, n, () => 'Delete'),
        );
        break;
      case 'undo': {
        // Each note: an unmeasured fret change, then its undo and its redo, measured.
        const undo: number[] = [];
        const redo: number[] = [];
        for (const [i, n] of spread(notes, per, () => true, used).entries()) {
          await unmeasured(page, fretKey(await select(page, n.id)), `set fret on ${n.id}`);
          const u = await measure(page, 'Control+z', `undo on ${n.id}`);
          const r = await measure(page, 'Control+Shift+Z', `redo on ${n.id}`);
          if (i >= WARM_UP) {
            undo.push(u);
            redo.push(r);
          }
        }
        samples.set('undo', undo);
        samples.set('redo', redo);
        break;
      }
    }
  }
  return samples;
}

function rows(shape: Row['shape'], samples: Map<Kind, number[]>): Row[] {
  return KINDS.map((kind) => {
    const times = samples.get(kind) ?? [];
    return {
      shape,
      kind,
      n: times.length,
      medianMs: round(percentile(times, 50)),
      p95Ms: round(percentile(times, 95)),
      gated: shape === 'phrased',
    };
  });
}

function table(all: readonly Row[]): string {
  const head = ['shape', 'kind', 'n', 'median ms', 'p95 ms', ''];
  const body = all.map((r) => [
    r.shape,
    r.kind,
    String(r.n),
    r.medianMs.toFixed(1),
    r.p95Ms.toFixed(1),
    r.gated ? (r.p95Ms <= BUDGET_MS ? 'ok' : 'OVER BUDGET') : 'not gated',
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  return [head, ...body].map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join('  ')).join('\n');
}

/** Logs the shape's table and attaches it as JSON; checks every kind has its samples. */
async function report(testInfo: TestInfo, shape: Row['shape'], result: readonly Row[]) {
  const name = shape === 'phrased' ? 'edit-latency.json' : 'edit-latency-one-phrase.json';
  console.log(
    `Edit-to-paint, 500 notes, ${shape} (budget p95 ≤ ${BUDGET_MS} ms):\n${table(result)}`,
  );
  await testInfo.attach(name, {
    body: JSON.stringify({ budgetMs: BUDGET_MS, rows: result }, null, 2),
    contentType: 'application/json',
  });
  for (const r of result)
    expect(r.n, `${r.shape} ${r.kind}: samples`).toBeGreaterThanOrEqual(SAMPLES);
}

test('every edit kind paints within 100 ms (p95) on a phrased 500-note tab', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  await openTab500(page, false);
  const phrased = rows('phrased', await runKinds(page));
  await report(testInfo, 'phrased', phrased);
  const over = phrased.filter((r) => r.p95Ms > BUDGET_MS).map((r) => `${r.kind} (${r.p95Ms} ms)`);
  expect(over, `edit kinds over the ${BUDGET_MS} ms p95 budget`).toEqual([]);
});

test('one 500-note phrase: edit-to-paint reported, not gated', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await openTab500(page, true);
  await report(testInfo, 'one phrase', rows('one phrase', await runKinds(page)));
});
