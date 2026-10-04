import { expect, test, type Page } from '@playwright/test';
import { FIXTURE, expectNoSeriousAxe, goLive } from './mic-helpers';

// Story 5.7 (US-4.5, EXPERIENCE.md Tab states): the analysis states end to end, in the `dev`
// project (the fake mic and the dev hooks). Each test records a short take and lets the Tab
// screen analyse it. Dev hooks: `?slowAnalysis=<ms>` delays each engine analyze (to cancel or
// reload mid-analysis), `window.__analysisFailHook` forces `analysis-failed`, and
// `window.__commitStorageFullHook` makes the commit reject with `storage-full`.

/** How long the slowed analyses wait before the engine runs. */
const SLOW_MS = 2_000;

interface TakeState {
  status: string | null;
  rawExists: boolean;
  /** The saved tab's note count; null when there is no tab. */
  notes: number | null;
}

const recordButton = (page: Page) => page.getByRole('button', { name: 'Record', exact: true });
const stopButton = (page: Page) => page.getByRole('button', { name: 'Stop', exact: true });
const analysing = (page: Page) => page.getByText('Analysing…', { exact: true });
const systems = (page: Page) => page.getByTestId('tab-systems');

/**
 * Records about 2 s from the live fake mic and stops; `beforeStop` runs just before Stop (to set
 * a hook before analysis starts). Returns the take id once its Tab is showing.
 */
async function recordTake(page: Page, beforeStop?: () => Promise<void>): Promise<string> {
  await recordButton(page).click();
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('timer')).toHaveText('0:02', { timeout: 5_000 });
  await beforeStop?.();
  await stopButton(page).click();
  await expect(page).toHaveURL(/#\/tab\/[^/]+$/, { timeout: 15_000 });
  const id = decodeURIComponent(new URL(page.url()).hash.slice('#/tab/'.length));
  await expect(page.locator(`[data-take-id="${id}"]`)).toBeVisible();
  return id;
}

/** The take's status, whether its raw file exists and its tab's note count. */
function readState(page: Page, id: string): Promise<TakeState> {
  return page.evaluate(async (takeId) => {
    const get = (store: string) =>
      new Promise<unknown>((resolve, reject) => {
        const open = indexedDB.open('tabcreator');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const req = db.transaction(store).objectStore(store).get(takeId);
          req.onsuccess = () => {
            resolve(req.result ?? null);
            db.close();
          };
          req.onerror = () => reject(req.error);
        };
      });
    const take = (await get('takes')) as { status: string } | null;
    const tab = (await get('tabs')) as { notes: unknown[] } | null;
    let rawExists = true;
    try {
      const root = await navigator.storage.getDirectory();
      await (await root.getDirectoryHandle('raw')).getFileHandle(`${takeId}.f32`);
    } catch {
      rawExists = false;
    }
    return { status: take?.status ?? null, rawExists, notes: tab ? tab.notes.length : null };
  }, id);
}

/** Sets a dev hook on `window`. */
function setHook(page: Page, name: string, on: boolean): Promise<void> {
  return page.evaluate(
    ([key, value]) => {
      (window as unknown as Record<string, boolean>)[key] = value;
    },
    [name, on] as const,
  );
}

/** Counts the analyze requests posted to the engine worker from page start (`__analyzeCalls`). */
async function countAnalyzeRequests(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __analyzeCalls: number };
    w.__analyzeCalls = 0;
    const proto = Worker.prototype as unknown as { postMessage: (...args: unknown[]) => void };
    const post = proto.postMessage;
    proto.postMessage = function (this: Worker, ...args: unknown[]) {
      if ((args[0] as { type?: string } | null)?.type === 'analyze') w.__analyzeCalls += 1;
      post.apply(this, args);
    };
  });
}

const analyzeCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __analyzeCalls: number }).__analyzeCalls);

/** Errors other than the dev-only warnings the failure paths log on purpose. */
const unexpected = (errors: string[]) => errors.filter((e) => !e.includes('[tabcreator]'));

test('Cancel mid-analysis shows Analyse within 200 ms; the take stays recorded; Analyse then completes', async ({
  page,
}) => {
  const errors = await goLive(page, `${FIXTURE}&slowAnalysis=${SLOW_MS}`);
  const id = await recordTake(page);

  await expect(analysing(page)).toBeVisible();
  await expect(page.getByTestId('tab-analysis-percent')).toHaveText('0%');
  await expect(page.getByRole('progressbar', { name: 'Analysing…' })).toBeVisible();
  await expectNoSeriousAxe(page);

  // In the page: from the Cancel press to the Analyse button showing.
  await page.evaluate(() => {
    const w = window as unknown as { __cancel: { pressed: number | null; shown: number | null } };
    w.__cancel = { pressed: null, shown: null };
    document.addEventListener(
      'pointerdown',
      () => {
        w.__cancel.pressed ??= performance.now();
      },
      { capture: true, once: true },
    );
    const observer = new MutationObserver(() => {
      const shown = [...document.querySelectorAll('button')].some(
        (b) => b.textContent === 'Analyse',
      );
      if (shown) {
        w.__cancel.shown = performance.now();
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  const before = Date.now();
  await page.getByRole('button', { name: 'Cancel' }).click();
  const analyse = page.getByRole('button', { name: 'Analyse' });
  await expect(analyse).toBeVisible();
  const wallMs = Date.now() - before;
  const timing = await page.evaluate(
    () =>
      (window as unknown as { __cancel: { pressed: number | null; shown: number | null } })
        .__cancel,
  );
  expect(timing.pressed).not.toBeNull();
  expect(timing.shown).not.toBeNull();
  const cancelMs = timing.shown! - timing.pressed!;
  test
    .info()
    .annotations.push(
      { type: 'cancel-to-analyse-ms', description: cancelMs.toFixed(1) },
      { type: 'cancel-to-analyse-wall-ms', description: String(wallMs) },
    );
  // The in-page time is the check; the runner's wall time (click and polling overhead
  // included) is recorded above as an annotation only, as it varies with machine load.
  expect(cancelMs).toBeLessThanOrEqual(200);
  await expect(analyse).toBeFocused();
  await expect(analysing(page)).toHaveCount(0);

  // Past the slowed delay: nothing was committed, the raw file is kept.
  await page.waitForTimeout(SLOW_MS + 500);
  await expect(analyse).toBeVisible();
  expect(await readState(page, id)).toEqual({ status: 'recorded', rawExists: true, notes: null });

  await analyse.click();
  await expect(analysing(page)).toBeVisible();
  await expect(systems(page)).toBeVisible({ timeout: 15_000 });
  await expect(systems(page).locator('pre').first()).toContainText('e|');
  const state = await readState(page, id);
  expect(state).toMatchObject({ status: 'analyzed', rawExists: false });
  expect(state.notes).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('a forced analysis error shows "Analysis failed — try again" with Retry; Retry succeeds', async ({
  page,
}) => {
  const errors = await goLive(page);
  const id = await recordTake(page, () => setHook(page, '__analysisFailHook', true));

  const banner = page.getByTestId('tab-analysis-failed');
  await expect(banner).toBeVisible({ timeout: 10_000 });
  // Not a live region (AD-18): the shared announcer speaks it.
  await expect(banner).not.toHaveAttribute('role');
  await expect(page.locator('[aria-live="assertive"]')).toHaveText('Analysis failed — try again');
  await expect(banner).toContainText('Analysis failed — try again');
  // The technical detail is in the dev log only.
  await expect(banner).not.toContainText('dev hook');
  await expectNoSeriousAxe(page);
  expect(await readState(page, id)).toEqual({ status: 'recorded', rawExists: true, notes: null });

  await setHook(page, '__analysisFailHook', false);
  await banner.getByRole('button', { name: 'Retry' }).click();
  await expect(systems(page)).toBeVisible({ timeout: 15_000 });
  await expect(banner).toHaveCount(0);
  expect(await readState(page, id)).toMatchObject({ status: 'analyzed', rawExists: false });
  expect(unexpected(errors)).toEqual([]);
});

test('an engine that fails to load shows the engine banner with Reload, and no Retry', async ({
  page,
}) => {
  await page.route('**/*.wasm', (route) => route.abort());
  const errors = await goLive(page);
  const id = await recordTake(page);

  const banner = page.getByTestId('tab-engine-failed');
  await expect(banner).toBeVisible({ timeout: 10_000 });
  // Not a live region (AD-18): the shared announcer speaks it.
  await expect(banner).not.toHaveAttribute('role');
  await expect(page.locator('[aria-live="assertive"]')).toHaveText(
    'The analysis engine failed to load',
  );
  await expect(banner).toContainText('The analysis engine failed to load');
  await expect(banner.getByRole('button', { name: 'Reload' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  expect(await readState(page, id)).toMatchObject({ status: 'recorded', rawExists: true });

  // With the wasm back, Reload reloads the app (nothing is busy) and the take analyses.
  await page.unroute('**/*.wasm');
  await banner.getByRole('button', { name: 'Reload' }).click();
  await expect(systems(page)).toBeVisible({ timeout: 15_000 });
  expect(await readState(page, id)).toMatchObject({ status: 'analyzed', rawExists: false });
  expect(
    unexpected(errors).filter(
      (e) => !e.includes('Failed to load resource') && !e.includes('WebAssembly'),
    ),
  ).toEqual([]);
});

test('storage full on commit keeps the result; Retry saves it with no new engine run, then deletes the raw file', async ({
  page,
}) => {
  await countAnalyzeRequests(page);
  const errors = await goLive(page);
  const id = await recordTake(page, () => setHook(page, '__commitStorageFullHook', true));

  const banner = page.getByTestId('tab-storage-full');
  await expect(banner).toBeVisible({ timeout: 10_000 });
  // Not a live region (AD-18): the shared announcer speaks it.
  await expect(banner).not.toHaveAttribute('role');
  await expect(page.locator('[aria-live="assertive"]')).toHaveText(
    'Storage is full — delete takes or their audio, or back up and clear',
  );
  await expect(banner).toContainText(
    'Storage is full — delete takes or their audio, or back up and clear',
  );
  await expect(banner.getByRole('link', { name: 'Go to Library' })).toHaveAttribute(
    'href',
    '#/library',
  );
  await expectNoSeriousAxe(page);
  expect(await readState(page, id)).toEqual({ status: 'recorded', rawExists: true, notes: null });
  expect(await analyzeCalls(page)).toBe(1);

  await setHook(page, '__commitStorageFullHook', false);
  await banner.getByRole('button', { name: 'Retry' }).click();
  await expect(systems(page)).toBeVisible({ timeout: 10_000 });
  await expect(banner).toHaveCount(0);
  const state = await readState(page, id);
  expect(state).toMatchObject({ status: 'analyzed', rawExists: false });
  expect(state.notes).toBeGreaterThan(0);
  expect(await analyzeCalls(page)).toBe(1);
  expect(unexpected(errors)).toEqual([]);
});

test('a silent take shows "No notes found" with the three tips', async ({ page }) => {
  const errors = await goLive(page, 'silence_60s');
  const id = await recordTake(page);

  const noNotes = page.getByTestId('tab-no-notes');
  await expect(noNotes).toBeVisible({ timeout: 10_000 });
  await expect(noNotes.getByRole('heading', { name: 'No notes found' })).toBeVisible();
  await expect(noNotes.getByRole('listitem')).toHaveText([
    'Check the input level',
    'Play single notes',
    'Raise sensitivity in Analysis settings',
  ]);
  await expect(page.locator('pre')).toHaveCount(0);
  await expectNoSeriousAxe(page);
  expect(await readState(page, id)).toEqual({ status: 'analyzed', rawExists: false, notes: 0 });
  expect(errors).toEqual([]);
});

test('a reload mid-analysis analyses the take again on load, and it completes', async ({
  page,
}) => {
  const errors = await goLive(page, `${FIXTURE}&slowAnalysis=${SLOW_MS}`);
  const id = await recordTake(page);
  await expect(analysing(page)).toBeVisible();
  expect(await readState(page, id)).toMatchObject({ status: 'recorded', rawExists: true });

  await page.reload();
  await expect(page.locator(`[data-take-id="${id}"]`)).toBeVisible();
  await expect(analysing(page)).toBeVisible();
  await expect(systems(page)).toBeVisible({ timeout: 15_000 });
  const state = await readState(page, id);
  expect(state).toMatchObject({ status: 'analyzed', rawExists: false });
  expect(state.notes).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
