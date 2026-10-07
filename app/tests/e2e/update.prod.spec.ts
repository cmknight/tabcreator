import { expect, test, type Page } from '@playwright/test';
import { collectErrors, recordButton, stopButton, timer } from './helpers';
import { watchHygiene } from './hygiene';
import { meter } from './mic-helpers';
import { waitForController } from './pwa-helpers';
import { readTab } from './storage-helpers';
import { noteButton, noteButtons } from './tab-helpers';
import { startUpdateServer, type UpdateServer } from './update-server';

// Story "Update available prompt" (CAP-20, CAP-25, spine AD-16, AD-19), in the production-mic
// lane: build A (dist/) installed from an in-test server, then build B (dist-update/, the same
// app as a new version) deployed to the same origin. B's worker waits until the player clicks
// Reload in the "Update available" toast, which is never offered while recording or analysing,
// and Reload saves a pending edit before B loads.

test.describe.configure({ mode: 'serial' });

let server: UpdateServer;
test.beforeEach(async () => {
  // A fresh origin per test (an ephemeral port): no worker or storage from another test.
  server = await startUpdateServer();
});
test.afterEach(async () => {
  await server.close();
});

/** The `tabcreator-build` meta of the loaded page: null for build A, "B" for build B. */
const build = (page: Page) =>
  page.evaluate(
    () => document.querySelector<HTMLMetaElement>('meta[name="tabcreator-build"]')?.content ?? null,
  );

/** Waits (through the reload) for build B's page. */
const expectBuildB = (page: Page) =>
  expect(page.locator('meta[name="tabcreator-build"]')).toHaveAttribute('content', 'B', {
    timeout: 15_000,
  });

/** Asks the browser to check for a new version (as the app does when visible and hourly). */
const checkForUpdate = (page: Page) =>
  page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.update();
  });

/** Whether a new worker is installed and waiting. */
const hasWaiting = (page: Page) =>
  page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting !== null);

const updateToast = (page: Page) =>
  page.getByTestId('toast').filter({ hasText: 'Update available' });
const reloadInToast = (page: Page) =>
  updateToast(page).getByRole('button', { name: 'Reload', exact: true });

/** Build A installed and controlling the page; build B deployed and detected (waiting). */
async function deployB(page: Page) {
  server.serveUpdate();
  await checkForUpdate(page);
  await expect.poll(() => hasWaiting(page), { timeout: 15_000 }).toBe(true);
}

test('B waits: a plain reload still serves A, until Reload in the "Update available" toast', async ({
  page,
}) => {
  const hygiene = await watchHygiene(page, server.url);
  const errors = collectErrors(page);
  await page.goto(`${server.url}#/record`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Record');
  const { script } = await waitForController(page);
  expect(await build(page)).toBeNull();

  await deployB(page);
  await expect(updateToast(page)).toBeVisible();
  await expect(reloadInToast(page)).toBeVisible();
  // Persistent: still there well past a plain toast's 4 s.
  await page.waitForTimeout(5_000);
  await expect(updateToast(page)).toBeVisible();

  // A plain reload is still build A, under A's worker; B still waits and is offered again.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Record');
  expect(await build(page)).toBeNull();
  expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe(script);
  expect(await hasWaiting(page)).toBe(true);
  await expect(updateToast(page)).toBeVisible();

  // Reload: B's worker takes over and the page reloads into B.
  await reloadInToast(page).click();
  await expectBuildB(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Record');
  await waitForController(page);
  expect(await hasWaiting(page)).toBe(false);
  await expect(updateToast(page)).toHaveCount(0);

  expect(errors).toEqual([]);
  hygiene.expectClean();
});

test('an update while recording waits for Stop and analysis; Reload keeps a just-edited note', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const hygiene = await watchHygiene(page, server.url);
  const errors = collectErrors(page);
  await page.goto(`${server.url}#/record`);
  await waitForController(page);
  await page.getByRole('button', { name: 'Allow microphone' }).click();
  await expect(meter(page)).toBeVisible();

  await recordButton(page).click();
  await expect(timer(page)).toHaveText('0:01', { timeout: 5_000 });
  await deployB(page);
  // Never offered while recording: the prompt polls busy every second, so give it a few polls.
  await expect(timer(page)).toHaveText('0:05', { timeout: 10_000 });
  await expect(updateToast(page)).toHaveCount(0);

  await stopButton(page).click();
  await expect(page).toHaveURL(/#\/tab\/[^/]+$/, { timeout: 15_000 });
  await expect(page.getByTestId('tab-status-line')).toBeVisible({ timeout: 20_000 });
  const takeId = decodeURIComponent(new URL(page.url()).hash.slice('#/tab/'.length));
  // Analysed and idle: now the prompt.
  await expect(updateToast(page)).toBeVisible({ timeout: 10_000 });
  expect(await build(page)).toBeNull();

  // Edit a note, then Reload at once, inside the 300 ms save debounce: the flush saves it.
  type StoredTab = { notes: { id: string; fret: number; locked: boolean }[] };
  const analysed = await readTab<StoredTab>(page, takeId);
  await expect(noteButtons(page).first()).toBeVisible();
  const target = analysed!.notes.find((n) => n.fret !== 5);
  expect(target, 'a note whose fret is not already 5').toBeDefined();
  await noteButton(page, target!.id).click();
  await expect(noteButton(page, target!.id)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('5');
  await expect(noteButton(page, target!.id)).toHaveAttribute('aria-label', /, fret 5, /);
  await reloadInToast(page).click();

  await expectBuildB(page);
  await expect
    .poll(async () =>
      (await readTab<StoredTab>(page, takeId))?.notes.find((n) => n.id === target!.id),
    )
    .toMatchObject({ fret: 5, locked: true });
  await expect(noteButton(page, target!.id)).toHaveAttribute('aria-label', /, fret 5, /);

  expect(errors).toEqual([]);
  hygiene.expectClean();
});
