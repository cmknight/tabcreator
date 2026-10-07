import { expect, test, type Response } from '@playwright/test';
import { watchHygiene } from './hygiene';
import { appManifest, installabilityErrors, waitForController } from './pwa-helpers';

// Runs in the `subpath` project: the built app served under /tabcreator/ (serve-subpath.ts),
// as GitHub Pages serves a project site.
test('the build works under a sub-path', async ({ page, baseURL }) => {
  const hygiene = await watchHygiene(page, baseURL!);
  await page.goto('./#/settings');
  await expect(page).toHaveURL(/\/tabcreator\/#\/settings$/);
  await expect(page.getByTestId('engine-version')).toHaveText(/^Engine v\d+\.\d+\.\d+$/);
  hygiene.expectClean();
});

// Story "Installable offline app" (AD-19): with the relative base, the manifest, the service
// worker's scope and its control of the page all resolve under the sub-path, and Chrome reports
// the app installable there too.
test('under a sub-path the manifest and service worker resolve there, and it is installable', async ({
  page,
  baseURL,
}) => {
  const hygiene = await watchHygiene(page, baseURL!, { offline: true });
  await page.goto('./#/record');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Record');
  const sw = await waitForController(page);
  expect(sw.script).toBe(new URL('sw.js', baseURL).href);
  expect(sw.scope).toBe(new URL('./', baseURL).href);
  expect(new URL(sw.scope).pathname).toBe('/tabcreator/');

  const { url, errors, manifest } = await appManifest(page);
  expect(url).toBe(new URL('manifest.webmanifest', baseURL).href);
  expect(errors).toEqual([]);
  // Chrome resolves start_url, scope and id against the manifest's URL: the sub-path.
  const served = await page.request.get(url);
  expect(served.headers()['content-type']).toBe('application/manifest+json');
  expect(manifest).toMatchObject({ start_url: './', scope: './', id: './' });

  await expect.poll(() => installabilityErrors(page)).toEqual([]);

  // Offline, a reload opens the app from the service worker under the sub-path.
  await page.context().setOffline(true);
  const loaded: Response[] = [];
  page.on('response', (r) => loaded.push(r));
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Record');
  const navigation = loaded.find((r) => r.request().isNavigationRequest());
  expect(new URL(navigation!.url()).pathname).toBe('/tabcreator/');
  expect(navigation!.fromServiceWorker()).toBe(true);
  const own = loaded.filter((r) => new URL(r.url()).origin === new URL(baseURL!).origin);
  expect(own.some((r) => /\/tabcreator\/assets\/index-[\w-]+\.js$/.test(r.url()))).toBe(true);
  expect(own.filter((r) => !r.fromServiceWorker()).map((r) => r.url())).toEqual([]);
  hygiene.expectClean();
});
