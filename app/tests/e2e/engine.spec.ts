import { expect, test, type Page } from '@playwright/test';

/** Collects console errors and warnings plus uncaught page errors. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

test('Settings shows the engine version', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('./#/settings');
  await expect(page.getByRole('heading', { level: 2, name: 'About' })).toBeVisible();
  await expect(page.getByTestId('engine-version')).toHaveText(/^Engine v\d+\.\d+\.\d+$/);
  await expect(page.getByText('The analysis engine failed to load')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a wasm that fails to load shows the engine-failed banner with Reload', async ({ page }) => {
  const errors = collectErrors(page);
  await page.route('**/*.wasm', (route) => route.abort());
  await page.goto('./#/settings');
  await expect(page.getByText('The analysis engine failed to load')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
  await expect(page.getByTestId('engine-version')).toHaveText('Engine version unavailable');
  // Only the blocked wasm request itself may log.
  expect(errors.filter((e) => !e.includes('Failed to load resource'))).toEqual([]);

  // Reload goes through session/app-reload.ts; with the wasm unblocked the engine loads.
  await page.unroute('**/*.wasm');
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByTestId('engine-version')).toHaveText(/^Engine v\d+\.\d+\.\d+$/);
});
