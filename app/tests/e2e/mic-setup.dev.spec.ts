import { expect, test, type Page } from '@playwright/test';
import { countGetUserMedia, expectNoSeriousAxe, gumCalls } from './mic-helpers';

// Runs in the `dev` project only: the fake mic (US-0.4) plays open_strings as the microphone.

const SETUP_TITLE = 'TabCreator needs your microphone';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

const setupCard = (page: Page) => page.getByRole('region', { name: SETUP_TITLE });
const meter = (page: Page) => page.getByRole('meter', { name: 'Input level' });

async function readMeter(page: Page): Promise<number> {
  return Number(await meter(page).getAttribute('aria-valuenow'));
}

/** Expects the meter to show a changed value before 1 s has passed since `clickedAt`. */
async function expectMeterMoving(page: Page, clickedAt: number) {
  const deadline = clickedAt + 1000;
  await expect(meter(page)).toBeVisible({ timeout: Math.max(1, deadline - Date.now()) });
  const first = await readMeter(page);
  await expect
    .poll(() => readMeter(page), { timeout: Math.max(1, deadline - Date.now()) })
    .not.toBe(first);
  expect(Date.now()).toBeLessThan(deadline);
}

const storedPrefs = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('tabcreator.prefs.v1') ?? 'null'));

test('first visit, Allow, re-enter and return', async ({ page }) => {
  const errors = collectErrors(page);
  await countGetUserMedia(page);

  // First visit: the card, no getUserMedia.
  await page.goto('./?fakeMic=open_strings#/record');
  await expect(setupCard(page)).toBeVisible();
  await expect(setupCard(page)).toContainText(
    'Audio is analysed on this computer and never uploaded.',
  );
  expect(await gumCalls(page)).toBe(0);
  // Seed another pref so the micGranted write is shown to keep it.
  await page.evaluate(() =>
    localStorage.setItem('tabcreator.prefs.v1', JSON.stringify({ version: 1, theme: 'dark' })),
  );

  // Allow: one call, the card gives way to a level bar moving within 1 s of the click.
  const clickedAt = Date.now();
  await page.getByRole('button', { name: 'Allow microphone' }).click();
  await expectMeterMoving(page, clickedAt);
  await expect(setupCard(page)).toHaveCount(0);
  expect(await gumCalls(page)).toBe(1);

  // Re-enter straight away, while this stream's fixture is still playing: the bar is live again, no second call.
  const nav = page.getByRole('navigation');
  await nav.getByRole('link', { name: 'Tuner' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tuner');
  const reenteredAt = Date.now();
  await nav.getByRole('link', { name: 'Record' }).click();
  await expectMeterMoving(page, reenteredAt);
  expect(await gumCalls(page)).toBe(1);

  // micGranted saved, the seeded theme kept.
  const prefs = await storedPrefs(page);
  expect(prefs.micGranted).toBe(true);
  expect(prefs.theme).toBe('dark');

  // Axe on the live bar, last: the fixture may have gone silent by now, which axe does not mind.
  await expectNoSeriousAxe(page);

  // Return with micGranted: after a reload the card shows again and nothing is requested.
  await page.reload();
  await expect(setupCard(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow microphone' })).toBeEnabled();
  expect(await gumCalls(page)).toBe(0);
  expect((await storedPrefs(page)).micGranted).toBe(true);

  expect(errors).toEqual([]);
});

test('a rejected request leaves the card with the button enabled', async ({ page }) => {
  const errors = collectErrors(page);
  await countGetUserMedia(page);
  // An unknown fixture: the fake mic rejects with NotFoundError.
  await page.goto('./?fakeMic=nope#/record');

  const allow = page.getByRole('button', { name: 'Allow microphone' });
  await allow.click();
  await expect(allow).toBeEnabled();
  await expect(setupCard(page)).toBeVisible();
  await expect(meter(page)).toHaveCount(0);
  expect(await gumCalls(page)).toBe(1);
  // No retry loop.
  await page.waitForTimeout(300);
  expect(await gumCalls(page)).toBe(1);
  expect(errors).toEqual([]);
});
