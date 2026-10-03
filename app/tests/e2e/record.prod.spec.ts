import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { watchHygiene } from './hygiene';

// The production-mic lane (`prod-mic` project): the production build, with Chromium's fake
// capture device looping testdata/synth/c_major_scale_pos1_noisy.wav as the microphone, the
// permission granted and Chrome's own autoplay policy.

const ASSETS = join(import.meta.dirname, '..', '..', 'dist', 'assets');

const recordButton = (page: Page) => page.getByRole('button', { name: 'Record', exact: true });
const stopButton = (page: Page) => page.getByRole('button', { name: 'Stop', exact: true });

async function goLive(page: Page): Promise<void> {
  await page.goto('./#/record');
  await page.getByRole('button', { name: 'Allow microphone' }).click();
  await expect(page.getByRole('meter', { name: 'Input level' })).toBeVisible();
  await expect(recordButton(page)).toBeVisible();
}

// Story 3.4: recording loads the recorder worklet from its own same-origin JS file, under the
// production CSP, with no violation.
test('Record then Stop loads the worklet as a same-origin script with no CSP violation', async ({
  page,
  baseURL,
}) => {
  // Chromium reports worklet module fetches neither as requests nor in resource timing, so
  // the built files show where the worklet comes from: its own JS file, which the app's
  // bundle references by a relative (same-origin) URL, never inlined as data: or blob:.
  const files = readdirSync(ASSETS);
  const worklet = files.filter((f) => /^recorder-worklet-[\w-]+\.js$/.test(f));
  expect(worklet).toHaveLength(1);
  const bundles = files.filter((f) => f.endsWith('.js') && !worklet.includes(f));
  expect(
    bundles.filter((f) => readFileSync(join(ASSETS, f), 'utf8').includes(worklet[0]!)),
  ).toHaveLength(1);
  const served = await page.request.get(new URL(`assets/${worklet[0]}`, baseURL).href);
  expect(served.headers()['content-type']).toMatch(/javascript/);
  expect(await served.text()).toContain('registerProcessor');

  const hygiene = await watchHygiene(page, baseURL!);
  await goLive(page);
  await recordButton(page).click();
  // The timer runs only once the worklet is loaded and the capture started.
  await expect(page.getByRole('timer')).toHaveText('0:01', { timeout: 5_000 });
  await stopButton(page).click();
  await expect(page).toHaveURL(/#\/tab\/[^/]+$/, { timeout: 15_000 });
  hygiene.expectClean();
});

// Done when 1: Space starts a take within 100 ms of the keydown, measured by the two marks the
// production build sets (`record-keydown` at the handled keydown, `record-capture-start` when
// the worklet copies its first frame); Space again stops it and opens its Tab.
test('Space starts a take within 100 ms, and Space again stops it and opens its Tab', async ({
  page,
  baseURL,
}) => {
  const hygiene = await watchHygiene(page, baseURL!);
  await goLive(page);
  // Focus on the page itself, not a control: Space on a focused button is the button's own.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  await page.keyboard.press('Space');
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() => page.evaluate(() => performance.getEntriesByName('record-capture-start').length))
    .toBe(1);
  const marks = await page.evaluate(() => ({
    keydown: performance.getEntriesByName('record-keydown').map((e) => e.startTime),
    start: performance.getEntriesByName('record-capture-start').map((e) => e.startTime),
  }));
  expect(marks.keydown).toHaveLength(1);
  expect(marks.start).toHaveLength(1);
  const latencyMs = marks.start[0]! - marks.keydown[0]!;
  test.info().annotations.push({ type: 'space-to-capture-ms', description: latencyMs.toFixed(1) });
  expect(latencyMs).toBeGreaterThanOrEqual(0);
  expect(latencyMs).toBeLessThanOrEqual(100);

  await expect(page.getByRole('timer')).toHaveText('0:01', { timeout: 5_000 });
  // The page did not scroll on Space.
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.keyboard.press('Space');
  await expect(page).toHaveURL(/#\/tab\/[^/]+$/, { timeout: 15_000 });
  expect(
    await page.evaluate(() => performance.getEntriesByName('record-keydown').length),
  ).toBeGreaterThanOrEqual(2);
  hygiene.expectClean();
});
