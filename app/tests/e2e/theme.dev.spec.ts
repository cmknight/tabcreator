import { expect, test, type Page } from '@playwright/test';
import { strings } from '../../src/ui/strings';
import { collectErrors } from './helpers';
import { expectNoSeriousAxe } from './mic-helpers';

// Story "Theme toggle" (AD-12, CAP-21; DESIGN.md Colors, Settings → Appearance): the Theme
// segmented control sets `data-theme` on <html> at once and saves the pref; `main.tsx` applies the
// saved pref before the first render, so a reload never flashes the light theme and the
// unsupported screen is themed too. System leaves the attribute off and follows the OS.

const PREFS_KEY = 'tabcreator.prefs.v1';
/** `--color-background`, light and dark (theme.css), as computed. */
const LIGHT_BG = 'rgb(250, 250, 247)';
const DARK_BG = 'rgb(20, 19, 17)';

declare global {
  interface Window {
    /** `data-theme` on <html> at the page's first DOMContentLoaded (null when absent). */
    __themeAtDcl?: string | null;
  }
}

/**
 * Records `data-theme` at each page load's first DOMContentLoaded, before React has rendered
 * anything visible to a user; and, when `stored` is given, seeds the prefs on the first load only.
 */
async function observeTheme(page: Page, stored?: unknown): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      if (value !== undefined && sessionStorage.getItem('__seeded') === null) {
        sessionStorage.setItem('__seeded', '1');
        localStorage.setItem(key, JSON.stringify(value));
      }
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          window.__themeAtDcl = document.documentElement.getAttribute('data-theme');
        },
        { once: true },
      );
    },
    { key: PREFS_KEY, value: stored },
  );
}

const themeAttr = (page: Page) =>
  page.evaluate(() => document.documentElement.getAttribute('data-theme'));
const bodyBackground = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const themeAtDcl = (page: Page) => page.evaluate(() => window.__themeAtDcl);
const storedTheme = (page: Page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}').theme, PREFS_KEY);
const themeButton = (page: Page, name: string) =>
  page
    .getByRole('group', { name: strings['settings.theme'] })
    .getByRole('button', { name, exact: true });

async function openSettings(page: Page): Promise<void> {
  await page.goto('./#/settings');
  await expect(
    page.getByRole('heading', { level: 1, name: strings['settings.title'] }),
  ).toBeVisible();
}

test('Choose Dark: dark at once, saved, and dark before the first render after a reload', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await observeTheme(page);
  await openSettings(page);
  expect(await themeAttr(page)).toBeNull();
  expect(await bodyBackground(page)).toBe(LIGHT_BG);
  await expect(themeButton(page, strings['settings.themeSystem'])).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await themeButton(page, strings['settings.themeDark']).click();
  await expect(themeButton(page, strings['settings.themeDark'])).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(themeButton(page, strings['settings.themeSystem'])).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  expect(await themeAttr(page)).toBe('dark');
  expect(await bodyBackground(page)).toBe(DARK_BG);
  expect(await storedTheme(page)).toBe('dark');

  await page.reload();
  await expect(
    page.getByRole('heading', { level: 1, name: strings['settings.title'] }),
  ).toBeVisible();
  expect(await themeAtDcl(page)).toBe('dark');
  expect(await themeAttr(page)).toBe('dark');
  expect(await bodyBackground(page)).toBe(DARK_BG);
  await expect(themeButton(page, strings['settings.themeDark'])).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(errors).toEqual([]);
});

test('keyboard: Enter and Space on each segment choose it', async ({ page }) => {
  await openSettings(page);
  const light = themeButton(page, strings['settings.themeLight']);
  const dark = themeButton(page, strings['settings.themeDark']);
  await light.focus();
  await page.keyboard.press('Enter');
  await expect(light).toHaveAttribute('aria-pressed', 'true');
  expect(await themeAttr(page)).toBe('light');
  await page.keyboard.press('Tab');
  await expect(dark).toBeFocused();
  await page.keyboard.press('Space');
  await expect(dark).toHaveAttribute('aria-pressed', 'true');
  expect(await themeAttr(page)).toBe('dark');
});

test('System: no attribute, the tokens follow prefers-color-scheme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await observeTheme(page, { version: 1, theme: 'system' });
  await openSettings(page);
  expect(await themeAtDcl(page)).toBeNull();
  expect(await themeAttr(page)).toBeNull();
  expect(await bodyBackground(page)).toBe(DARK_BG);
  await page.emulateMedia({ colorScheme: 'light' });
  expect(await themeAttr(page)).toBeNull();
  expect(await bodyBackground(page)).toBe(LIGHT_BG);
});

test('Light over a dark system: data-theme="light" and the light tokens', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await observeTheme(page, { version: 1, theme: 'light' });
  await openSettings(page);
  expect(await themeAtDcl(page)).toBe('light');
  expect(await themeAttr(page)).toBe('light');
  expect(await bodyBackground(page)).toBe(LIGHT_BG);
  await expect(themeButton(page, strings['settings.themeLight'])).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('a bad stored theme reads as System', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await observeTheme(page, { version: 1, theme: 'purple' });
  await openSettings(page);
  expect(await themeAtDcl(page)).toBeNull();
  expect(await bodyBackground(page)).toBe(LIGHT_BG);
  await expect(themeButton(page, strings['settings.themeSystem'])).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('the unsupported screen follows a dark pref', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await observeTheme(page, { version: 1, theme: 'dark' });
  await page.addInitScript(() => {
    delete (window as unknown as Record<string, unknown>).BroadcastChannel;
  });
  await page.goto('./');
  await expect(page.getByRole('heading', { name: strings['global.unsupported'] })).toBeVisible();
  expect(await themeAtDcl(page)).toBe('dark');
  expect(await bodyBackground(page)).toBe(DARK_BG);
});

for (const theme of ['light', 'dark'] as const) {
  test(`axe: Settings in ${theme} has no serious or critical violations`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await observeTheme(page, { version: 1, theme });
    await openSettings(page);
    expect(await themeAttr(page)).toBe(theme);
    await expectNoSeriousAxe(page);
  });
}

test('axe: Settings with System on a dark OS has no serious or critical violations', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await observeTheme(page, { version: 1, theme: 'system' });
  await openSettings(page);
  expect(await themeAttr(page)).toBeNull();
  expect(await bodyBackground(page)).toBe(DARK_BG);
  await expectNoSeriousAxe(page);
});
