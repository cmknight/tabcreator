import { expect, test, type Page } from '@playwright/test';
import { MIME, decodedSeconds } from './helpers';
import { expectNoSeriousAxe, FIXTURE, goLive } from './mic-helpers';

// Runs in the `dev` project only (story 3.11, US-3.2): a take whose page reloads mid-recording
// is offered back on Record ("An unfinished take from <time> was recovered (m:ss)") once the
// instance lock is held (story 5.3: at once on a plain start); Open rebuilds its audio from the
// raw file in real time, Discard deletes it. The fake mic (US-0.4) plays c_major_scale_pos1.

/** How long to wait for the banner: the scan runs as soon as the reloaded page holds the lock. */
const SCAN_WAIT_MS = 10_000;
const BANNER_TEXT =
  /^An unfinished take from (1[0-2]|[1-9]):[0-5]\d (am|pm) was recovered \((\d+):(\d\d)\)$/;

const recordButton = (page: Page) => page.getByRole('button', { name: 'Record', exact: true });
const timer = (page: Page) => page.getByRole('timer');
const banners = (page: Page) => page.getByTestId('recovered-take-banner');
const heading = (page: Page) => page.getByRole('heading', { name: 'Record', level: 1 });

/** Records until the timer shows `shown`, then reloads, accepting the leave-page dialog. */
async function reloadMidTake(page: Page, shown: string): Promise<string[]> {
  await recordButton(page).click();
  await expect(timer(page)).toHaveText(shown, { timeout: 20_000 });
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.type());
    void dialog.accept();
  });
  await page.reload();
  return dialogs;
}

interface StoredTake {
  id: string;
  status: string;
  stopReason?: string;
  audioMime: string | null;
  durationMs: number;
}

/** The takes in IndexedDB (read with a connection of the test's own). */
function readTakes(page: Page): Promise<StoredTake[]> {
  return page.evaluate(
    () =>
      new Promise<StoredTake[]>((resolve, reject) => {
        const open = indexedDB.open('tabcreator');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const all = db.transaction('takes').objectStore('takes').getAll();
          all.onsuccess = () => {
            resolve(all.result as StoredTake[]);
            db.close();
          };
          all.onerror = () => reject(all.error);
        };
      }),
  );
}

/** Every file in OPFS `raw/` and `audio/`, as `dir/name`. */
function opfsFiles(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const names: string[] = [];
    for (const dir of ['raw', 'audio']) {
      try {
        const handle = await root.getDirectoryHandle(dir);
        for await (const name of (handle as unknown as { keys(): AsyncIterable<string> }).keys()) {
          names.push(`${dir}/${name}`);
        }
      } catch {
        // No such directory: nothing in it.
      }
    }
    return names.sort();
  });
}

/** The banner's sentence and its length in seconds. */
async function bannerSeconds(page: Page): Promise<{ text: string; seconds: number }> {
  const text = (await banners(page).first().locator('p').textContent()) ?? '';
  const match = BANNER_TEXT.exec(text);
  expect(match, text).not.toBeNull();
  return { text, seconds: Number(match![3]) * 60 + Number(match![4]) };
}

test('reload mid-take: the leave dialog, then the banner; Open rebuilds the take and opens its Tab', async ({
  page,
}) => {
  test.setTimeout(90_000);
  // The Allow click is also the user gesture `beforeunload` needs to ask.
  await goLive(page);
  const dialogs = await reloadMidTake(page, '0:10');
  expect(dialogs).toEqual(['beforeunload']);

  await expect(banners(page)).toHaveCount(1, { timeout: SCAN_WAIT_MS });
  const [take] = await readTakes(page);
  expect(take).toMatchObject({ status: 'recording' });
  const { seconds } = await bannerSeconds(page);
  expect(seconds).toBeGreaterThanOrEqual(9);
  // Above the h1, with Open then Discard.
  const banner = banners(page).first();
  expect(
    await banner.evaluate(
      (el, h1) => !!(el.compareDocumentPosition(h1!) & Node.DOCUMENT_POSITION_FOLLOWING),
      await heading(page).elementHandle(),
    ),
  ).toBe(true);
  await expect(banner.getByRole('button')).toHaveText(['Open', 'Discard']);
  await expectNoSeriousAxe(page);

  await banner.getByRole('button', { name: 'Open' }).click();
  await expect(banner.locator('p')).toHaveText('Recovering…');
  await expect(banner.getByRole('button', { name: 'Discard' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  // Re-encoding runs in real time.
  await expect(page).toHaveURL(new RegExp(`#/tab/${take!.id}$`), { timeout: 40_000 });
  const [saved] = await readTakes(page);
  expect(saved).toMatchObject({
    id: take!.id,
    status: 'recorded',
    stopReason: 'recovered',
    audioMime: MIME,
  });
  expect(saved!.durationMs).toBeGreaterThanOrEqual(9_000);
  expect(await decodedSeconds(page, take!.id)).toBeGreaterThanOrEqual(9);
  // The raw file stays for analysis.
  expect(await opfsFiles(page)).toContain(`raw/${take!.id}.f32`);
});

test('Discard: the take, its raw and compressed files go; focus moves to the h1', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await goLive(page);
  await reloadMidTake(page, '0:02');
  await expect(banners(page)).toHaveCount(1, { timeout: SCAN_WAIT_MS });
  expect(await readTakes(page)).toHaveLength(1);

  const discard = banners(page).first().getByRole('button', { name: 'Discard' });
  await discard.focus();
  await discard.click();
  await expect(banners(page)).toHaveCount(0);
  await expect(heading(page)).toBeFocused();
  expect(await readTakes(page)).toEqual([]);
  expect(await opfsFiles(page)).toEqual([]);
});

test('an idle Record page reloads with no leave dialog and no banner', async ({ page }) => {
  await goLive(page);
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.type());
    void dialog.accept();
  });
  await page.reload();
  await expect(heading(page)).toBeVisible();
  await page.waitForTimeout(5_000);
  expect(dialogs).toEqual([]);
  await expect(banners(page)).toHaveCount(0);
});

test('Use here while the other page records: after 5 s the new page shows no recovered banner', async ({
  context,
}) => {
  test.setTimeout(60_000);
  const first = await context.newPage();
  await goLive(first);
  await recordButton(first).click();
  await expect(timer(first)).toHaveText('0:02', { timeout: 10_000 });

  const second = await context.newPage();
  await second.goto(`./?fakeMic=${FIXTURE}#/record`);
  await second.getByRole('button', { name: 'Use here' }).click();
  await expect(heading(second)).toBeVisible({ timeout: 5_000 });
  await second.waitForTimeout(5_000);
  await expect(banners(second)).toHaveCount(0);
  const takes = await readTakes(second);
  expect(takes).toHaveLength(1);
  expect(takes[0]).toMatchObject({ status: 'recorded', stopReason: 'instance-lost' });
});
