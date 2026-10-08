import { expect, test, type Page } from '@playwright/test';
import { axeIn, seedTheme, THEMES } from './a11y-helpers';
import { recordButton, stopButton, timer } from './helpers';
import { heading as libraryHeading, nav } from './library-helpers';
import { FIXTURE, goLive, held, meter } from './mic-helpers';

// Story "Accessibility sweep: axe in both themes and keyboard-only flow" (CAP-21, US-8.2): the
// matrix's dev companion. The states here only a dev hook can produce (forced storage-full
// writes, held analysis, a blocked upgrade, the fake mic's fixtures and devices, the take-length
// overrides), so they cannot exist in the production build. As in the production matrix, every
// group runs once per theme, the theme seeded as the stored pref before the first load, so each
// state is reached and rendered in it; axe checks it after `data-theme` and the background.

/** Errors other than the dev-only warnings the app logs on purpose. */
const unexpected = (errors: string[]) => errors.filter((e) => !e.includes('[tabcreator]'));

/** Sets a dev hook on `window`. */
function setHook(page: Page, name: string, on: boolean): Promise<void> {
  return page.evaluate(
    ([key, value]) => {
      (window as unknown as Record<string, boolean>)[key] = value;
    },
    [name, on] as const,
  );
}

/** Starts a take and waits for the timer to show `shown`. */
async function recordUntil(page: Page, shown: string): Promise<void> {
  await recordButton(page).click();
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(timer(page)).toHaveText(shown, { timeout: 10_000 });
}

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await seedTheme(page, theme);
    });
    const axe = (page: Page, state: string) => axeIn(page, theme, state);

    test('storage full: the mid-take banner, then the Library banner', async ({ page }) => {
      test.setTimeout(60_000);
      // Mid-take: every raw append fails with storage-full from 0:02.
      const errors = await goLive(page, held());
      await recordUntil(page, '0:02');
      await setHook(page, '__storageFullHook', true);
      const recordBanner = page.getByTestId('storage-full-banner');
      await expect(recordBanner).toBeVisible({ timeout: 5_000 });
      await expect(recordButton(page)).toHaveAttribute('aria-pressed', 'false');
      await axe(page, 'Record mid-take storage full');
      await setHook(page, '__storageFullHook', false);

      // The Library's banner (the storage-full status the failed save set).
      await nav(page, 'Library').click();
      await expect(libraryHeading(page)).toBeVisible();
      await expect(page.getByTestId('library-storage-full')).toBeVisible();
      await axe(page, 'Library storage full');
      expect(unexpected(errors)).toEqual([]);
    });

    test('storage full on the analysis commit: the Tab banner with Retry', async ({ page }) => {
      const errors = await goLive(page, FIXTURE);
      await recordUntil(page, '0:02');
      await setHook(page, '__commitStorageFullHook', true);
      await stopButton(page).click();
      await expect(page).toHaveURL(/#\/tab\/[^/]+$/, { timeout: 15_000 });
      await expect(page.getByTestId('tab-storage-full')).toBeVisible({ timeout: 10_000 });
      await axe(page, 'Tab storage full on commit');
      expect(unexpected(errors)).toEqual([]);
    });

    test('held analysis: the Tab screen of a stopped take', async ({ page }) => {
      const errors = await goLive(page, held());
      await recordUntil(page, '0:02');
      await stopButton(page).click();
      await expect(page).toHaveURL(/#\/tab\/[^/]+$/, { timeout: 15_000 });
      const id = decodeURIComponent(new URL(page.url()).hash.slice('#/tab/'.length));
      await expect(page.locator(`[data-take-id="${id}"]`)).toBeVisible();
      await axe(page, 'Tab held analysis');
      expect(unexpected(errors)).toEqual([]);
    });

    test('upgrade blocked: the banner during a take, then the full-screen notice', async ({
      page,
    }) => {
      test.setTimeout(30_000);
      const errors = await goLive(page, held());
      await recordUntil(page, '0:02');
      await page.evaluate(() => window.__instanceTest!.reportConnectionState('blocked'));
      await expect(page.getByTestId('upgrade-blocked-banner')).toBeVisible();
      await axe(page, 'Upgrade blocked banner');
      await stopButton(page).click();
      await expect(
        page.getByRole('heading', { name: 'Close other TabCreator tabs to finish updating' }),
      ).toBeVisible();
      await axe(page, 'Upgrade blocked notice');
      expect(unexpected(errors)).toEqual([]);
    });

    test('level warning: Too loud', async ({ page }) => {
      const errors = await goLive(page, 'level_too_hot');
      await expect(page.getByTestId('input-level-warning')).toHaveText(
        'Too loud — move back or lower the input',
      );
      await axe(page, 'Record too loud');
      expect(unexpected(errors)).toEqual([]);
    });

    test('level warning: Too quiet', async ({ page }) => {
      const errors = await goLive(page, 'silence_60s');
      await expect(page.getByTestId('input-level-warning')).toHaveText(
        'Too quiet — move closer to the guitar',
        { timeout: 5_000 },
      );
      await axe(page, 'Record too quiet');
      expect(unexpected(errors)).toEqual([]);
    });

    test('the input-quality banner', async ({ page }) => {
      const errors = await goLive(page, 'open_strings', {
        before: () =>
          page.evaluate(() =>
            window.__fakeMic!.configure('fake-mic-open_strings', { sampleRate: 16000 }),
          ),
      });
      await expect(page.getByTestId('input-quality-banner')).toBeVisible();
      await axe(page, 'Record input-quality banner');
      expect(unexpected(errors)).toEqual([]);
    });

    test('the recovered-take banner, after a reload mid-take', async ({ page }) => {
      test.setTimeout(60_000);
      const errors = await goLive(page, held());
      await recordUntil(page, '0:03');
      // The leave-page prompt is the browser's own (beforeunload), outside the page's DOM.
      const dialogs: string[] = [];
      page.on('dialog', (dialog) => {
        dialogs.push(dialog.type());
        void dialog.accept();
      });
      await page.reload();
      expect(dialogs).toEqual(['beforeunload']);
      await expect(page.getByTestId('recovered-take-banner')).toHaveCount(1, { timeout: 10_000 });
      await axe(page, 'Record recovered-take banner');
      expect(unexpected(errors)).toEqual([]);
    });

    test('the near-cap warning', async ({ page }) => {
      test.setTimeout(60_000);
      // A 30 s cap warned 20 s ahead: the warning shows from 0:10, with 20 s to spare for the check.
      const errors = await goLive(page, held(`${FIXTURE}&maxTakeMs=30000&warnLeadMs=20000`));
      await recordButton(page).click();
      const nearLimit = page.getByTestId('near-limit');
      await expect(nearLimit).toHaveText('30 seconds left', { timeout: 15_000 });
      await axe(page, 'Record near-cap warning');
      // Still recording, the warning showing: the state checked was the one meant.
      await expect(nearLimit).toHaveText('30 seconds left');
      await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
      await expect(meter(page)).toBeVisible();
      expect(unexpected(errors)).toEqual([]);
    });
  });
}
