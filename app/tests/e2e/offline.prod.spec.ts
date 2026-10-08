import { expect, test, type Page, type Response } from '@playwright/test';
import { readTokens } from '../../build/pwa-icons';
import { copy, download } from './export-helpers';
import { collectErrors, recordButton, stopButton, timer } from './helpers';
import { watchHygiene } from './hygiene';
import { meter } from './mic-helpers';
import { appManifest, installabilityErrors, waitForController } from './pwa-helpers';
import { readTab } from './storage-helpers';
import { noteButton, noteButtons } from './tab-helpers';

// Story "Installable offline app" (CAP-20, US-8.1, spine AD-19), in the production-mic lane
// (`prod-mic` project): the production build at the root, with Chromium's fake capture device
// as the microphone.

/** Words an offline indicator would use (EXPERIENCE State Patterns, Offline: "No indicator"). */
const OFFLINE_WORDS = /offline|no connection|network/i;

/**
 * The announcer's two regions (ui/a11y/announcer.ts): the polite `status` and the assertive
 * `alert`. Nothing else in the app sets `aria-live`.
 */
const ANNOUNCER = '[role="status"][aria-live="polite"], [role="alert"][aria-live="assertive"]';

/**
 * Banners and alerts by their stable hooks: every error banner's test id, the Library's notices,
 * and any `role="alert"` but the announcer's assertive region.
 */
const BANNERS = [
  '[data-testid$="banner"]',
  '[data-testid$="-failed"]',
  '[data-testid$="storage-full"]',
  '[data-testid="restore-error"]',
  '[data-testid="persist-notice"]',
  '[role="alert"]:not([aria-live="assertive"])',
].join(', ');

/**
 * CAP-25 states sweep: offline shows no indicator. No shown text outside the announcer's two
 * regions mentions being offline or the network, and no banner or alert shows.
 */
async function expectNoOfflineIndicator(p: Page): Promise<void> {
  const texts = await p.evaluate((announcer) => {
    const found: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = n.parentElement;
      if (!parent || parent.closest(`${announcer}, script, style, noscript`)) continue;
      // Hidden nodes (display: none, the hidden attribute, visibility: hidden) show nothing.
      if (!parent.checkVisibility({ visibilityProperty: true })) continue;
      const text = n.textContent?.trim();
      if (text) found.push(text);
    }
    return found;
  }, ANNOUNCER);
  expect(texts.length).toBeGreaterThan(0);
  expect(texts.filter((t) => OFFLINE_WORDS.test(t))).toEqual([]);
  await expect(p.locator(BANNERS)).toHaveCount(0);
}

test('the manifest is valid, from the tokens, and Chrome reports the app installable', async ({
  page,
  baseURL,
}) => {
  const hygiene = await watchHygiene(page, baseURL!);
  await page.goto('./#/record');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    './manifest.webmanifest',
  );
  // A service worker controls the page on its first visit (clientsClaim), with no reload.
  const sw = await waitForController(page);
  expect(sw.script).toBe(new URL('sw.js', baseURL).href);
  expect(sw.scope).toBe(new URL('./', baseURL).href);

  const { url, errors, manifest } = await appManifest(page);
  expect(url).toBe(new URL('manifest.webmanifest', baseURL).href);
  expect(errors).toEqual([]);
  const tokens = readTokens();
  expect(manifest).toMatchObject({
    name: 'TabCreator',
    short_name: 'TabCreator',
    display: 'standalone',
    start_url: './',
    scope: './',
    id: './',
    background_color: tokens.background,
    theme_color: tokens.background,
  });
  const icons = manifest.icons as { src: string; sizes: string; purpose: string }[];
  expect(icons.map((i) => `${i.sizes} ${i.purpose}`)).toEqual([
    '192x192 any',
    '512x512 any',
    '512x512 maskable',
  ]);
  for (const icon of icons) {
    const res = await page.request.get(new URL(icon.src, url).href);
    expect(res.headers()['content-type']).toBe('image/png');
  }

  await expect.poll(() => installabilityErrors(page)).toEqual([]);
  hygiene.expectClean();
});

// Done when 1 (US-8.1): after one online visit, with the network off, the app loads from the
// service worker and a player records a take that analyses, edits a note, and copies and
// downloads the tab.
test('offline after one visit: the app loads from the service worker; record, analyse, edit, export', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(90_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const hygiene = await watchHygiene(page, baseURL!, { offline: true });
  const errors = collectErrors(page);

  // The one online visit: the service worker installs (precaching the app) and takes control.
  await page.goto('./#/record');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Record');
  await waitForController(page);

  await context.setOffline(true);
  const responses: Response[] = [];
  page.on('response', (r) => responses.push(r));
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Record');
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  await expectNoOfflineIndicator(page);

  // Everything the page loaded came from the service worker: the navigation and its assets.
  const origin = new URL(baseURL!).origin;
  const own = responses.filter(
    (r) => !r.url().startsWith('blob:') && new URL(r.url()).origin === origin,
  );
  const navigation = own.find((r) => r.request().isNavigationRequest());
  expect(navigation?.fromServiceWorker()).toBe(true);
  expect(own.some((r) => /\/assets\/index-[\w-]+\.js$/.test(r.url()))).toBe(true);
  expect(own.filter((r) => !r.fromServiceWorker()).map((r) => r.url())).toEqual([]);

  // Record a take: the recorder worklet, the OPFS worker, the engine worker and its wasm all
  // come from the precache.
  await page.getByRole('button', { name: 'Allow microphone' }).click();
  await expect(meter(page)).toBeVisible();
  await recordButton(page).click();
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(timer(page)).toHaveText('0:02', { timeout: 5_000 });
  await stopButton(page).click();
  await expect(page).toHaveURL(/#\/tab\/[^/]+$/, { timeout: 15_000 });
  await expect(page.getByTestId('tab-status-line')).toBeVisible({ timeout: 20_000 });
  const takeId = decodeURIComponent(new URL(page.url()).hash.slice('#/tab/'.length));

  // It analysed: the stored tab has notes.
  type StoredTab = { notes: { id: string; fret: number; locked: boolean }[] };
  const analysed = await readTab<StoredTab>(page, takeId);
  expect(analysed?.notes.length ?? 0).toBeGreaterThan(0);

  // Edit one note: a digit sets its fret, and the change is stored.
  await expect(noteButtons(page).first()).toBeVisible();
  const found = analysed!.notes.find((n) => n.fret !== 5);
  expect(found, 'a note whose fret is not already 5').toBeDefined();
  const target = found!;
  await noteButton(page, target.id).click();
  await expect(noteButton(page, target.id)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('5');
  await expect(noteButton(page, target.id)).toHaveAttribute('aria-label', /, fret 5, /);
  await expect
    .poll(async () =>
      (await readTab<StoredTab>(page, takeId))?.notes.find((n) => n.id === target.id),
    )
    .toMatchObject({ fret: 5, locked: true });

  // Copy and Download give the same tab text.
  const copied = await copy(page);
  const { name, text } = await download(page);
  expect(name).toMatch(/\.txt$/);
  expect(text).toBe(copied);
  expect(text.startsWith('TabCreator — ')).toBe(true);

  expect(errors).toEqual([]);
  await expectNoOfflineIndicator(page);

  // A fresh page, still offline, opens from the service worker too: at the start URL and at a
  // deep link to the recorded take, which shows the edited note. Each page is closed before the
  // next opens, so it holds the instance lock alone.
  await page.close();
  const openOffline = async (url: string) => {
    const fresh = await context.newPage();
    const loaded: Response[] = [];
    fresh.on('response', (r) => loaded.push(r));
    const freshErrors = collectErrors(fresh);
    await fresh.goto(url);
    return { fresh, loaded, freshErrors };
  };
  const expectFromServiceWorker = (loaded: Response[]) => {
    const own = loaded.filter(
      (r) => !r.url().startsWith('blob:') && new URL(r.url()).origin === origin,
    );
    expect(own.find((r) => r.request().isNavigationRequest())?.fromServiceWorker()).toBe(true);
    expect(own.some((r) => /\/assets\/index-[\w-]+\.js$/.test(r.url()))).toBe(true);
    expect(own.filter((r) => !r.fromServiceWorker()).map((r) => r.url())).toEqual([]);
  };

  const start = await openOffline('./');
  await expect(start.fresh.getByRole('heading', { level: 1 })).toHaveText('Record');
  expectFromServiceWorker(start.loaded);
  await expectNoOfflineIndicator(start.fresh);
  expect(start.freshErrors).toEqual([]);
  await start.fresh.close();

  const deep = await openOffline(`./#/tab/${encodeURIComponent(takeId)}`);
  await expect(noteButton(deep.fresh, target.id)).toHaveAttribute('aria-label', /, fret 5, /);
  expectFromServiceWorker(deep.loaded);
  await expectNoOfflineIndicator(deep.fresh);
  expect(deep.freshErrors).toEqual([]);
  await deep.fresh.close();

  hygiene.expectClean();
});
