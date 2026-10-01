import { expect, test } from '@playwright/test';

// Runs in the `subpath` project: the built app served under /tabcreator/ (serve-subpath.ts),
// as GitHub Pages serves a project site.
test('the build works under a sub-path', async ({ page }) => {
  const failed: string[] = [];
  page.on('response', (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
  });
  await page.goto('./#/settings');
  await expect(page).toHaveURL(/\/tabcreator\/#\/settings$/);
  await expect(page.getByTestId('engine-version')).toHaveText(/^Engine v\d+\.\d+\.\d+$/);
  expect(failed).toEqual([]);
});
