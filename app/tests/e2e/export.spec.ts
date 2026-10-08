import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { toolButton, windows } from './export-helpers';
import { collectErrors } from './helpers';
import { watchHygiene } from './hygiene';
import { heading as libraryHeading } from './library-helpers';
import { restoreSeed, seedAnalysedTake, seedBackup } from './seed-helpers';
import { makeNotes, noteButtons } from './tab-helpers';

// CAP-25 states sweep (Library retro B4), on the production build (`chromium` project): the
// downloaded tab's line endings follow the platform (CAP-18), with the platform forced by an init
// script on the standard `navigator.userAgentData.platform` and `navigator.platform`: `\r\n`
// only on Windows, `\n` only elsewhere. The take is seeded through Restore from backup.

/** Makes the page report `platform` (`userAgentData.platform`) and `legacy` (`navigator.platform`). */
async function reportPlatform(page: Page, platform: string, legacy: string): Promise<void> {
  await page.addInitScript(
    ([p, l]) => {
      const data = { platform: p, mobile: false, brands: [] };
      Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => data });
      Object.defineProperty(Navigator.prototype, 'platform', { get: () => l });
    },
    [platform, legacy] as const,
  );
}

/** Seeds one analysed take, opens its Tab, clicks Download; returns the file's raw text. */
async function downloadSeeded(page: Page, id: string): Promise<string> {
  await page.goto('./#/library');
  await expect(libraryHeading(page)).toBeVisible();
  await restoreSeed(
    page,
    seedBackup([
      seedAnalysedTake({
        id,
        title: 'Line endings',
        notes: makeNotes(40),
        createdAt: new Date().toISOString(),
      }),
    ]),
  );
  await page.goto(`./#/tab/${encodeURIComponent(id)}`);
  await expect(noteButtons(page).first()).toBeVisible();
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    toolButton(page, 'Download').click(),
  ]);
  return readFile(await file.path(), 'utf8');
}

test('Download on Windows: every line ends \\r\\n, with no lone \\n', async ({ page, baseURL }) => {
  const hygiene = await watchHygiene(page, baseURL!);
  const errors = collectErrors(page);
  await reportPlatform(page, 'Windows', 'Win32');
  const raw = await downloadSeeded(page, 'crlf-windows');
  expect(await windows(page)).toBe(true);
  expect(raw).toContain('\r\n');
  expect(raw.split('\n').length).toBeGreaterThan(5);
  expect(raw).not.toMatch(/(^|[^\r])\n/);
  expect(raw.startsWith('TabCreator — Line endings\r\n')).toBe(true);
  expect(errors).toEqual([]);
  hygiene.expectClean();
});

test('Download elsewhere (Linux): every line ends \\n, with no \\r', async ({ page, baseURL }) => {
  const hygiene = await watchHygiene(page, baseURL!);
  const errors = collectErrors(page);
  await reportPlatform(page, 'Linux', 'Linux x86_64');
  const raw = await downloadSeeded(page, 'lf-linux');
  expect(await windows(page)).toBe(false);
  expect(raw.split('\n').length).toBeGreaterThan(5);
  expect(raw).not.toContain('\r');
  expect(raw.startsWith('TabCreator — Line endings\n')).toBe(true);
  expect(errors).toEqual([]);
  hygiene.expectClean();
});
