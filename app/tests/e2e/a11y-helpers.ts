import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousAxe } from './mic-helpers';

// The accessibility sweep's theme and axe helpers (story "Accessibility sweep: axe in both themes
// and keyboard-only flow"; CAP-21, US-8.2), shared by the production matrix
// (a11y-matrix.spec.ts, a11y-matrix.prod.spec.ts), its dev companion (a11y-matrix.dev.spec.ts)
// and the keyboard-only flow. Each state group runs once per theme: the theme is the stored pref,
// seeded before the first load (`seedTheme`), so the app applies it itself (theme-boot,
// `applyTheme`) and every state is reached and rendered in that theme, as a player would see it.
// Before each axe run, `data-theme` on <html> and the body background are asserted, so a theme
// that did not apply fails loudly.

/** The prefs key (`storage/prefs.ts` `PREFS_KEY`). */
const PREFS_KEY = 'tabcreator.prefs.v1';

export type Theme = 'light' | 'dark';

/** The two themes every state group runs in. */
export const THEMES: readonly Theme[] = ['light', 'dark'];

/** `--color-background` per theme (theme.css), as the body's computed background. */
export const THEME_BACKGROUND: Record<Theme, string> = {
  light: 'rgb(250, 250, 247)',
  dark: 'rgb(20, 19, 17)',
};

/** The stored theme pref: a theme, or `system` (no `data-theme`; the OS scheme decides). */
export type ThemePref = Theme | 'system';

/**
 * Stores `{ ...extra, version: 1, theme }` as the prefs before the page's first load, once per
 * tab (the `theme-boot.spec.ts` seed-once init script: a reload keeps whatever the app stored
 * since). Call before the first `goto`.
 */
export async function seedTheme(
  page: Page,
  theme: ThemePref,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await page.addInitScript(
    ({ key, prefs }) => {
      if (sessionStorage.getItem('__a11ySeeded') !== null) return;
      sessionStorage.setItem('__a11ySeeded', '1');
      localStorage.setItem(key, JSON.stringify(prefs));
    },
    { key: PREFS_KEY, prefs: { ...extra, version: 1, theme } },
  );
}

/** What the page shows: `data-theme` on <html> and the body's computed background. */
function shown(page: Page): Promise<{ theme: string | null; background: string | null }> {
  return page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    background: document.body ? getComputedStyle(document.body).backgroundColor : null,
  }));
}

/**
 * Fails unless the page shows `theme` from the stored pref: `data-theme` set to it and that
 * theme's background. `{ system: true }`: no `data-theme` (a `system` pref), with `theme`'s
 * background from the `prefers-color-scheme` block.
 */
export async function expectTheme(
  page: Page,
  theme: Theme,
  { system = false }: { system?: boolean } = {},
): Promise<void> {
  await expect
    .poll(() => shown(page), {
      message: `the page shows the ${system ? `system ${theme}` : theme} theme`,
    })
    .toEqual({ theme: system ? null : theme, background: THEME_BACKGROUND[theme] });
}

/**
 * Axe on the page as it stands, after asserting it shows `theme` (`expectTheme`): no serious or
 * critical violations. `state` names the state in the report.
 */
export async function axeIn(
  page: Page,
  theme: Theme,
  state: string,
  options: { system?: boolean } = {},
): Promise<void> {
  await test.step(`axe: ${state} (${options.system ? 'system ' : ''}${theme})`, async () => {
    await expectTheme(page, theme, options);
    await expectNoSeriousAxe(page);
  });
}
