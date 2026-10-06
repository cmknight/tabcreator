import { expect, test, type Locator, type Page } from '@playwright/test';
import { formatMegabytes, libraryRow } from '../../src/model/library';
import type { Tab, Take } from '../../src/model/types';
import { formatElapsed, formatTakeDate } from '../../src/ui/format';
import { strings } from '../../src/ui/strings';
import { collectErrors, recordButton, stopButton, timer } from './helpers';
import { expectNoSeriousAxe, FIXTURE, goLive, meter } from './mic-helpers';
import { readTab, readTake } from './storage-helpers';
import { seedTab, tabArea } from './tab-helpers';

// Story "Library list (tracer)" (US-7.1): the Library lists every take newest first with its
// badge, date, duration, note count, audio size and first-12-notes preview; rows open their Tab;
// new takes appear without a reload; a recording take does not open; the empty state.

const list = (page: Page): Locator => page.getByRole('list', { name: 'Takes, newest first' });
const rows = (page: Page): Locator => list(page).getByRole('listitem');
const row = (page: Page, id: string): Locator => list(page).locator(`li[data-take-id="${id}"]`);
const heading = (page: Page) => page.getByRole('heading', { level: 1, name: 'Library' });

/** Errors other than the dev-only warnings the app logs on purpose. */
const unexpected = (errors: string[]) => errors.filter((e) => !e.includes('[tabcreator]'));

/**
 * Records about 2 s of the fake mic from Record and waits for its analysis to finish (its tab,
 * or No notes found: the fixture plays once per mic stream, so a take recorded late in a stream
 * may be silent); returns the id.
 */
async function recordAndAnalyse(page: Page): Promise<string> {
  await recordButton(page).click();
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(timer(page)).toHaveText('0:02', { timeout: 5_000 });
  await stopButton(page).click();
  await expect(page).toHaveURL(/#\/tab\/[^/]+$/, { timeout: 15_000 });
  await expect(
    page.getByTestId('tab-status-line').or(page.getByRole('heading', { name: 'No notes found' })),
  ).toBeVisible({ timeout: 30_000 });
  return decodeURIComponent(new URL(page.url()).hash.slice('#/tab/'.length));
}

async function openLibrary(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Library' })
    .click();
  await expect(page).toHaveURL(/#\/library$/);
  await expect(heading(page)).toBeVisible();
}

/**
 * The row as the stored take, tab and audio size say it should read; `withNotes`: the take must
 * have notes, so the count and preview are checked against real notes.
 */
async function expectRow(page: Page, id: string, withNotes = true): Promise<void> {
  const take = await readTake<Take>(page, id);
  const tab = await readTab<Tab>(page, id);
  const size = await page.evaluate(async (takeId) => {
    const audio = await (await navigator.storage.getDirectory()).getDirectoryHandle('audio');
    for await (const name of (audio as unknown as { keys(): AsyncIterable<string> }).keys()) {
      if (name.startsWith(`${takeId}.`)) {
        return (await (await audio.getFileHandle(name)).getFile()).size;
      }
    }
    return null;
  }, id);
  expect(take).not.toBeNull();
  expect(size).not.toBeNull();
  const expected = libraryRow(take!, tab, size);
  expect(expected.status).toBe('analyzed');
  expect(expected.noteCount).not.toBeNull();
  if (withNotes) expect(expected.noteCount).toBeGreaterThan(0);

  const r = row(page, id);
  await expect(r.getByText(strings['library.statusAnalysed'], { exact: true })).toBeVisible();
  await expect(r.getByText(take!.title, { exact: true })).toBeVisible();
  await expect(r).toContainText(
    [
      formatTakeDate(take!.createdAt),
      formatElapsed(take!.durationMs),
      strings['library.notes'](expected.noteCount!),
      strings['library.size'](formatMegabytes(size!)),
    ].join(' · '),
  );
  if (expected.preview === null) {
    await expect(r).toContainText(strings['library.noPreview']);
    return;
  }
  await expect(r).toContainText(expected.preview);
  // The preview is at most 12 string|fret pairs, then "…" when more follow.
  expect(expected.preview.replace(/ …$/, '').split(' ').length).toBeLessThanOrEqual(12);
  expect(expected.preview).toMatch(/^[eBGDAE]\|\d+( [eBGDAE]\|\d+)*( …)?$/);
}

test('takes recorded through the fake mic list newest first; a new take appears at the top; Enter opens a row', async ({
  page,
}) => {
  // Three recordings, each analysed.
  test.setTimeout(120_000);
  // Each of the first two takes gets a fresh mic stream, so both have the fixture's notes.
  const errors = await goLive(page, FIXTURE);
  const first = await recordAndAnalyse(page);
  // The page load starts a new stream; the mic was granted, so it goes live without Allow.
  await page.goto(`./?fakeMic=${FIXTURE}#/record`);
  await expect(meter(page)).toBeVisible();
  const second = await recordAndAnalyse(page);

  await openLibrary(page);
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(0)).toHaveAttribute('data-take-id', second);
  await expect(rows(page).nth(1)).toHaveAttribute('data-take-id', first);
  await expectRow(page, second);
  await expectRow(page, first);
  await expectNoSeriousAxe(page);

  // A third take, recorded in another visit to Record, is at the top; no page reload.
  await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Record' })
    .click();
  await expect(recordButton(page)).toBeEnabled();
  const third = await recordAndAnalyse(page);
  await openLibrary(page);
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).nth(0)).toHaveAttribute('data-take-id', third);
  await expectRow(page, third, false);

  // A take saved while the Library is open appears at the top live.
  const seeded = await seedTab(page, undefined, 'Seeded while open');
  await expect(rows(page)).toHaveCount(4);
  await expect(rows(page).nth(0)).toHaveAttribute('data-take-id', seeded);
  await expect(rows(page).nth(0)).toContainText('40 notes');
  await expect(rows(page).nth(0)).toContainText(strings['library.audioDeleted']);
  expect(
    await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload),
  ).toBe(true);

  // Enter on a row opens its Tab.
  await row(page, first).getByRole('link').focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`#/tab/${encodeURIComponent(first)}$`));
  await expect(tabArea(page)).toBeVisible();
  expect(unexpected(errors)).toEqual([]);
});

test('a take still recording shows the Recording badge and does not open', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('./#/library');
  await expect(page.getByRole('heading', { name: strings['library.empty'] })).toBeVisible();
  const id = await page.evaluate(async () => {
    const path = '/src/storage/db.ts';
    const { db } = (await import(/* @vite-ignore */ path)) as typeof import('../../src/storage/db');
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.createTake({
      id,
      title: 'Still recording',
      createdAt: now,
      status: 'recording',
      durationMs: 42_000,
      sampleRate: 48_000,
      tuning: 'EADGBE',
      micLabel: 'Seeded mic',
      audioMime: null,
      trimStartMs: 0,
      trimEndMs: null,
      settings: { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 },
      analysisVersion: null,
      updatedAt: now,
    });
    return id;
  });
  const r = row(page, id);
  await expect(r).toBeVisible();
  await expect(r.getByText(strings['library.statusRecording'], { exact: true })).toBeVisible();
  await expect(r.getByRole('link')).toHaveCount(0);
  await expect(r).not.toContainText('MB');
  await expect(r).not.toContainText(strings['library.audioDeleted']);
  // No duration while recording: it is stored at stop.
  await expect(r).not.toContainText('0:42');
  await expect(r).toContainText(strings['library.noPreview']);
  expect(unexpected(errors)).toEqual([]);
});

test('an empty library shows "No takes yet" and a Record button', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('./#/library');
  const empty = page.getByRole('heading', { level: 2, name: 'No takes yet' });
  await expect(empty).toBeVisible();
  await expect(list(page)).toHaveCount(0);
  await expectNoSeriousAxe(page);
  await empty.locator('..').getByRole('link', { name: 'Record', exact: true }).click();
  await expect(page).toHaveURL(/#\/record$/);
  expect(unexpected(errors)).toEqual([]);
});
