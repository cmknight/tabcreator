import { expect, test } from '@playwright/test';
import { CSP } from '../../vite.config';
import { watchHygiene } from './hygiene';

// The built site under the production CSP (spine AD-13): no violations, no failed requests, and
// every request stays on the page's own origin.
test('the production build has the CSP and keeps to it', async ({ page, baseURL }) => {
  const hygiene = await watchHygiene(page, baseURL!);

  await page.goto('./#/record');
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
    'content',
    CSP,
  );
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Record');

  for (const [hash, title] of [
    ['#/library', 'Library'],
    ['#/tuner', 'Tuner'],
    ['#/settings', 'Settings'],
    ['#/tab/x', 'Tab'],
  ] as const) {
    await page.goto(`./${hash}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
    if (hash === '#/settings') {
      // Starts the engine worker (worker-src). The wasm compiles inside the worker, which a
      // document's meta CSP does not govern, so 'wasm-unsafe-eval' is not exercised here.
      await expect(page.getByTestId('engine-version')).toHaveText(/^Engine v\d+\.\d+\.\d+$/);
    }
  }

  hygiene.expectClean();
});
