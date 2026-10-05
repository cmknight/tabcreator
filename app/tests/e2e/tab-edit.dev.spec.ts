import { expect, test, type Page } from '@playwright/test';
import { collectErrors, recordButton, stopButton, timer } from './helpers';
import { FIXTURE, goLive } from './mic-helpers';
import { readTab } from './storage-helpers';
import { makeNotes, noteButton, openSeededTab, tabArea } from './tab-helpers';

// Story "Change a fret and undo it" (spine AD-4): set a fret with a digit, undo and redo it,
// the debounced save, and the edit-save storage-full banner, in the `dev` project (the fake mic,
// the seeding import of the dev server's storage module and `window.__putTabStorageFullHook`).

interface StoredNote {
  id: string;
  string: number;
  fret: number;
  midi: number;
  locked: boolean;
  lowConfidence: boolean;
}
interface StoredTab {
  takeId: string;
  notes: StoredNote[];
  deletedStartMs: number[];
  updatedAt: string;
}

/** The stored tab without `updatedAt` (every `putTab` stamps it anew). */
async function storedTab(page: Page, id: string): Promise<Omit<StoredTab, 'updatedAt'> | null> {
  const tab = await readTab<StoredTab>(page, id);
  if (!tab) return null;
  return { takeId: tab.takeId, notes: tab.notes, deletedStartMs: tab.deletedStartMs };
}

const storedNote = async (page: Page, takeId: string, noteId: string) =>
  (await readTab<StoredTab>(page, takeId))?.notes.find((n) => n.id === noteId) ?? null;

/** Records about 2 s of the fake mic and waits for its analysed tab; returns the take id. */
async function recordAndAnalyse(page: Page): Promise<string> {
  await recordButton(page).click();
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(timer(page)).toHaveText('0:02', { timeout: 5_000 });
  await stopButton(page).click();
  await expect(page).toHaveURL(/#\/tab\/[^/]+$/, { timeout: 15_000 });
  await expect(page.getByTestId('tab-status-line')).toBeVisible({ timeout: 20_000 });
  return decodeURIComponent(new URL(page.url()).hash.slice('#/tab/'.length));
}

/** Sets a dev hook on `window`. */
function setHook(page: Page, name: string, on: boolean): Promise<void> {
  return page.evaluate(
    ([key, value]) => {
      (window as unknown as Record<string, boolean>)[key] = value;
    },
    [name, on] as const,
  );
}

const statusCounts = (page: Page) => page.getByTestId('tab-status-line').locator('p');

/** Errors other than the dev-only warnings the failure paths log on purpose. */
const unexpected = (errors: string[]) => errors.filter((e) => !e.includes('[tabcreator]'));

test('a digit sets the fret; Ctrl+Z and Ctrl+Shift+Z / Ctrl+Y restore the stored Tab; it survives a reload', async ({
  page,
}) => {
  const errors = await goLive(page, FIXTURE);
  const takeId = await recordAndAnalyse(page);

  const before = await storedTab(page, takeId);
  expect(before?.notes.length ?? 0).toBeGreaterThan(0);
  const target = before!.notes.find((n) => n.fret !== 5)!;
  expect(target).toBeTruthy();

  await noteButton(page, target.id).click();
  await expect(noteButton(page, target.id)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('5');
  await expect(noteButton(page, target.id)).toHaveAttribute('aria-label', /, fret 5, /);
  await expect
    .poll(() => storedNote(page, takeId, target.id))
    .toMatchObject({ fret: 5, locked: true, lowConfidence: false, string: target.string });
  const after = await storedTab(page, takeId);

  await page.keyboard.press('Control+z');
  await expect.poll(() => storedTab(page, takeId)).toEqual(before);
  await expect(noteButton(page, target.id)).toHaveAttribute(
    'aria-label',
    new RegExp(`, fret ${target.fret}, `),
  );
  await page.keyboard.press('Control+Shift+Z');
  await expect.poll(() => storedTab(page, takeId)).toEqual(after);
  await page.keyboard.press('Control+z');
  await expect.poll(() => storedTab(page, takeId)).toEqual(before);
  await page.keyboard.press('Control+y');
  await expect.poll(() => storedTab(page, takeId)).toEqual(after);

  await page.reload();
  await expect(tabArea(page)).toBeVisible({ timeout: 15_000 });
  await expect(noteButton(page, target.id)).toHaveAttribute('aria-label', /, fret 5, /);
  expect(unexpected(errors)).toEqual([]);
});

test('a flagged note edited by a digit is no longer marked; "to check" drops by one', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const takeId = await openSeededTab(page, makeNotes(40, [5, 17, 30]));
  await expect(statusCounts(page)).toHaveText('40 notes · 3 to check');
  const flagged = noteButton(page, 'note-05');
  await expect(flagged).toHaveAttribute('aria-label', /, check this note$/);

  await flagged.click();
  await page.keyboard.press('7');
  await expect(statusCounts(page)).toHaveText('40 notes · 2 to check');
  await expect(flagged).not.toHaveAttribute('aria-label', /check this note/);
  await expect(flagged).toHaveAttribute('aria-label', /, fret 7, /);
  await expect
    .poll(() => storedNote(page, takeId, 'note-05'))
    .toMatchObject({ fret: 7, locked: true, lowConfidence: false });
  expect(unexpected(errors)).toEqual([]);
});

test('two digits within 400 ms make one fret, undone in one step', async ({ page }) => {
  const takeId = await openSeededTab(page, makeNotes(40));
  const before = await storedTab(page, takeId);
  await noteButton(page, 'note-11').click();
  await page.keyboard.press('1');
  await page.keyboard.press('2');
  await expect(noteButton(page, 'note-11')).toHaveAttribute('aria-label', /, fret 12, /);
  await expect.poll(() => storedNote(page, takeId, 'note-11')).toMatchObject({ fret: 12 });
  await page.keyboard.press('Control+z');
  await expect.poll(() => storedTab(page, takeId)).toEqual(before);
});

test('storage full: the banner shows, the edit is kept, and Retry saves it', async ({ page }) => {
  const errors = collectErrors(page);
  const takeId = await openSeededTab(page, makeNotes(40));
  await setHook(page, '__putTabStorageFullHook', true);

  await noteButton(page, 'note-11').click();
  await page.keyboard.press('7');
  const banner = page.getByTestId('tab-edit-storage-full');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(
    'Storage is full — delete takes or their audio, or back up and clear',
  );
  await expect(noteButton(page, 'note-11')).toHaveAttribute('aria-label', /, fret 7, /);
  expect((await storedNote(page, takeId, 'note-11'))?.fret).toBe(3);

  await setHook(page, '__putTabStorageFullHook', false);
  await banner.getByRole('button', { name: 'Retry' }).click();
  await expect(banner).toBeHidden();
  await expect
    .poll(() => storedNote(page, takeId, 'note-11'))
    .toMatchObject({ fret: 7, locked: true });
  expect(unexpected(errors)).toEqual([]);
});

test('Ctrl+Z and digits in the title field stay native', async ({ page }) => {
  const takeId = await openSeededTab(page, makeNotes(40));
  await noteButton(page, 'note-11').click();
  await page.keyboard.press('7');
  await expect
    .poll(() => storedNote(page, takeId, 'note-11'))
    .toMatchObject({ fret: 7, locked: true });
  const edited = await storedTab(page, takeId);

  await page.getByRole('button', { name: 'Rename take' }).click();
  const field = page.getByRole('textbox', { name: 'Take title' });
  await field.press('End');
  await field.press('5');
  await expect(field).toHaveValue('Seeded take5');
  await field.press('Control+z');
  await expect(field).toHaveValue('Seeded take');
  // Neither the digit nor Ctrl+Z reached the tab.
  await expect(noteButton(page, 'note-11')).toHaveAttribute('aria-label', /, fret 7, /);
  await page.waitForTimeout(500);
  expect(await storedTab(page, takeId)).toEqual(edited);
});
