import { expect, test, type Page } from '@playwright/test';
import { recordButton, stopButton, timer } from './helpers';
import { expectNoSeriousAxe, goLive } from './mic-helpers';
import { readTab, readTake } from './storage-helpers';
import { noteButton, tabArea } from './tab-helpers';

// Story "Analysis settings and re-analysis" (US-4.6, spine AD-4): the Analysis settings panel,
// Re-analyse with the Confirm dialog, the merge with edited and deleted notes, and its undo, in
// the `dev` project (the fake mic). Seeded takes have no audio, so every take here is recorded.

const NOISY = 'c_major_scale_pos1_noisy';
/** Repeated 16th notes, whose low-confidence flags move with sensitivity. */
const REPEATED = 'repeated_notes_16th_160bpm_noisy';

interface StoredNote {
  id: string;
  startMs: number;
  string: number;
  fret: number;
  locked: boolean;
  lowConfidence: boolean;
}
interface StoredTab {
  notes: StoredNote[];
  deletedStartMs: number[];
  updatedAt: string;
}
interface StoredTake {
  settings: { sensitivity: number; minNoteMs: number; maxFret: number };
  warnings?: { tuningOffsetCents: number; belowRangeNotes: number };
  analysisVersion: string | null;
  trimStartMs: number;
  trimEndMs: number | null;
}

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

const toggle = (page: Page) =>
  page.getByRole('toolbar', { name: 'Tab tools' }).getByRole('button', {
    name: 'Analysis settings',
  });
const panel = (page: Page) => page.getByRole('region', { name: 'Analysis settings' });
const sensitivity = (page: Page) => panel(page).getByRole('slider', { name: 'Sensitivity' });
const reanalyse = (page: Page) => panel(page).getByRole('button', { name: 'Re-analyse' });
const dialog = (page: Page) => page.getByRole('alertdialog');

const storedTab = (page: Page, id: string) => readTab<StoredTab>(page, id);
const storedTake = (page: Page, id: string) => readTake<StoredTake>(page, id);

/** Sets the panel's sensitivity and waits for the take to store it. */
async function setSensitivity(page: Page, id: string, value: number) {
  await sensitivity(page).fill(String(value));
  await expect.poll(async () => (await storedTake(page, id))?.settings.sensitivity).toBe(value);
}

/** Runs `start` (a click that starts a re-analysis) and waits for its commit. */
async function reanalysed(page: Page, id: string, start: () => Promise<void>) {
  const before = (await storedTab(page, id))!.updatedAt;
  await start();
  await expect.poll(async () => (await storedTab(page, id))?.updatedAt).not.toBe(before);
  await expect(page.getByTestId('reanalysis-progress')).toHaveCount(0, { timeout: 20_000 });
  await expect(reanalyse(page)).toBeEnabled();
}

// Sensitivity moves the engine's confidence threshold; on this fixture that shows in the
// low-confidence flags (the note count stays put on every noisy synth fixture; user ruling).
test('sensitivity 0.2 flags more notes low-confidence than 0.8, with no more notes', async ({
  page,
}) => {
  await goLive(page, REPEATED);
  const id = await recordAndAnalyse(page);
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');

  await setSensitivity(page, id, 0.2);
  await reanalysed(page, id, () => reanalyse(page).click());
  const low = (await storedTab(page, id))!.notes;

  await setSensitivity(page, id, 0.8);
  await reanalysed(page, id, () => reanalyse(page).click());
  const high = (await storedTab(page, id))!.notes;

  const flagged = (notes: StoredNote[]) => notes.filter((n) => n.lowConfidence).length;
  expect(flagged(low)).toBeGreaterThan(flagged(high));
  expect(low.length).toBeLessThanOrEqual(high.length);
});

test('an edited note is kept and a deleted note stays gone; Ctrl+Z restores the stored tab and take', async ({
  page,
}) => {
  await goLive(page, NOISY);
  const id = await recordAndAnalyse(page);
  const first = (await storedTab(page, id))!;
  expect(first.notes.length).toBeGreaterThan(2);

  // Edit one note's fret (it locks), delete another.
  const edited = first.notes.find((n) => n.fret !== 5)!;
  await noteButton(page, edited.id).click();
  await page.keyboard.press('5');
  await expect
    .poll(async () => (await storedTab(page, id))?.notes.find((n) => n.id === edited.id))
    .toMatchObject({ fret: 5, locked: true });
  const deleted = first.notes.find((n) => n.id !== edited.id)!;
  await noteButton(page, deleted.id).click();
  await page.keyboard.press('Delete');
  await expect
    .poll(async () => (await storedTab(page, id))?.deletedStartMs)
    .toContain(deleted.startMs);
  const editedNote = (await storedTab(page, id))!.notes.find((n) => n.id === edited.id)!;

  const beforeTab = await storedTab(page, id);
  const beforeTake = await storedTake(page, id);

  await toggle(page).click();
  await setSensitivity(page, id, 0.8);
  await reanalyse(page).click();
  await expect(dialog(page)).toBeVisible();
  await reanalysed(page, id, () =>
    dialog(page).getByRole('button', { name: 'Re-analyse' }).click(),
  );

  const after = (await storedTab(page, id))!;
  const kept = after.notes.find((n) => n.id === edited.id);
  expect(kept).toEqual(editedNote);
  expect(after.notes.filter((n) => Math.abs(n.startMs - deleted.startMs) <= 50)).toEqual([]);
  expect(after.deletedStartMs).toEqual(beforeTab!.deletedStartMs);
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();

  // Undo: the stored tab and the take's settings, warnings and version as before.
  await tabArea(page).locator('[data-note-id]').first().focus();
  await page.keyboard.press('Control+z');
  await expect
    .poll(async () => {
      const tab = await storedTab(page, id);
      return { notes: tab?.notes, deletedStartMs: tab?.deletedStartMs };
    })
    .toEqual({ notes: beforeTab!.notes, deletedStartMs: beforeTab!.deletedStartMs });
  const restored = await storedTake(page, id);
  expect({
    settings: restored!.settings,
    warnings: restored!.warnings,
    analysisVersion: restored!.analysisVersion,
  }).toEqual({
    settings: beforeTake!.settings,
    warnings: beforeTake!.warnings,
    analysisVersion: beforeTake!.analysisVersion,
  });
  await expect(sensitivity(page)).toHaveValue(String(beforeTake!.settings.sensitivity));
});

test('changed settings persist: leaving and reopening the take shows them', async ({ page }) => {
  await goLive(page, NOISY);
  const id = await recordAndAnalyse(page);
  await toggle(page).click();
  await setSensitivity(page, id, 0.3);
  const min = panel(page).getByRole('spinbutton', { name: 'Minimum note length' });
  await min.fill('5');
  await min.press('Enter');
  await expect.poll(async () => (await storedTake(page, id))?.settings.minNoteMs).toBe(20);
  await expect(min).toHaveValue('20');
  const fret = panel(page).getByRole('spinbutton', { name: 'Highest fret' });
  await fret.fill('19');
  await fret.blur();
  await expect.poll(async () => (await storedTake(page, id))?.settings.maxFret).toBe(19);

  await page.getByRole('link', { name: 'Library' }).click();
  await expect(page).toHaveURL(/#\/library$/);
  // Wait for the Library screen itself: the goto below only changes the hash, and two quick hash
  // changes can render only the second, leaving this Tab screen (with its panel open) mounted.
  await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible();
  await page.goto(`./?fakeMic=${NOISY}#/tab/${encodeURIComponent(id)}`);
  await expect(tabArea(page)).toBeVisible({ timeout: 15_000 });
  await toggle(page).click();
  await expect(sensitivity(page)).toHaveValue('0.3');
  await expect(panel(page).locator('output')).toHaveText('0.30');
  await expect(min).toHaveValue('20');
  await expect(fret).toHaveValue('19');
});

test('the Confirm dialog: Cancel focused, Tab stays inside, Esc closes with nothing run; axe clean', async ({
  page,
}) => {
  await goLive(page, NOISY);
  const id = await recordAndAnalyse(page);
  const first = (await storedTab(page, id))!;
  const target = first.notes.find((n) => n.fret !== 5)!;
  await noteButton(page, target.id).click();
  await page.keyboard.press('5');
  await expect
    .poll(async () => (await storedTab(page, id))?.notes.find((n) => n.id === target.id)?.locked)
    .toBe(true);
  const before = await storedTab(page, id);

  await toggle(page).click();
  await reanalyse(page).click();
  const confirm = dialog(page);
  await expect(confirm).toBeVisible();
  await expect(confirm).toHaveAccessibleName(/^Re-analyse .+\?$/);
  await expect(confirm).toContainText(
    "Re-analysing replaces notes you haven't edited. Your edited notes are kept.",
  );
  const cancel = confirm.getByRole('button', { name: 'Cancel' });
  await expect(cancel).toBeFocused();
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Tab');
    expect(await confirm.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Shift+Tab');
  expect(await confirm.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await expectNoSeriousAxe(page);

  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(reanalyse(page)).toBeFocused();
  // The panel stays open (the dialog's Esc is its own).
  await expect(panel(page)).toBeVisible();
  await page.waitForTimeout(500);
  expect(await storedTab(page, id)).toEqual(before);
});
