import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { collectErrors } from './helpers';
import { watchHygiene } from './hygiene';
import { heading as libraryHeading, nav, row } from './library-helpers';
import {
  loopPcm,
  readFixtureWav,
  restoreSeed,
  seedBackup,
  seedTake,
  wavFile,
} from './seed-helpers';
import { readTab, readTake } from './storage-helpers';
import { noteButtons } from './tab-helpers';

// CAP-25 states sweep, on the production build (`chromium` project): SPEC CAP-25's "player left
// during analysis". A 240 s recorded take (seeded through Restore from backup, as WAV) is still
// analysing when the player reloads or leaves for the Library; either way its analysis finishes,
// its notes show and the take is stored `analyzed`.

const FIXTURE_WAV = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'testdata',
  'synth',
  'c_major_scale_pos1.wav',
);
const DURATION_MS = 240_000;
/** How long a 240 s analysis may take on the CI machine. */
const ANALYSIS_TIMEOUT_MS = 120_000;

/** A WAV of the fixture looped to `ms`. */
function fixtureWav(ms: number): Buffer {
  const { samples, sampleRate } = readFixtureWav(FIXTURE_WAV);
  return wavFile(loopPcm(samples, Math.round((sampleRate * ms) / 1000)), sampleRate);
}

/** Restores one recorded 240 s take `id` from the Library, and opens its Tab, analysing. */
async function seedAndOpen(page: Page, id: string): Promise<void> {
  const take = seedTake({ id, title: 'Long take', durationMs: DURATION_MS, sampleRate: 48_000 });
  await page.goto('./#/library');
  await expect(libraryHeading(page)).toBeVisible();
  await restoreSeed(page, seedBackup(take, fixtureWav(DURATION_MS)));
  await page.goto(`./#/tab/${encodeURIComponent(id)}`);
  await expect(analysing(page)).toBeVisible();
}

const analysing = (page: Page) => page.getByRole('progressbar', { name: 'Analysing…' });

/** The take's notes show and it is stored `analyzed` with a tab of notes. */
async function expectAnalysed(page: Page, id: string): Promise<void> {
  await expect(noteButtons(page).first()).toBeVisible({ timeout: ANALYSIS_TIMEOUT_MS });
  await expect(analysing(page)).toHaveCount(0);
  await expect
    .poll(async () => (await readTake<{ status: string }>(page, id))?.status)
    .toBe('analyzed');
  expect((await readTab<{ notes: unknown[] }>(page, id))?.notes.length).toBeGreaterThan(0);
}

test('a reload mid-analysis analyses the take again on load, and it completes', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const id = 'resume-reload';
  const hygiene = await watchHygiene(page, baseURL!);
  const errors = collectErrors(page);
  await seedAndOpen(page, id);
  expect(await readTake(page, id)).toMatchObject({ status: 'recorded' });

  await page.reload();
  await expect(page.locator(`[data-take-id="${id}"]`)).toBeVisible();
  await expect(analysing(page)).toBeVisible();
  await expectAnalysed(page, id);
  expect(errors).toEqual([]);
  hygiene.expectClean();
});

test('leaving for the Library mid-analysis and coming back: the analysis completes', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const id = 'resume-leave';
  const hygiene = await watchHygiene(page, baseURL!);
  const errors = collectErrors(page);
  await seedAndOpen(page, id);

  await nav(page, 'Library').click();
  await expect(libraryHeading(page)).toBeVisible();
  await expect(row(page, id)).toBeVisible();
  await row(page, id).getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`#/tab/${id}$`));
  await expectAnalysed(page, id);
  expect(errors).toEqual([]);
  hygiene.expectClean();
});
