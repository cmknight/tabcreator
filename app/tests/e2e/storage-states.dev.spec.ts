import { expect, test, type Locator, type Page } from '@playwright/test';
import { strings } from '../../src/ui/strings';
import { collectErrors, recordButton, stopButton, timer } from './helpers';
import { heading, list, nav, row } from './library-helpers';
import { expectNoSeriousAxe, goLive, held } from './mic-helpers';
import { seedTab } from './tab-helpers';

// Story "Storage protection and Library states" (6.7, CAP-19, CAP-25): persistent storage is
// asked for after the first take is saved; a refusal shows the one-time Library notice; Settings
// shows the storage status; the Library footer shows the take count and usage; a save that failed
// with storage-full shows the Library's storage-full banner until a save succeeds.
// `navigator.storage.persist`/`persisted`/`estimate` are stubbed before the app loads.

interface StorageStub {
  grant: boolean;
  usage: number;
}

/** Stubs `navigator.storage` on every page load; `window.__persistCalls` counts persist(). */
async function stubStorage(page: Page, stub: StorageStub): Promise<void> {
  await page.addInitScript((s: StorageStub) => {
    const w = window as unknown as { __persistCalls: number; __persisted: boolean };
    w.__persistCalls = 0;
    w.__persisted = false;
    const storage = navigator.storage;
    Object.defineProperty(storage, 'persisted', {
      configurable: true,
      value: async () => w.__persisted,
    });
    Object.defineProperty(storage, 'persist', {
      configurable: true,
      value: async () => {
        w.__persistCalls++;
        if (s.grant) w.__persisted = true;
        return w.__persisted;
      },
    });
    Object.defineProperty(storage, 'estimate', {
      configurable: true,
      value: async () => ({ usage: s.usage, quota: 1e10 }),
    });
  }, stub);
}

const persistCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __persistCalls: number }).__persistCalls);

const notice = (page: Page): Locator => page.getByTestId('persist-notice');
const fullBanner = (page: Page): Locator => page.getByTestId('library-storage-full');
const footer = (page: Page): Locator => page.getByTestId('library-footer');

/** Errors other than the dev-only warnings the app logs on purpose. */
const unexpected = (errors: string[]) => errors.filter((e) => !e.includes('[tabcreator]'));

async function openLibrary(page: Page): Promise<void> {
  await nav(page, 'Library').click();
  await expect(page).toHaveURL(/#\/library$/);
  await expect(heading(page)).toBeVisible();
}

/** Records about 2 s of the fake mic from Record (analysis held by the URL); returns the id. */
async function recordHeld(page: Page): Promise<string> {
  await nav(page, 'Record').click();
  await expect(recordButton(page)).toBeEnabled();
  await recordButton(page).click();
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(timer(page)).toHaveText('0:02', { timeout: 5_000 });
  await stopButton(page).click();
  await expect(page).toHaveURL(/#\/tab\/[^/]+$/, { timeout: 15_000 });
  return decodeURIComponent(new URL(page.url()).hash.slice('#/tab/'.length));
}

/** Renames the take through its row menu (a committed take write, or a failed one). */
async function rename(page: Page, id: string, title: string): Promise<void> {
  await row(page, id)
    .getByRole('button', { name: /^More actions for / })
    .click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Rename' }).click();
  const field = row(page, id).getByRole('textbox', { name: 'Take title' });
  await expect(field).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
}

test('persist refused: asked once after the first save; the Library notice shows once, backs up, and is gone on a later visit', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await stubStorage(page, { grant: false, usage: 3_000_000 });
  const errors = await goLive(page, held());
  // Never on start.
  expect(await persistCalls(page)).toBe(0);
  await recordHeld(page);
  await expect.poll(() => persistCalls(page)).toBe(1);
  // A second save in the same page load asks nothing more.
  await recordHeld(page);
  await page.waitForTimeout(200);
  expect(await persistCalls(page)).toBe(1);

  await openLibrary(page);
  await expect(notice(page)).toBeVisible();
  await expect(notice(page)).toHaveAttribute('role', 'status');
  await expect(notice(page)).toContainText(strings['library.persistNotice']);
  await expectNoSeriousAxe(page);
  // Remembered as shown.
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem('tabcreator.prefs.v1') ?? '{}').persistNoticeShown,
      ),
    )
    .toBe(true);

  // Its Back up library starts the backup (a download, as the header button).
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    notice(page).getByRole('button', { name: strings['library.backUp'] }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^tabcreator-backup-\d{8}\.zip$/);

  // Dismiss hides it for this visit.
  await notice(page).getByRole('button', { name: strings['library.persistNoticeDismiss'] }).click();
  await expect(notice(page)).toHaveCount(0);
  await expect(heading(page)).toBeFocused();

  // Settings: not protected, with the link to the Library.
  await nav(page, 'Settings').click();
  const storage = page.getByRole('region', { name: 'Storage' });
  await expect(storage).toContainText(strings['settings.storageAtRisk']);
  await expect(
    storage.getByRole('link', { name: strings['settings.storageBackUp'] }),
  ).toHaveAttribute('href', '#/library');

  // A later visit (after a reload): no notice.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await openLibrary(page);
  await expect(list(page).getByRole('listitem')).toHaveCount(2);
  await expect(notice(page)).toHaveCount(0);
  expect(unexpected(errors)).toEqual([]);
});

test('persist granted: Settings shows Storage: protected and the Library shows no notice', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await stubStorage(page, { grant: true, usage: 3_000_000 });
  const errors = await goLive(page, held());
  await recordHeld(page);
  await expect.poll(() => persistCalls(page)).toBe(1);
  await nav(page, 'Settings').click();
  const storage = page.getByRole('region', { name: 'Storage' });
  await expect(storage).toContainText(strings['settings.storageProtected']);
  await expect(storage.getByRole('link')).toHaveCount(0);
  await openLibrary(page);
  await expect(list(page).getByRole('listitem')).toHaveCount(1);
  await expect(footer(page)).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
  expect(unexpected(errors)).toEqual([]);
});

test('the footer shows the take count and the usage in MB, keeping the full count while searching', async ({
  page,
}) => {
  await stubStorage(page, { grant: true, usage: 41_000_000 });
  const errors = collectErrors(page);
  await page.goto('./#/library');
  await expect(heading(page)).toBeVisible();
  // Empty library: no footer.
  await expect(page.getByRole('heading', { name: strings['library.empty'] })).toBeVisible();
  await expect(footer(page)).toHaveCount(0);

  for (const title of ['Riff one', 'Riff two', 'Blues', 'Ballad'])
    await seedTab(page, undefined, title);
  await expect(list(page).getByRole('listitem')).toHaveCount(4);
  await expect(footer(page)).toHaveText('4 takes · 41.0 MB used');
  await page.getByRole('searchbox', { name: 'Search takes' }).fill('riff');
  await expect(list(page).getByRole('listitem')).toHaveCount(2);
  await expect(footer(page)).toHaveText('4 takes · 41.0 MB used');
  expect(unexpected(errors)).toEqual([]);
});

test('a save failing storage-full shows the Library banner, also after navigating; a save of another take clears it', async ({
  page,
}) => {
  await stubStorage(page, { grant: true, usage: 1_000_000 });
  const errors = collectErrors(page);
  await page.goto('./#/library');
  await expect(heading(page)).toBeVisible();
  const other = await seedTab(page, undefined, 'Other take');
  const id = await seedTab(page, undefined, 'Full disk');
  await expect(row(page, id)).toBeVisible();
  await expect(fullBanner(page)).toHaveCount(0);

  // The dev hook makes the rename's save fail with storage-full.
  await page.evaluate(() => {
    (window as unknown as { __storageFullSaveHook: boolean }).__storageFullSaveHook = true;
  });
  await rename(page, id, 'Never saved');
  await expect(fullBanner(page)).toBeVisible();
  await expect(fullBanner(page)).toHaveAttribute('role', 'alert');
  await expect(fullBanner(page)).toHaveText(strings['library.storageFull']);
  await expect(fullBanner(page).getByRole('button')).toHaveCount(0);
  await expect(fullBanner(page).getByRole('link')).toHaveCount(0);

  // Still there when the Library is opened again in the same page load.
  await nav(page, 'Settings').click();
  await openLibrary(page);
  await expect(fullBanner(page)).toBeVisible();
  await expectNoSeriousAxe(page);

  // Cleared, a save (a rename) succeeds and the banner goes.
  await page.evaluate(() => {
    (window as unknown as { __storageFullSaveHook: boolean }).__storageFullSaveHook = false;
  });
  // The failing take's own save keeps it; a save of another take clears it.
  await rename(page, id, 'Saved');
  await expect(row(page, id).getByRole('link', { name: 'Saved' })).toBeVisible();
  await expect(fullBanner(page)).toBeVisible();
  await rename(page, other, 'Other saved');
  await expect(row(page, other).getByRole('link', { name: 'Other saved' })).toBeVisible();
  await expect(fullBanner(page)).toHaveCount(0);
  expect(unexpected(errors)).toEqual([]);
});

test("disk full mid-recording: the take's own save keeps the Library banner; a save of another take clears it", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await stubStorage(page, { grant: true, usage: 1_000_000 });
  const errors = await goLive(page, held());
  // Another take, seeded before the failure (its own saves come first).
  const other = await seedTab(page, undefined, 'Other take');

  // The raw-append hook (as record.dev.spec.ts uses): the take stops and is saved storage-full.
  await recordButton(page).click();
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(timer(page)).toHaveText('0:01', { timeout: 5_000 });
  await page.evaluate(() => {
    (window as unknown as { __storageFullHook: boolean }).__storageFullHook = true;
  });
  await expect(page.getByTestId('storage-full-banner')).toBeVisible({ timeout: 5_000 });
  await expect(recordButton(page)).toHaveAttribute('aria-pressed', 'false');
  await page.evaluate(() => {
    (window as unknown as { __storageFullHook: boolean }).__storageFullHook = false;
  });

  await openLibrary(page);
  await expect(list(page).getByRole('listitem')).toHaveCount(2);
  await expect(fullBanner(page)).toBeVisible();

  await rename(page, other, 'Renamed');
  await expect(row(page, other).getByRole('link', { name: 'Renamed' })).toBeVisible();
  await expect(fullBanner(page)).toHaveCount(0);
  expect(unexpected(errors)).toEqual([]);
});
