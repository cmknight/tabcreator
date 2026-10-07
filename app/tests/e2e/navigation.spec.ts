import { expect, test } from '@playwright/test';

const screens = [
  { link: 'Library', hash: '#/library', title: 'Library' },
  { link: 'Tuner', hash: '#/tuner', title: 'Tuner' },
  { link: 'Settings', hash: '#/settings', title: 'Settings' },
  { link: 'Record', hash: '#/record', title: 'Record' },
] as const;

test('empty hash opens Record', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Record');
  await expect(page).toHaveURL(/#\/record$/);
});

test('unknown hash falls back to Record', async ({ page }) => {
  await page.goto('./#/nope');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Record');
  await expect(page).toHaveURL(/#\/record$/);
});

test('nav links, the tab route and back/forward', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('./#/record');
  const nav = page.getByRole('navigation');
  const h1 = page.getByRole('heading', { level: 1 });
  await expect(h1).toHaveText('Record');

  for (const s of screens) {
    await nav.getByRole('link', { name: s.link }).click();
    await expect(page).toHaveURL(new RegExp(`${s.hash.replace('/', '\\/')}$`));
    await expect(h1).toHaveText(s.title);
    // A route change moves focus to the new screen's h1.
    await expect(h1).toBeFocused();
    await expect(nav.getByRole('link', { name: s.link })).toHaveAttribute('aria-current', 'page');
  }

  await page.goto('./#/tab/abc');
  await expect(h1).toHaveText('Tab');
  await expect(page.locator('[data-take-id="abc"]')).toBeVisible();

  // History: record → library → tuner → settings → record → tab/abc
  await page.goBack();
  await expect(page).toHaveURL(/#\/record$/);
  await expect(h1).toHaveText('Record');
  await expect(h1).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(h1).toHaveText('Settings');
  await expect(h1).toBeFocused();
  await page.goBack();
  await expect(h1).toHaveText('Tuner');
  await expect(h1).toBeFocused();
  await page.goForward();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(h1).toHaveText('Settings');
  await expect(h1).toBeFocused();
  await page.goForward();
  await expect(h1).toHaveText('Record');
  await expect(h1).toBeFocused();

  expect(errors).toEqual([]);
});

test('every route has exactly one polite and one assertive live region (spine AD-18)', async ({
  page,
}) => {
  for (const hash of ['#/record', '#/library', '#/tuner', '#/settings', '#/tab/abc']) {
    await page.goto(`./${hash}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('[aria-live="polite"][role="status"]')).toHaveCount(1);
    await expect(page.locator('[aria-live="assertive"][role="alert"]')).toHaveCount(1);
    await expect(page.locator('[aria-live]')).toHaveCount(2);
  }
});
