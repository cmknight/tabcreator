import { expect, test } from '@playwright/test';

// Story "Theme toggle", on the production build: a dark pref on a light OS paints dark from the
// first frame. The stylesheet is render-blocking in <head> and main.tsx a deferred module, so
// only the boot script (build/theme-boot.ts) can set `data-theme` in time.

const PREFS_KEY = 'tabcreator.prefs.v1';
/** `--color-background`, dark (theme.css), as computed. */
const DARK_BG = 'rgb(20, 19, 17)';

declare global {
  interface Window {
    /** At the first animation frame: the body background and `data-theme` on <html>. */
    __firstFrame?: { background: string | null; theme: string | null };
  }
}

test('a dark pref on a light OS: the first frame is already dark', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript((key: string) => {
    if (sessionStorage.getItem('__seeded') === null) {
      sessionStorage.setItem('__seeded', '1');
      localStorage.setItem(key, JSON.stringify({ version: 1, theme: 'dark' }));
    }
    requestAnimationFrame(() => {
      window.__firstFrame = {
        background: document.body ? getComputedStyle(document.body).backgroundColor : null,
        theme: document.documentElement.getAttribute('data-theme'),
      };
    });
  }, PREFS_KEY);

  await page.goto('./#/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  expect(await page.evaluate(() => window.__firstFrame)).toEqual({
    background: DARK_BG,
    theme: 'dark',
  });

  // And again on a reload (the pref is not re-seeded).
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  expect(await page.evaluate(() => window.__firstFrame)).toEqual({
    background: DARK_BG,
    theme: 'dark',
  });
});
