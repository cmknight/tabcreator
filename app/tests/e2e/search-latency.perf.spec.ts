import { expect, test, type Page } from '@playwright/test';
import { LIBRARY500_COUNT, library500Titles } from '../../src/dev/library500';
import { searchKey } from '../../src/model/library';
import { heading, list } from './library-helpers';
import {
  appendSummary,
  limitLabel,
  markdownTable,
  percentile,
  readLimit,
  round,
  withinLimit,
} from './perf-helpers';
import { library500Seed, restoreSeed, seedBackup } from './seed-helpers';

// Story "Search 500 takes" (CAP-17), on the production build (story "Latency gates and backup on
// the production build"): per-keystroke filter-to-paint in the Library with 500 takes. The
// generated library (src/dev/library500.ts titles and small tabs) is seeded as 500 analysed
// takes in a backup restored through the Library's Restore from backup (seed-helpers.ts); no dev
// page or hook. A keystroke's time runs from its key event's `timeStamp` to the first animation
// frame after the list reflects the filter (a MutationObserver until the shown count, the list's
// `aria-setsize` or 0 for the no-match state, is the expected one; then the next
// requestAnimationFrame, read in a task after it so that frame's layout and paint count), as in
// edit-latency.perf.spec.ts. Every keystroke is chosen to change the count, so each one has a DOM
// change to wait for. Gated at p95 ≤ `searchP95Ms` (app/budgets.json; `TABCREATOR_SEARCH_P95_MS`
// may lower it); the table goes to the log, a JSON attachment and the CI job summary, also when
// the gate fails, with the seeding time (the restore through the UI, end to end; reported, not gated). It runs in the `perf` project
// (playwright.config.ts): the production build, one worker, after every other project.

/** At least this many measured keystrokes. */
const MIN_KEYSTROKES = 20;
/** Unmeasured warm-up keystrokes before the samples. */
const WARM_UP = ['9', 'Backspace', '8', 'Backspace'];
/** The queries typed, one character at a time, then deleted with Backspace one at a time. */
const QUERIES = ['1239', 'roc', '450', 'et', 'ca'];

/** Each step: the key pressed and the query after it. */
function steps(): { key: string; query: string }[] {
  const out: { key: string; query: string }[] = [];
  for (const q of QUERIES) {
    for (let k = 1; k <= q.length; k += 1) out.push({ key: q[k - 1]!, query: q.slice(0, k) });
    for (let k = q.length - 1; k >= 0; k -= 1) out.push({ key: 'Backspace', query: q.slice(0, k) });
  }
  return out;
}

const keys = library500Titles().map(searchKey);
/** How many takes `query` shows (all of them for an empty query). */
const shownFor = (query: string) =>
  query.trim() === ''
    ? LIBRARY500_COUNT
    : keys.filter((k) => k.includes(searchKey(query.trim()))).length;

const searchField = (page: Page) => page.getByRole('searchbox', { name: 'Search takes' });

/**
 * Opens the Library, restores the 500 seeded takes and waits for the list of them; returns the
 * seeding time (the restore through the UI, end to end).
 */
async function openLibrary500(page: Page): Promise<number> {
  await page.goto('./#/library');
  await expect(heading(page)).toBeVisible();
  const started = Date.now();
  await restoreSeed(page, seedBackup(library500Seed()), {
    name: 'library500.zip',
    takes: LIBRARY500_COUNT,
    timeoutMs: 60_000,
  });
  const restoreMs = Date.now() - started;
  await expect(list(page).getByRole('listitem').first()).toHaveAttribute(
    'aria-setsize',
    String(LIBRARY500_COUNT),
    { timeout: 30_000 },
  );
  await installProbe(page);
  return restoreMs;
}

/**
 * Installs the in-page probe: a capturing keydown listener records the armed key's `timeStamp`;
 * `__search.arm(expected, what)` resolves with the filter-to-paint time once the shown count is
 * `expected` and the next frame has been laid out and painted (a requestAnimationFrame, then a
 * task after it); it rejects if the count already is `expected` (no change to wait for) or
 * after 10 s, naming `what`.
 */
function installProbe(page: Page) {
  return page.evaluate(() => {
    const screen = document.querySelector('main') ?? document.body;
    const shown = () => {
      const li = screen.querySelector('ul[aria-label="Takes, newest first"] > li[aria-setsize]');
      if (li) return Number(li.getAttribute('aria-setsize'));
      return /No takes match/.test(screen.textContent ?? '') ? 0 : -1;
    };
    const probe = {
      keyTs: null as number | null,
      result: null as Promise<number> | null,
      arm(expected: number, what: string) {
        probe.keyTs = null;
        // Each result is marked handled when stored (`measure` awaits it after the key press), so
        // a rejection before then is not an unhandled rejection in the page.
        const handled = (p: Promise<number>) => {
          p.catch(() => {});
          return p;
        };
        if (shown() === expected) {
          probe.result = handled(Promise.reject(new Error(`${what}: already ${expected} shown`)));
          return;
        }
        probe.result = handled(
          new Promise<number>((resolve, reject) => {
            const timer = setTimeout(() => {
              observer.disconnect();
              reject(new Error(`${what}: ${expected} takes never shown within 10 s`));
            }, 10_000);
            const observer = new MutationObserver(() => {
              if (probe.keyTs === null || shown() !== expected) return;
              observer.disconnect();
              clearTimeout(timer);
              const keyTs = probe.keyTs;
              // Read after the frame's layout and paint: in a task queued from its rAF callback.
              requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - keyTs), 0));
            });
            observer.observe(screen, {
              subtree: true,
              childList: true,
              characterData: true,
              attributes: true,
            });
          }),
        );
      },
    };
    window.addEventListener(
      'keydown',
      (e) => {
        if (probe.result !== null && probe.keyTs === null) probe.keyTs = e.timeStamp;
      },
      true,
    );
    (window as unknown as { __search: typeof probe }).__search = probe;
  });
}

/** Presses `key` with the probe armed for `expected` shown takes; returns its filter-to-paint. */
async function measure(page: Page, key: string, expected: number, what: string): Promise<number> {
  await page.evaluate(
    ([n, w]) =>
      (window as unknown as { __search: { arm(n: number, w: string): void } }).__search.arm(n, w),
    [expected, what] as const,
  );
  await page.keyboard.press(key);
  return page.evaluate(
    () => (window as unknown as { __search: { result: Promise<number> } }).__search.result,
  );
}

test('search filters 500 takes within the searchP95Ms limit (p95) per keystroke', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const limit = readLimit('searchP95Ms');
  const plan = steps();
  // Every step must change what is shown, or there is nothing to time.
  let before = LIBRARY500_COUNT;
  for (const s of plan) {
    const n = shownFor(s.query);
    expect(n, `"${s.query}" shows as many takes as the step before`).not.toBe(before);
    before = n;
  }
  expect(plan.length).toBeGreaterThanOrEqual(MIN_KEYSTROKES);

  const restoreMs = await openLibrary500(page);
  await searchField(page).focus();
  let query = '';
  for (const key of WARM_UP) {
    query = key === 'Backspace' ? query.slice(0, -1) : query + key;
    await measure(page, key, shownFor(query), `warm-up ${key}`);
  }

  const samples: { key: string; query: string; shown: number; ms: number }[] = [];
  for (const s of plan) {
    const shown = shownFor(s.query);
    const ms = await measure(page, s.key, shown, `${s.key} → "${s.query}"`);
    samples.push({ ...s, shown, ms: round(ms) });
  }
  await expect(searchField(page)).toHaveValue('');

  const times = samples.map((s) => s.ms);
  // Before any percentile: too few samples is its own clear failure.
  expect(times.length, 'measured keystrokes').toBeGreaterThanOrEqual(MIN_KEYSTROKES);
  const medianMs = round(percentile(times, 50));
  const p95Ms = round(percentile(times, 95));
  const ok = withinLimit(p95Ms, limit);
  console.log(
    `Search filter-to-paint, ${LIBRARY500_COUNT} takes (limit p95 ≤ ${limitLabel(limit)}; seeding through the restore UI ${restoreMs} ms):\n` +
      `keystrokes  median ms  p95 ms\n` +
      `${String(times.length).padEnd(10)}  ${medianMs.toFixed(1).padEnd(9)}  ${p95Ms.toFixed(1)}  ${ok ? 'ok' : 'OVER LIMIT'}`,
  );
  await testInfo.attach('search-latency.json', {
    body: JSON.stringify(
      {
        limitMs: limit.ms,
        budgetMs: limit.budgetMs,
        restoreMs,
        n: times.length,
        medianMs,
        p95Ms,
        samples,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
  appendSummary(
    [
      `## Search filter-to-paint, ${LIBRARY500_COUNT} takes (gated)`,
      '',
      markdownTable(
        ['Keystrokes', 'Median ms', 'p95 ms', 'Limit (p95)', 'Result'],
        [
          [
            String(times.length),
            medianMs.toFixed(1),
            p95Ms.toFixed(1),
            limitLabel(limit),
            ok ? 'pass' : 'FAIL',
          ],
        ],
      ),
      '',
      `Seeding (restore through the UI, end to end; ${LIBRARY500_COUNT} takes, reported, not a restore benchmark): ${restoreMs} ms`,
    ].join('\n'),
  );
  expect(ok, `p95 filter-to-paint ${p95Ms} ms over the limit ${limitLabel(limit)}`).toBe(true);
});
