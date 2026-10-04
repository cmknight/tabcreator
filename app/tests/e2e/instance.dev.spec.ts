import { expect, test, type Page } from '@playwright/test';
import { MIME, collectErrors, decodedSeconds } from './helpers';
import { expectNoSeriousAxe, FIXTURE, goLive, held } from './mic-helpers';

// Runs in the `dev` project only (story 3.10, US-8.5): two pages of one browser context share
// Web Locks and BroadcastChannel, like two tabs. The fake mic (US-0.4) plays
// c_major_scale_pos1 as the microphone.

const OTHER_TAB = 'TabCreator is open in another tab';
/** "Use here" moves the app within 3 s (EXPERIENCE.md Open in another tab). */
const HANDOVER_MS = 3_000;

const useHere = (page: Page) => page.getByRole('button', { name: 'Use here' });
const otherTabHeading = (page: Page) => page.getByRole('heading', { name: OTHER_TAB });
/** The app shell's main navigation: only there while the page runs the app. */
const appNav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

/** The takes in IndexedDB (read with a connection of the test's own). */
function readTakes(
  page: Page,
): Promise<{ id: string; status: string; stopReason?: string; audioMime: string | null }[]> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('tabcreator');
        let missing = false;
        open.onupgradeneeded = () => {
          missing = true;
          open.transaction?.abort();
        };
        open.onerror = () => (missing ? resolve([]) : reject(open.error));
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('takes')) {
            db.close();
            resolve([]);
            return;
          }
          const all = db.transaction('takes').objectStore('takes').getAll();
          all.onsuccess = () => {
            resolve(all.result);
            db.close();
          };
          all.onerror = () => reject(all.error);
        };
      }),
  );
}

/** The take the page's recording store is recording (the dev server's module instance). */
function activeTakeId(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const path = '/src/session/recording-session.ts';
    const { recordingSession } = (await import(
      /* @vite-ignore */ path
    )) as typeof import('../../src/session/recording-session');
    return recordingSession.getSnapshot().activeTakeId;
  });
}

/** Tries a take write through the page's storage module; resolves to its error code. */
function tryWrite(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const path = '/src/storage/db.ts';
    const { db } = (await import(/* @vite-ignore */ path)) as typeof import('../../src/storage/db');
    const now = new Date().toISOString();
    try {
      await db.createTake({
        id: crypto.randomUUID(),
        title: 'Intruder',
        createdAt: now,
        status: 'recording',
        durationMs: 0,
        sampleRate: 48_000,
        tuning: 'EADGBE',
        micLabel: 'x',
        audioMime: null,
        trimStartMs: 0,
        trimEndMs: null,
        settings: { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 },
        analysisVersion: null,
        updatedAt: now,
      });
      return 'written';
    } catch (err) {
      return (err as { code?: string }).code ?? String(err);
    }
  });
}

test('a second tab shows the notice; Use here moves the app; the first takes it back', async ({
  context,
}) => {
  const first = await context.newPage();
  const firstErrors = collectErrors(first);
  await first.goto(`./?fakeMic=${FIXTURE}#/record`);
  await expect(appNav(first)).toBeVisible();

  // Second tab: the notice with Use here; the first keeps working.
  const second = await context.newPage();
  const secondErrors = collectErrors(second);
  await second.goto(`./?fakeMic=${FIXTURE}#/record`);
  await expect(otherTabHeading(second)).toBeVisible();
  await expect(otherTabHeading(second)).toBeFocused();
  await expect(useHere(second)).toBeVisible();
  await expect(appNav(second)).toHaveCount(0);
  await expectNoSeriousAxe(second);
  await first.getByRole('link', { name: 'Library' }).click();
  await expect(first).toHaveURL(/#\/library$/);
  await expect(appNav(first)).toBeVisible();

  // Use here, idle: within 3 s the second runs the app and the first shows the notice.
  await expect(second.getByRole('status')).toHaveText('');
  const clicked = Date.now();
  await useHere(second).click();
  await expect(appNav(second)).toBeVisible({ timeout: HANDOVER_MS });
  expect(Date.now() - clicked).toBeLessThan(HANDOVER_MS);
  await expect(otherTabHeading(first)).toBeVisible();
  await expect(appNav(first)).toHaveCount(0);
  await expectNoSeriousAxe(first);

  // Take back: the first reloads and runs the app; the second shows the notice.
  await useHere(first).click();
  await expect(appNav(first)).toBeVisible({ timeout: HANDOVER_MS * 2 });
  await expect(otherTabHeading(second)).toBeVisible();
  await expect(appNav(second)).toHaveCount(0);

  expect(firstErrors).toEqual([]);
  expect(secondErrors).toEqual([]);
});

test('without Web Locks: only the unsupported notice, with no Use here', async ({ page }) => {
  const errors = collectErrors(page);
  await page.addInitScript(() => {
    delete (Navigator.prototype as { locks?: unknown }).locks;
  });
  await page.goto(`./?fakeMic=${FIXTURE}#/record`);
  const heading = page.getByRole('heading', { name: 'TabCreator needs a recent desktop Chrome' });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
  expect(await page.evaluate(() => 'locks' in navigator)).toBe(false);
  await expect(useHere(page)).toHaveCount(0);
  await expect(appNav(page)).toHaveCount(0);
  await expectNoSeriousAxe(page);
  expect(errors).toEqual([]);
});

test('Use here while the first tab records: its take is saved as instance-lost; it writes no more', async ({
  context,
}) => {
  const first = await context.newPage();
  const firstErrors = await goLive(first);
  await first.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(first.getByRole('timer')).toHaveText('0:03', { timeout: 6_000 });
  const id = await activeTakeId(first);
  expect(id).not.toBeNull();

  const second = await context.newPage();
  const secondErrors = collectErrors(second);
  await second.goto(`./?fakeMic=${FIXTURE}#/record`);
  await expect(useHere(second)).toBeVisible();
  const clicked = Date.now();
  await useHere(second).click();
  await expect(appNav(second)).toBeVisible({ timeout: HANDOVER_MS });
  expect(Date.now() - clicked).toBeLessThan(HANDOVER_MS);
  await expect(otherTabHeading(first)).toBeVisible();
  // The first stayed on its page: no navigation to the take's Tab.
  expect(new URL(first.url()).hash).toBe('#/record');

  const takes = await readTakes(second);
  expect(takes).toHaveLength(1);
  expect(takes[0]).toMatchObject({
    id,
    status: 'recorded',
    stopReason: 'instance-lost',
    audioMime: MIME,
  });
  const seconds = await decodedSeconds(second, id!);
  expect(seconds).not.toBeNull();
  expect(seconds!).toBeGreaterThan(2);

  // Writes after handover: the first's storage rejects, and no take appears from it.
  expect(await tryWrite(first)).toBe('instance-taken');
  await first.waitForTimeout(500);
  expect(await readTakes(second)).toHaveLength(1);

  expect(firstErrors).toEqual([]);
  expect(secondErrors).toEqual([]);
});

// Story 5.3: the steal path, forced by the dev hook `__instanceTest.ignoreReleaseRequests()`
// (the holder ignores Use here's release request, so the other page steals the lock at 3 s).

const recordButton = (page: Page) => page.getByRole('button', { name: 'Record', exact: true });
const stopButton = (page: Page) => page.getByRole('button', { name: 'Stop', exact: true });
const timer = (page: Page) => page.getByRole('timer');
const recoveredBanners = (page: Page) => page.getByTestId('recovered-take-banner');

type InstanceEvent = { event: 'released-posted' | 'released-heard' | 'scan'; at: number };

/** The page's instance-lock dev events: `released` posted or heard, and recovery scans. */
const instanceEvents = (page: Page): Promise<InstanceEvent[]> =>
  page.evaluate(() => window.__instanceTest!.events());

/** The page ignores release requests from now on (until it reloads). */
const ignoreReleaseRequests = (page: Page) =>
  page.evaluate(() => window.__instanceTest!.ignoreReleaseRequests());

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

test('steal mid-take: saved once as instance-lost; the lost page says so; the scan waits for released', async ({
  context,
}) => {
  test.setTimeout(60_000);
  const first = await context.newPage();
  const firstErrors = await goLive(first);
  await recordButton(first).click();
  await expect(timer(first)).toHaveText('0:03', { timeout: 6_000 });
  const id = await activeTakeId(first);
  expect(id).not.toBeNull();
  await ignoreReleaseRequests(first);

  const second = await context.newPage();
  const secondErrors = collectErrors(second);
  await second.goto(`./?fakeMic=${FIXTURE}#/record`);
  await expect(useHere(second)).toBeVisible();
  const clicked = await second.evaluate(() => Date.now());
  await useHere(second).click();
  await expect(appNav(second)).toBeVisible({ timeout: HANDOVER_MS * 2 });

  await expect(otherTabHeading(first)).toBeVisible();
  await expect(
    first.getByText("Your recording was saved — it's in the Library in the other tab"),
  ).toBeVisible();
  expect(new URL(first.url()).hash).toBe('#/record');

  // The second page's scan ran only after the first posted `released`.
  await expect
    .poll(async () => (await instanceEvents(second)).map((e) => e.event))
    .toEqual(['released-heard', 'scan']);
  const [posted] = (await instanceEvents(first)).filter((e) => e.event === 'released-posted');
  const scan = (await instanceEvents(second)).find((e) => e.event === 'scan')!;
  expect(posted).toBeDefined();
  expect(scan.at).toBeGreaterThanOrEqual(posted!.at);
  // The release request was ignored: the first released only once its lock was stolen, at 3 s.
  expect(posted!.at - clicked).toBeGreaterThanOrEqual(HANDOVER_MS - 50);

  const takes = await readTakes(second);
  expect(takes).toHaveLength(1);
  expect(takes[0]).toMatchObject({
    id,
    status: 'recorded',
    stopReason: 'instance-lost',
    audioMime: MIME,
  });
  // Not offered for recovery.
  await second.waitForTimeout(1_000);
  await expect(recoveredBanners(second)).toHaveCount(0);

  expect(firstErrors).toEqual([]);
  expect(secondErrors).toEqual([]);
});

test('steal mid-rebuild: the first page writes nothing more and stays put; the second offers the take', async ({
  context,
}) => {
  test.setTimeout(90_000);
  const first = await context.newPage();
  await goLive(first);
  await recordButton(first).click();
  await expect(timer(first)).toHaveText('0:08', { timeout: 20_000 });
  first.on('dialog', (dialog) => void dialog.accept());
  await first.reload();
  await expect(recoveredBanners(first)).toHaveCount(1, { timeout: 10_000 });
  const [unfinished] = await readTakes(first);
  expect(unfinished).toMatchObject({ status: 'recording' });
  const id = unfinished!.id;

  // Open: the encode runs in real time (about 8 s); the lock is stolen 3 s into it.
  await ignoreReleaseRequests(first);
  await recoveredBanners(first).first().getByRole('button', { name: 'Open' }).click();
  await expect(recoveredBanners(first).first().locator('p')).toHaveText('Recovering…');

  const second = await context.newPage();
  const secondErrors = collectErrors(second);
  await second.goto(`./?fakeMic=${FIXTURE}#/record`);
  await useHere(second).click();
  await expect(appNav(second)).toBeVisible({ timeout: HANDOVER_MS * 2 });
  await expect(otherTabHeading(first)).toBeVisible();

  // The second offers the take, still unfinished.
  await expect(recoveredBanners(second)).toHaveCount(1, { timeout: 10_000 });
  // Past the end of the first page's encode: it wrote nothing and did not navigate.
  await first.waitForTimeout(10_000);
  expect(new URL(first.url()).hash).toBe('#/record');
  const takes = await readTakes(second);
  expect(takes).toHaveLength(1);
  expect(takes[0]).toMatchObject({ id, status: 'recording' });
  expect(await opfsFiles(second)).toEqual([`raw/${id}.f32`]);
  await expect(recoveredBanners(second)).toHaveCount(1);
  expect(secondErrors).toEqual([]);
});

test('upgrade blocked during a take: the shell stays with the banner; Stop saves; then the notice', async ({
  page,
}) => {
  test.setTimeout(30_000);
  const errors = await goLive(page, held());
  await recordButton(page).click();
  await expect(timer(page)).toHaveText('0:02', { timeout: 6_000 });
  const id = await activeTakeId(page);
  await page.evaluate(() => window.__instanceTest!.reportConnectionState('blocked'));

  const banner = page.getByTestId('upgrade-blocked-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute('role', 'alert');
  await expect(banner).toHaveText('Close other TabCreator tabs to finish updating');
  await expect(appNav(page)).toBeVisible();
  await expect(stopButton(page)).toBeVisible();
  await stopButton(page).click();

  // Saved, then (no longer busy) the full-screen notice.
  await expect(
    page.getByRole('heading', { name: 'Close other TabCreator tabs to finish updating' }),
  ).toBeVisible();
  await expect(appNav(page)).toHaveCount(0);
  const takes = await readTakes(page);
  expect(takes).toHaveLength(1);
  expect(takes[0]).toMatchObject({ id, status: 'recorded', stopReason: 'user', audioMime: MIME });
  expect(errors).toEqual([]);
});
