import { expect, test, type Page } from '@playwright/test';
import { recordButton, stopButton, timer } from './helpers';
import { expectNoSeriousAxe, FIXTURE, goLive } from './mic-helpers';
import { audioSha256, readTab, readTake } from './storage-helpers';
import { noteButton, tabArea } from './tab-helpers';

// Story "Trim": the Trim strip saves a trim range and re-analyses it as one snapshot command;
// locked notes outside the range stay stored but hidden and come back on Reset trim; undo
// restores the untrimmed tab and trim; playback follows the saved trim; the compressed audio
// file is never rewritten. In the `dev` project (the fake mic): seeded takes have no audio, so
// the take is recorded.

interface StoredNote {
  id: string;
  startMs: number;
  string: number;
  fret: number;
  locked: boolean;
}
interface StoredTab {
  notes: StoredNote[];
  deletedStartMs: number[];
  updatedAt: string;
}
interface StoredTake {
  durationMs: number;
  trimStartMs: number;
  trimEndMs: number | null;
}

const storedTab = (page: Page, id: string) => readTab<StoredTab>(page, id);
const storedTake = (page: Page, id: string) => readTake<StoredTake>(page, id);

/** Records about 4 s of the fake mic and waits for its analysed tab; returns the take id. */
async function recordAndAnalyse(page: Page): Promise<string> {
  await recordButton(page).click();
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(timer(page)).toHaveText('0:04', { timeout: 8_000 });
  await stopButton(page).click();
  await expect(page).toHaveURL(/#\/tab\/[^/]+$/, { timeout: 15_000 });
  await expect(page.getByTestId('tab-status-line')).toBeVisible({ timeout: 20_000 });
  return decodeURIComponent(new URL(page.url()).hash.slice('#/tab/'.length));
}

const trimToggle = (page: Page) =>
  page.getByRole('toolbar', { name: 'Tab tools' }).getByRole('button', { name: 'Trim' });
const strip = (page: Page) => page.getByRole('region', { name: 'Trim' });
const startHandle = (page: Page) => strip(page).getByRole('slider', { name: 'Trim start' });
const saveButton = (page: Page) => strip(page).getByRole('button', { name: 'Save' });
const resetButton = (page: Page) => strip(page).getByRole('button', { name: 'Reset trim' });
const shownIds = (page: Page) =>
  tabArea(page)
    .locator('[data-note-id]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-note-id')!));

/** Runs `start` (a click that starts a trim run) and waits for its commit. */
async function committed(page: Page, id: string, start: () => Promise<void>) {
  const before = (await storedTab(page, id))!.updatedAt;
  await start();
  await expect.poll(async () => (await storedTab(page, id))?.updatedAt).not.toBe(before);
  await expect(page.getByTestId('trim-progress')).toHaveCount(0, { timeout: 20_000 });
}

test('trim the first 2 s, undo, redo, reset: locked notes hidden then back; playback and the audio file follow', async ({
  page,
}) => {
  await goLive(page, FIXTURE);
  const id = await recordAndAnalyse(page);
  const audioBefore = await audioSha256(page, id);
  expect(audioBefore).not.toBeNull();

  // Lock a note that starts before 2 s by editing its fret.
  const first = (await storedTab(page, id))!;
  const early = first.notes.find((n) => n.startMs < 2000 && n.fret !== 5);
  expect(early, 'a note before 2 s').toBeDefined();
  await noteButton(page, early!.id).click();
  await page.keyboard.press('5');
  await expect
    .poll(async () => (await storedTab(page, id))?.notes.find((n) => n.id === early!.id))
    .toMatchObject({ fret: 5, locked: true });
  const locked = (await storedTab(page, id))!.notes.find((n) => n.id === early!.id)!;
  // And one after 2 s, which the trim keeps exactly.
  const late = first.notes.find((n) => n.startMs >= 2200 && n.fret !== 7);
  expect(late, 'a note after 2 s').toBeDefined();
  await noteButton(page, late!.id).click();
  await page.keyboard.press('7');
  await expect
    .poll(async () => (await storedTab(page, id))?.notes.find((n) => n.id === late!.id))
    .toMatchObject({ fret: 7, locked: true });
  const lateLocked = (await storedTab(page, id))!.notes.find((n) => n.id === late!.id)!;
  const beforeTab = (await storedTab(page, id))!;

  // Open the strip; move the start handle to 2.00 s by keyboard; each settled move announced.
  await trimToggle(page).click();
  await expect(trimToggle(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(strip(page).getByTestId('trim-waveform')).toBeVisible({ timeout: 10_000 });
  await expectNoSeriousAxe(page);
  await startHandle(page).focus();
  for (let i = 0; i < 20; i++) await page.keyboard.press('Shift+ArrowRight');
  await expect(startHandle(page)).toHaveAttribute('aria-valuenow', '2000');
  await expect(startHandle(page)).toHaveAttribute('aria-valuetext', '0:02.00');
  await expect(page.locator('[aria-live="polite"]')).toHaveText('Trim start 0:02.00');

  // The locked note is shown, so Save asks first.
  await saveButton(page).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await committed(page, id, () =>
    dialog.getByRole('button', { name: 'Trim and re-analyse' }).click(),
  );
  await expect
    .poll(async () => await storedTake(page, id))
    .toMatchObject({
      trimStartMs: 2000,
      trimEndMs: null,
    });
  const trimmed = (await storedTab(page, id))!;
  const byId = new Map(trimmed.notes.map((n) => [n.id, n]));
  // No shown note starts before 2 s.
  const shown = await shownIds(page);
  expect(shown.length).toBeGreaterThan(0);
  for (const sid of shown) expect(byId.get(sid)!.startMs).toBeGreaterThanOrEqual(2000);
  // Every note from 2 s on that was there before is still stored, with the same id and the
  // exact same startMs: a locked one is kept as it is, an unlocked one re-detected keeps its
  // times (the trim merge anchors it).
  const later = beforeTab.notes.filter((b) => b.startMs >= 2000);
  expect(later.length).toBeGreaterThan(1);
  // (A note the engine does not re-detect at all, such as the fake mic's last one cut off by
  // the take's end, is kept as it was.)
  for (const n of later) {
    expect(byId.get(n.id)?.startMs, `the note at ${n.startMs} ms`).toBe(n.startMs);
  }
  expect(byId.get(lateLocked.id)).toEqual(lateLocked);
  // The locked note: stored unchanged, not shown.
  expect(byId.get(locked.id)).toEqual(locked);
  expect(shown).not.toContain(locked.id);
  await expect(page.getByTestId('tab-status-line')).toContainText(`${shown.length} notes`);

  // Playback starts at the trim start.
  await page.evaluate(() => {
    const w = window as unknown as { __seeks: number[] };
    w.__seeks = [];
    const audio = document.querySelector('audio')!;
    audio.addEventListener('seeking', () => w.__seeks.push(audio.currentTime * 1000));
  });
  const play = page.getByRole('button', { name: 'Play', exact: true });
  await expect(play).toBeEnabled({ timeout: 10_000 });
  await play.click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __seeks: number[] }).__seeks[0]))
    .toBeCloseTo(2000, 0);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();

  // Ctrl+Z: the untrimmed tab and trim, exactly as stored before.
  await noteButton(page, shown[0]!).focus();
  await page.keyboard.press('Control+z');
  await expect
    .poll(async () => {
      const tab = await storedTab(page, id);
      return { notes: tab?.notes, deletedStartMs: tab?.deletedStartMs };
    })
    .toEqual({ notes: beforeTab.notes, deletedStartMs: beforeTab.deletedStartMs });
  expect(await storedTake(page, id)).toMatchObject({ trimStartMs: 0, trimEndMs: null });
  await expect(noteButton(page, locked.id)).toBeVisible();

  // Redo, then Reset trim: the locked note is shown again, unchanged.
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(async () => (await storedTake(page, id))?.trimStartMs).toBe(2000);
  await expect(noteButton(page, locked.id)).toHaveCount(0);
  await expect(resetButton(page)).toBeEnabled();
  // A shown note is locked (the one after 2 s), so Reset trim asks first too.
  await resetButton(page).click();
  await expect(dialog).toBeVisible();
  await committed(page, id, () =>
    dialog.getByRole('button', { name: 'Trim and re-analyse' }).click(),
  );
  expect(await storedTake(page, id)).toMatchObject({ trimStartMs: 0, trimEndMs: null });
  const reset = (await storedTab(page, id))!.notes.find((n) => n.id === locked.id);
  expect(reset).toEqual(locked);
  await expect(noteButton(page, locked.id)).toBeVisible();
  await expect(resetButton(page)).toBeDisabled();

  // The compressed audio file was never rewritten.
  expect(await audioSha256(page, id)).toBe(audioBefore);
});

test('Esc closes the strip without saving; the Trim strip and Analysis settings never show together', async ({
  page,
}) => {
  await goLive(page, FIXTURE);
  const id = await recordAndAnalyse(page);
  const settings = page
    .getByRole('toolbar', { name: 'Tab tools' })
    .getByRole('button', { name: 'Analysis settings' });
  await settings.click();
  await expect(page.getByRole('region', { name: 'Analysis settings' })).toBeVisible();
  await trimToggle(page).click();
  await expect(page.getByRole('region', { name: 'Analysis settings' })).toHaveCount(0);
  await expect(strip(page)).toBeVisible();

  await startHandle(page).focus();
  await page.keyboard.press('End');
  await expect(saveButton(page)).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(strip(page)).toHaveCount(0);
  await expect(trimToggle(page)).toBeFocused();
  expect(await storedTake(page, id)).toMatchObject({ trimStartMs: 0, trimEndMs: null });
  await trimToggle(page).click();
  await expect(startHandle(page)).toHaveAttribute('aria-valuenow', '0');
});
