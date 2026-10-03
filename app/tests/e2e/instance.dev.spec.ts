import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousAxe } from './mic-helpers';

// Runs in the `dev` project only (story 3.10, US-8.5): two pages of one browser context share
// Web Locks and BroadcastChannel, like two tabs. The fake mic (US-0.4) plays
// c_major_scale_pos1 as the microphone.

const FIXTURE = 'c_major_scale_pos1';
const MIME = 'audio/webm;codecs=opus';
const OTHER_TAB = 'TabCreator is open in another tab';
/** "Use here" moves the app within 3 s (EXPERIENCE.md Open in another tab). */
const HANDOVER_MS = 3_000;

const useHere = (page: Page) => page.getByRole('button', { name: 'Use here' });
const otherTabHeading = (page: Page) => page.getByRole('heading', { name: OTHER_TAB });
/** The app shell's main navigation: only there while the page runs the app. */
const appNav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

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

/** The decoded duration (s) of the take's compressed copy; null when missing or undecodable. */
function decodedSeconds(page: Page, id: string): Promise<number | null> {
  return page.evaluate(async (takeId) => {
    try {
      const root = await navigator.storage.getDirectory();
      const file = await (await root.getDirectoryHandle('audio')).getFileHandle(`${takeId}.webm`);
      const ctx = new OfflineAudioContext(1, 1, 48_000);
      const buffer = await ctx.decodeAudioData(await (await file.getFile()).arrayBuffer());
      return buffer.duration;
    } catch {
      return null;
    }
  }, id);
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
  const firstErrors = collectErrors(first);
  await first.goto(`./?fakeMic=${FIXTURE}#/record`);
  await first.getByRole('button', { name: 'Allow microphone' }).click();
  await expect(first.getByRole('meter', { name: 'Input level' })).toBeVisible();
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
