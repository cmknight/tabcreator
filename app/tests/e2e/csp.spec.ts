import { expect, test } from '@playwright/test';
import { CSP } from '../../vite.config';

// The built site under the production CSP (spine AD-13): no violations, and every request
// stays on the page's own origin.
test('the production build has the CSP and keeps to it', async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;

  // Reported out of the page from its very first script, so no reload can lose one.
  const violations: string[] = [];
  await page.exposeFunction('__reportCspViolation', (v: string) => violations.push(v));
  await page.addInitScript(() => {
    const report = (window as unknown as { __reportCspViolation: (v: string) => void })
      .__reportCspViolation;
    document.addEventListener('securitypolicyviolation', (e) => {
      void report(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  const refused: string[] = [];
  page.on('console', (msg) => {
    if (msg.text().includes('Refused to')) refused.push(msg.text());
  });
  const requests: string[] = [];
  page.context().on('request', (r) => requests.push(r.url()));

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

  expect(violations).toEqual([]);
  expect(refused).toEqual([]);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.filter((u) => new URL(u).origin !== origin)).toEqual([]);
});
