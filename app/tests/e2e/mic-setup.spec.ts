import { expect, test } from '@playwright/test';
import { countGetUserMedia, expectNoSeriousAxe, gumCalls } from './mic-helpers';

// The production build: Record shows the mic setup card and never asks for the mic on its own.
test('Record shows the setup card and makes no getUserMedia call', async ({ page }) => {
  await countGetUserMedia(page);
  await page.goto('./#/record');

  const card = page.getByRole('region', { name: 'TabCreator needs your microphone' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Audio is analysed on this computer and never uploaded.');
  await expect(card.getByRole('button', { name: 'Allow microphone' })).toBeEnabled();
  expect(await gumCalls(page)).toBe(0);

  await expectNoSeriousAxe(page);
  expect(await gumCalls(page)).toBe(0);
});

// A returning player whose permission is no longer granted: resume() asks nothing.
test('a return with micGranted but no granted permission shows the setup card, no calls', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('tabcreator.prefs.v1', JSON.stringify({ version: 1, micGranted: true }));
    Object.defineProperty(navigator.permissions, 'query', {
      value: () => Promise.resolve({ state: 'prompt' }),
      configurable: true,
    });
  });
  await countGetUserMedia(page);
  await page.goto('./#/record');

  const card = page.getByRole('region', { name: 'TabCreator needs your microphone' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Allow microphone' })).toBeEnabled();
  await page.waitForTimeout(300);
  expect(await gumCalls(page)).toBe(0);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('tabcreator.prefs.v1') ?? '{}')),
  ).toMatchObject({ micGranted: true });
});

// Retro A4: a first visit to the Tuner in the production build shows the setup card and asks
// the browser for nothing (no permission granted, as for a new player).
test('Tuner shows the setup card and makes no getUserMedia call', async ({ page }) => {
  await countGetUserMedia(page);
  await page.goto('./#/tuner');

  const card = page.getByRole('region', { name: 'TabCreator needs your microphone' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Allow microphone' })).toBeEnabled();
  await page.waitForTimeout(300);
  expect(await gumCalls(page)).toBe(0);
});
