import { expect, test } from '@playwright/test';
import { watchHygiene } from './hygiene';

// Runs in the `subpath` project: the built app served under /tabcreator/ (serve-subpath.ts),
// as GitHub Pages serves a project site.
test('the build works under a sub-path', async ({ page, baseURL }) => {
  const hygiene = await watchHygiene(page, baseURL!);
  await page.goto('./#/settings');
  await expect(page).toHaveURL(/\/tabcreator\/#\/settings$/);
  await expect(page.getByTestId('engine-version')).toHaveText(/^Engine v\d+\.\d+\.\d+$/);
  hygiene.expectClean();
});
