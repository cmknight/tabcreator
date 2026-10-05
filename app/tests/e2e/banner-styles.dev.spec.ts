import { expect, test, type Locator, type Page } from '@playwright/test';
import { collectErrors, recordButton, timer } from './helpers';
import { goLive } from './mic-helpers';

// Runs in the `dev` project only. Pins the banners' and status icons' computed styles to their
// values before the shared banner.module.css / icons.tsx (baseline b0db361's per-banner CSS):
// flex, padding --space-3 --space-4, a 4 px left edge, margin-block-end --space-4 (Settings
// --space-6), a <p> with margin 0. Warning banners: --color-check-bg fill, --color-warning edge
// and 18 px icon; error banners: --color-surface fill, --color-danger edge and 20 px icon.

const LIMITS = 'maxTakeMs=8000&warnLeadMs=3000';

type Kind = 'warning' | 'error';
const KIND = {
  warning: { fill: '--color-check-bg', edge: '--color-warning', icon: '18px' },
  error: { fill: '--color-surface', edge: '--color-danger', icon: '20px' },
} as const;

/** The computed values of the given CSS properties on the element. */
function styleOf(el: Locator, props: readonly string[]): Promise<Record<string, string>> {
  return el.evaluate(
    (node, names) => {
      const s = getComputedStyle(node);
      return Object.fromEntries(names.map((n) => [n, s.getPropertyValue(n)]));
    },
    [...props],
  );
}

/** A token read from `:root`'s computed style, resolved to a computed colour or length. */
function token(page: Page, name: string, as: 'color' | 'length'): Promise<string> {
  return page.evaluate(
    ([n, kind]) => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
      const probe = document.createElement('div');
      if (kind === 'color') probe.style.color = raw;
      else probe.style.width = raw;
      document.body.append(probe);
      const value = getComputedStyle(probe)[kind === 'color' ? 'color' : 'width'];
      probe.remove();
      return value;
    },
    [name, as] as const,
  );
}

async function expectIcon(icon: Locator, size: string) {
  expect(await styleOf(icon, ['width', 'height'])).toEqual({ width: size, height: size });
}

async function expectBanner(
  page: Page,
  banner: Locator,
  kind: Kind,
  margin: string,
  wrap: 'nowrap' | 'wrap',
) {
  const k = KIND[kind];
  const [space3, space4, fill, edge] = await Promise.all([
    token(page, '--space-3', 'length'),
    token(page, '--space-4', 'length'),
    token(page, k.fill, 'color'),
    token(page, k.edge, 'color'),
  ]);
  expect(
    await styleOf(banner, [
      'display',
      'flex-wrap',
      'margin-block-end',
      'padding-top',
      'padding-bottom',
      'padding-left',
      'padding-right',
      'border-left-width',
      'border-left-style',
      'border-left-color',
      'background-color',
    ]),
  ).toEqual({
    display: 'flex',
    'flex-wrap': wrap,
    'margin-block-end': margin,
    'padding-top': space3,
    'padding-bottom': space3,
    'padding-left': space4,
    'padding-right': space4,
    'border-left-width': '4px',
    'border-left-style': 'solid',
    'border-left-color': edge,
    'background-color': fill,
  });
  const icon = banner.locator('svg');
  await expectIcon(icon, k.icon);
  expect((await styleOf(icon, ['color'])).color).toBe(edge);
  expect(await styleOf(banner.locator('p'), ['margin'])).toEqual({ margin: '0px' });
}

test('banner and status icon styles: input quality, level meter, near limit', async ({ page }) => {
  // level_too_hot clips from 300 ms (Too loud); a 16 kHz device shows the input quality banner.
  const errors = await goLive(page, `level_too_hot&${LIMITS}`, {
    before: () =>
      page.evaluate(() =>
        window.__fakeMic!.configure('fake-mic-level_too_hot', { sampleRate: 16000 }),
      ),
  });

  const quality = page.getByTestId('input-quality-banner');
  await expect(quality).toBeVisible();
  await expectBanner(page, quality, 'warning', '16px', 'nowrap');

  const warning = page.getByTestId('input-level-warning');
  await expect(warning).toHaveText('Too loud — move back or lower the input');
  await expectIcon(warning.locator('svg'), '18px');

  await recordButton(page).click();
  const nearLimit = page.getByTestId('near-limit');
  await expect(nearLimit).toBeVisible({ timeout: 8_000 });
  await expectIcon(nearLimit.locator('svg'), '16px');
  expect(errors).toEqual([]);
});

test('banner styles: the storage-full banner', async ({ page }) => {
  const errors = await goLive(page);
  await recordButton(page).click();
  await expect(timer(page)).toHaveText('0:01', { timeout: 6_000 });
  // No take cap in this test, so nothing races the hook.
  await page.evaluate(() => {
    (window as unknown as { __storageFullHook: boolean }).__storageFullHook = true;
  });
  const full = page.getByTestId('storage-full-banner');
  await expect(full).toBeVisible({ timeout: 5_000 });
  await expectBanner(page, full, 'error', '16px', 'nowrap');
  expect(errors).toEqual([]);
});

test('banner styles: the recovered-take banner wraps, with a 12em sentence', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = await goLive(page);
  await recordButton(page).click();
  await expect(timer(page)).toHaveText('0:02', { timeout: 10_000 });
  page.on('dialog', (dialog) => void dialog.accept());
  await page.reload();

  const banner = page.getByTestId('recovered-take-banner');
  await expect(banner).toHaveCount(1, { timeout: 10_000 });
  await expectBanner(page, banner, 'warning', '16px', 'wrap');
  const text = await styleOf(banner.locator('p'), ['min-width', 'font-size']);
  expect(text['min-width']).toBe(`${12 * parseFloat(text['font-size']!)}px`);
  expect(errors).toEqual([]);
});

test('banner styles: the Settings engine-failed banner', async ({ page }) => {
  const errors = collectErrors(page);
  await page.route('**/*.wasm', (route) => route.abort());
  await page.goto('./#/settings');
  const text = page.getByText('The analysis engine failed to load');
  await expect(text).toBeVisible();
  await expectBanner(page, text.locator('..'), 'error', '24px', 'nowrap');
  // Only the blocked wasm request itself may log.
  expect(errors.filter((e) => !e.includes('Failed to load resource'))).toEqual([]);
});
