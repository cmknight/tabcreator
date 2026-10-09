import { expect, test, type Page } from '@playwright/test';
import { strings } from '../../src/ui/strings';
import { liveLog, logLive, politeRegion, recordButton, stopButton, timer } from './helpers';
import { nav } from './library-helpers';
import { goLive, held } from './mic-helpers';
import { readTake, takeIds } from './storage-helpers';
import { openSeededTab } from './tab-helpers';

// Story "Announcements and the Tab toolbar" (retro A4/DS10, CAP-21, CAP-25, AD-18): the Tab
// toolbar is one Tab stop with arrow keys across its enabled buttons; the first analysis
// finishing and "Take not found" are announced; a storage-full stop is announced once, by the
// shell, on whatever screen the player is.

const toolbar = (page: Page) => page.getByRole('toolbar', { name: strings['tab.toolbar'] });
const tool = (page: Page, name: string) => toolbar(page).getByRole('button', { name });

/** Whether focus is on a button inside the toolbar. */
const inToolbar = (page: Page) =>
  page.evaluate(() => !!document.activeElement?.closest('[role="toolbar"]'));

/** Starts a take and waits until it has at least 1 s of audio. */
async function startTake(page: Page): Promise<void> {
  await recordButton(page).click();
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(timer(page)).toHaveText('0:01', { timeout: 5_000 });
}

function setStorageFullHook(page: Page, on: boolean): Promise<void> {
  return page.evaluate((value) => {
    (window as unknown as { __storageFullHook: boolean }).__storageFullHook = value;
  }, on);
}

/** Waits for the one take to be saved (`recorded`) and returns its stop reason. */
async function savedStopReason(page: Page): Promise<string | undefined> {
  await expect.poll(() => takeIds(page)).toHaveLength(1);
  const [id] = await takeIds(page);
  await expect
    .poll(async () => (await readTake<{ status: string }>(page, id!))?.status, { timeout: 10_000 })
    .toBe('recorded');
  return (await readTake<{ stopReason?: string }>(page, id!))?.stopReason;
}

test('the toolbar is one Tab stop; ← / → cross its enabled buttons, wrapping; Home / End', async ({
  page,
}) => {
  await openSeededTab(page);
  // A seeded take: Undo, Redo, Delete (nothing selected) and Trim (no audio) are disabled.
  const insert = tool(page, strings['tab.insert']);
  await expect(toolbar(page).locator('button[tabindex="0"]')).toHaveCount(1);
  await expect(insert).toHaveAttribute('tabindex', '0');

  // Tab from the skip link: the toolbar is entered once, and the next Tab leaves it.
  await page.getByRole('link', { name: strings['tab.skipToTab'] }).focus();
  let entered = 0;
  for (let i = 0; i < 12 && entered === 0; i++) {
    await page.keyboard.press('Tab');
    if (await inToolbar(page)) entered++;
  }
  expect(entered).toBe(1);
  await expect(insert).toBeFocused();
  await page.keyboard.press('Tab');
  expect(await inToolbar(page)).toBe(false);
  await page.keyboard.press('Shift+Tab');
  await expect(insert).toBeFocused();

  await page.keyboard.press('ArrowRight');
  await expect(tool(page, strings['tab.copy'])).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(tool(page, strings['tab.download'])).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(tool(page, strings['tab.analysisSettings'])).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(insert).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(tool(page, strings['tab.analysisSettings'])).toBeFocused();
  await page.keyboard.press('Home');
  await expect(insert).toBeFocused();
  await page.keyboard.press('End');
  await expect(tool(page, strings['tab.analysisSettings'])).toBeFocused();
  // The stop follows focus: Tab out and back returns to the last button focused.
  await expect(toolbar(page).locator('button[tabindex="0"]')).toHaveCount(1);
  await expect(tool(page, strings['tab.analysisSettings'])).toHaveAttribute('tabindex', '0');
  await page.keyboard.press('Tab');
  expect(await inToolbar(page)).toBe(false);
  await page.keyboard.press('Shift+Tab');
  await expect(tool(page, strings['tab.analysisSettings'])).toBeFocused();
  // The arrows moved focus only: no note was selected.
  await expect(page.locator('[data-note-id][aria-pressed="true"]')).toHaveCount(0);
});

/** Whether a text is one of the first analysis's outcome announcements (from `strings`). */
const isAnalysisDone = (text: string) =>
  text === strings['tab.noNotes'] ||
  Array.from({ length: 1_000 }, (_, n) => strings['tab.analysisDone'](n + 1)).includes(text);

test('the first analysis finishing is announced with its note count', async ({ page }) => {
  await goLive(page);
  await logLive(page);
  await startTake(page);
  await expect(timer(page)).toHaveText('0:02', { timeout: 5_000 });
  await stopButton(page).click();
  await expect(page).toHaveURL(/#\/tab\/[^/]+$/, { timeout: 15_000 });
  const status = page.getByTestId('tab-status-line');
  const noNotes = page.getByTestId('tab-no-notes');
  await expect(status.or(noNotes)).toBeVisible({ timeout: 20_000 });
  // The note count the status line shows; none: "No notes found".
  let done: string = strings['tab.noNotes'];
  if (await status.isVisible()) {
    const shown = await status.textContent();
    const n = Array.from({ length: 1_000 }, (_, k) => k + 1).find((k) =>
      shown?.startsWith(strings['tab.statusNotes'](k)),
    );
    expect(n).toBeDefined();
    done = strings['tab.analysisDone'](n!);
  }
  await expect.poll(async () => (await liveLog(page)).polite).toContain(done);
  await page.waitForTimeout(300);
  expect((await liveLog(page)).polite.filter(isAnalysisDone)).toEqual([done]);
});

test('an unknown take announces "Take not found"', async ({ page }) => {
  await page.goto('./#/library');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await page.goto('./#/tab/unknown');
  await expect(page.locator('main').getByText(strings['tab.notFound'])).toBeVisible();
  await expect(politeRegion(page)).toHaveText(strings['tab.notFound']);
});

test('storage full mid-take while on the Tuner: the stop is announced assertively once', async ({
  page,
}) => {
  await goLive(page, held());
  await logLive(page);
  await startTake(page);
  await nav(page, 'Tuner').click();
  await expect(page).toHaveURL(/#\/tuner$/);
  await setStorageFullHook(page, true);

  await expect(page.locator('[aria-live="assertive"]')).toHaveText(strings['record.storageFull'], {
    timeout: 10_000,
  });
  expect(await savedStopReason(page)).toBe('storage-full');
  await setStorageFullHook(page, false);
  await expect(page).toHaveURL(/#\/tuner$/);
  await page.waitForTimeout(300);
  const { assertive } = await liveLog(page);
  expect(assertive).toEqual([strings['record.storageFull']]);
});

test('storage full mid-take on Record: the stop announced once, with the banner shown', async ({
  page,
}) => {
  await goLive(page, held());
  await logLive(page);
  await startTake(page);
  await setStorageFullHook(page, true);

  const banner = page.getByTestId('storage-full-banner');
  await expect(banner).toContainText(strings['record.storageFull'], { timeout: 10_000 });
  expect(await savedStopReason(page)).toBe('storage-full');
  await setStorageFullHook(page, false);
  await page.waitForTimeout(300);
  const { assertive, polite } = await liveLog(page);
  // The banner and the shell both announce the stop; the announcer speaks it once. (The banner
  // may have said the shared Storage full text when the append failed, before the stop.)
  expect(assertive.filter((t) => t === strings['record.storageFull'])).toEqual([
    strings['record.storageFull'],
  ]);
  expect(assertive.filter((t) => t === strings['global.storageFull']).length).toBeLessThanOrEqual(
    1,
  );
  // RecordingAnnouncer's polite "Recording stopped" stays.
  expect(polite).toContain(strings['record.stopped']);
  await expect(banner).toBeVisible();
});

/** Sets the storage-full status as a failed write does, through the dev server's module. */
async function markStorageFull(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const path = '/src/storage/persistence.ts';
    const { markStorageFull } = (await import(
      /* @vite-ignore */ path
    )) as typeof import('../../src/storage/persistence');
    markStorageFull();
  });
}

test('opening the Library with storage already full announces it once', async ({ page }) => {
  await page.goto('./#/tuner');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await logLive(page);
  // Storage fills on the Tuner: the shell says so.
  await markStorageFull(page);
  const full = async () =>
    (await liveLog(page)).assertive.filter((t) => t === strings['global.storageFull']);
  await expect.poll(full).toHaveLength(1);
  // Past the announcer's repeat window (a repeat within it is dropped), the Library's banner
  // says it on arrival, once.
  const hold = await page.evaluate(async () => {
    const path = '/src/ui/a11y/announcer.ts';
    const { ASSERTIVE_REPEAT_MS } = (await import(
      /* @vite-ignore */ path
    )) as typeof import('../../src/ui/a11y/announcer');
    return ASSERTIVE_REPEAT_MS;
  });
  await page.waitForTimeout(hold + 200);
  await nav(page, 'Library').click();
  await expect(page.getByTestId('library-storage-full')).toBeVisible();
  await expect.poll(full).toHaveLength(2);
  await page.waitForTimeout(300);
  expect(await full()).toHaveLength(2);
});

test('an edit that cannot be saved for lack of space is announced once', async ({ page }) => {
  await openSeededTab(page);
  await logLive(page);
  await page.evaluate(() => {
    (window as unknown as { __putTabStorageFullHook: boolean }).__putTabStorageFullHook = true;
  });
  await page.locator('[data-note-id="note-11"]').click();
  await page.keyboard.press('7');
  await expect(page.getByTestId('tab-edit-storage-full')).toBeVisible();
  await page.waitForTimeout(300);
  const { assertive } = await liveLog(page);
  expect(assertive.filter((t) => t === strings['global.storageFull'])).toEqual([
    strings['global.storageFull'],
  ]);
  await page.evaluate(() => {
    (window as unknown as { __putTabStorageFullHook: boolean }).__putTabStorageFullHook = false;
  });
});

test('a take whose save fails while on the Library: "couldn\'t be saved" announced once', async ({
  page,
}) => {
  await goLive(page, held());
  await logLive(page);
  await startTake(page);
  await nav(page, 'Library').click();
  await expect(page).toHaveURL(/#\/library$/);
  await page.evaluate(async () => {
    (window as unknown as { __storageFullSaveHook: boolean }).__storageFullSaveHook = true;
    const path = '/src/session/recording-session.ts';
    const { recordingSession } = (await import(
      /* @vite-ignore */ path
    )) as typeof import('../../src/session/recording-session');
    await recordingSession.stop('user');
  });
  const failed = async () =>
    (await liveLog(page)).assertive.filter((t) => t === strings['record.saveFailed']);
  await expect.poll(failed, { timeout: 10_000 }).toHaveLength(1);
  await page.evaluate(() => {
    (window as unknown as { __storageFullSaveHook: boolean }).__storageFullSaveHook = false;
  });
  await page.waitForTimeout(300);
  expect(await failed()).toHaveLength(1);
  // The toast shows it silently.
  await expect(page.getByTestId('toast')).toHaveText(strings['record.saveFailed']);
  await expect(page).toHaveURL(/#\/library$/);
});
