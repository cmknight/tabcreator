import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { watchHygiene } from './hygiene';

// The production build (story 3.4): Chromium's fake capture device stands in for the mic.
// Recording loads the recorder worklet from its own same-origin JS file, under the production
// CSP, with no violation.
test.use({
  permissions: ['microphone'],
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
});

const ASSETS = join(import.meta.dirname, '..', '..', 'dist', 'assets');

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
  await page.goto('./#/record');
  await page.getByRole('button', { name: 'Allow microphone' }).click();
  await expect(page.getByRole('meter', { name: 'Input level' })).toBeVisible();
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  // The timer runs only once the worklet is loaded and the capture started.
  await expect(page.getByRole('timer')).toHaveText('0:01', { timeout: 5_000 });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page).toHaveURL(/#\/tab\/[^/]+$/, { timeout: 15_000 });
  hygiene.expectClean();
});
