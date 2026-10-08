import { expect, test } from '@playwright/test';
import { DB_VERSION } from '../../src/storage/migrations';
import { collectErrors } from './helpers';
import { watchHygiene } from './hygiene';

// CAP-25 states sweep, on the production build (`chromium` project): the "Update blocked" state
// (EXPERIENCE State Patterns), reached through real browser conditions only. A same-origin page
// that is not the app (the web manifest) opens the `tabcreator` database at version 1, as an older
// build would, creating migration 1's stores, and ignores `versionchange`. The app then cannot
// upgrade it, and shows the full-screen notice; once that connection closes, the upgrade runs and
// the app continues.

declare global {
  interface Window {
    __oldDb?: IDBDatabase;
  }
}

test('an old-version connection held open: the full-screen update-blocked notice, then the app once it closes', async ({
  context,
  page,
  baseURL,
}) => {
  const holder = await context.newPage();
  await holder.goto('./manifest.webmanifest');
  await holder.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('tabcreator', 1);
        open.onupgradeneeded = () => {
          // Migration 1 (storage/migrations.ts): takes (key id, index createdAt), tabs (key takeId).
          const db = open.result;
          const takes = db.createObjectStore('takes', { keyPath: 'id' });
          takes.createIndex('createdAt', 'createdAt');
          db.createObjectStore('tabs', { keyPath: 'takeId' });
        };
        open.onsuccess = () => {
          const db = open.result;
          // An old build that never closes for a newer version.
          db.onversionchange = () => {};
          window.__oldDb = db;
          resolve();
        };
        open.onerror = () => reject(open.error);
        open.onblocked = () => reject(new Error('blocked'));
      }),
  );
  expect(await holder.evaluate(() => window.__oldDb?.version)).toBe(1);

  const hygiene = await watchHygiene(page, baseURL!);
  const errors = collectErrors(page);
  await page.goto('./#/record');
  const notice = page.getByText('Close other TabCreator tabs to finish updating', { exact: true });
  await expect(notice).toBeVisible({ timeout: 10_000 });
  // Full screen: no partial app behind it.
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Record', level: 1 })).toHaveCount(0);

  await holder.evaluate(() => window.__oldDb!.close());
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('heading', { name: 'Record', level: 1 })).toBeVisible();
  await expect(notice).toHaveCount(0);
  // The upgrade ran: the database is at the app's version now.
  const version = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('tabcreator');
        open.onsuccess = () => {
          resolve(open.result.version);
          open.result.close();
        };
        open.onerror = () => reject(open.error);
      }),
  );
  expect(version).toBe(DB_VERSION);
  await holder.close();
  expect(errors).toEqual([]);
  hygiene.expectClean();
});
