import { expect, test, type Page } from '@playwright/test';
import { recordButton, timer } from './helpers';
import { watchHygiene } from './hygiene';
import { goLive } from './mic-helpers';
import { rawFileExists, readTab, readTake, takeIds } from './storage-helpers';
import { noteButtons } from './tab-helpers';

// CAP-25 states sweep (Recording retro A5), in the production-mic lane (`prod-mic` project): a
// take whose page reloads mid-recording is offered back on Record by the recovered-take banner,
// and Open rebuilds it from its raw file, on the production build with Chromium's fake capture
// device. The dev lane's recovery.dev.spec.ts covers the rest (Discard, the WAV fallback).

const banner = (page: Page) => page.getByTestId('recovered-take-banner');

test('reload mid-take on the production build: the banner; Open recovers the take and opens its Tab', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(90_000);
  const hygiene = await watchHygiene(page, baseURL!);
  // The Allow click is also the user gesture `beforeunload` needs to ask.
  const errors = await goLive(page, null);
  await recordButton(page).click();
  await expect(timer(page)).toHaveText('0:05', { timeout: 15_000 });
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.type());
    void dialog.accept();
  });
  await page.reload();
  expect(dialogs).toEqual(['beforeunload']);

  await expect(banner(page)).toHaveCount(1, { timeout: 10_000 });
  await expect(banner(page).locator('p')).toHaveText(
    // The time of day is locale-formatted; the take's length is m:ss in every locale.
    /\(0:0[4-9]\)$/,
  );
  const ids = await takeIds(page);
  expect(ids).toHaveLength(1);
  const id = ids[0]!;
  expect(await readTake(page, id)).toMatchObject({ status: 'recording' });
  await expect(banner(page).getByRole('button')).toHaveText(['Open', 'Discard']);

  await banner(page).getByRole('button', { name: 'Open' }).click();
  // Re-encoding runs in real time.
  await expect(page).toHaveURL(new RegExp(`#/tab/${id}$`), { timeout: 40_000 });
  await expect(page.getByTestId('tab-status-line')).toBeVisible({ timeout: 20_000 });
  const saved = await readTake<{ status: string; stopReason?: string; durationMs: number }>(
    page,
    id,
  );
  expect(saved).toMatchObject({ stopReason: 'recovered' });
  expect(saved!.durationMs).toBeGreaterThanOrEqual(4_000);
  // Its Tab analyses it (story 5.6): the notes show, the take is analysed and its raw file gone.
  await expect(noteButtons(page).first()).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => ({
      status: (await readTake<{ status: string }>(page, id))?.status,
      raw: await rawFileExists(page, id),
    }))
    .toEqual({ status: 'analyzed', raw: false });
  expect((await readTab<{ notes: unknown[] }>(page, id))?.notes.length).toBeGreaterThan(0);
  await expect(banner(page)).toHaveCount(0);
  expect(errors).toEqual([]);
  hygiene.expectClean();
});
