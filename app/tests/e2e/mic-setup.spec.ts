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
