import { expect, test, type Page } from '@playwright/test';
import { collectErrors } from './helpers';
import { expectNoSeriousAxe } from './mic-helpers';

// Runs in the `dev` project only: #/__test/ui exists only in dev builds (story 2.3).

const polite = (page: Page) => page.locator('[aria-live="polite"]');
const assertive = (page: Page) => page.locator('[aria-live="assertive"]');
const toast = (page: Page) => page.getByTestId('toast');

async function openPage(page: Page): Promise<string[]> {
  const errors = collectErrors(page);
  await page.goto('./#/__test/ui');
  await expect(page.getByRole('heading', { name: 'UI test page' })).toBeVisible();
  return errors;
}

test('one polite and one assertive live region on every route', async ({ page }) => {
  const errors = collectErrors(page);
  for (const hash of ['#/record', '#/library', '#/tuner', '#/settings', '#/tab/x', '#/__test/ui']) {
    await page.goto(`./${hash}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(polite(page)).toHaveCount(1);
    await expect(assertive(page)).toHaveCount(1);
    await expect(page.locator('[aria-live]')).toHaveCount(2);
  }
  expect(errors).toEqual([]);
});

test('announcements land in the matching region', async ({ page }) => {
  const errors = await openPage(page);
  await page.getByRole('button', { name: 'Announce polite' }).click();
  await expect(polite(page)).toHaveText('Polite test message');
  await page.getByRole('button', { name: 'Announce assertive' }).click();
  await expect(assertive(page)).toHaveText('Assertive test message');
  expect(errors).toEqual([]);
});

test('a toast shows bottom-centre, is announced and goes after 4 s', async ({ page }) => {
  const errors = await openPage(page);
  // Before the click: the toast's timer starts before click() resolves.
  const shownAt = Date.now();
  await page.getByRole('button', { name: 'Show toast', exact: true }).click();
  await expect(toast(page)).toHaveText('Toast test message');
  await expect(polite(page)).toHaveText('Toast test message');
  expect(await toast(page).getAttribute('aria-live')).toBeNull();

  const box = await toast(page).boundingBox();
  const viewport = page.viewportSize();
  expect(box && viewport).toBeTruthy();
  if (box && viewport) {
    expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(2);
    expect(box.y + box.height).toBeGreaterThan(viewport.height - 64);
  }

  await expectNoSeriousAxe(page);
  await expect(toast(page)).toBeHidden({ timeout: 6000 });
  expect(Date.now() - shownAt).toBeGreaterThanOrEqual(3900);
  expect(errors).toEqual([]);
});

test('the toast action is reachable by Tab and runs on Enter', async ({ page }) => {
  const errors = await openPage(page);
  await page.getByRole('button', { name: 'Show toast with action' }).click();
  const action = toast(page).getByRole('button', { name: 'Undo' });
  await expect(action).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(action).toBeFocused();
  await expectNoSeriousAxe(page);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('toast-action-result')).toHaveText('Action ran');
  await expect(toast(page)).toBeHidden();
  // Focus goes back where it was before entering the toast.
  await expect(page.getByRole('button', { name: 'Show toast with action' })).toBeFocused();
  expect(errors).toEqual([]);
});

test('a focused toast stays past 4 s', async ({ page }) => {
  const errors = await openPage(page);
  await page.getByRole('button', { name: 'Show toast with action' }).click();
  await page.keyboard.press('Tab');
  await page.waitForTimeout(5000);
  await expect(toast(page)).toBeVisible();
  await page.keyboard.press('Shift+Tab');
  // Resumes with the time that was left (just under 4 s).
  await expect(toast(page)).toBeHidden({ timeout: 6000 });
  expect(errors).toEqual([]);
});
