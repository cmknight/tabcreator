import { expect, test, type Page } from '@playwright/test';
import { collectErrors, recordButton, stopButton, timer } from './helpers';
import { expectNoSeriousAxe, FIXTURE, goLive } from './mic-helpers';
import { strings } from '../../src/ui/strings';
import { readTab } from './storage-helpers';
import {
  focusedNote,
  makeNotes,
  noteButton,
  openSeededTab,
  seedTab,
  selectedNote,
  tabArea,
} from './tab-helpers';

// Story "Change a fret and undo it" (spine AD-4): set a fret with a digit, undo and redo it,
// the debounced save, and the edit-save storage-full banner, in the `dev` project (the fake mic,
// the seeding import of the dev server's storage module and `window.__putTabStorageFullHook`).

interface StoredNote {
  id: string;
  startMs: number;
  endMs: number;
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

// Story "String moves, delete, insert and confirm": ↑ / ↓, Delete, I and Enter; the edit popover;
// the toolbar's Insert and Delete.

const OPEN_MIDI: Record<number, number> = { 1: 64, 2: 59, 3: 55, 4: 50, 5: 45, 6: 40 };
const MAX_FRET = 24;

/** The thinner string ↑ moves a note at `midi` on `string` to (the nearest that plays it), or null. */
function thinnerString(string: number, midi: number): number | null {
  for (let s = string - 1; s >= 1; s--) {
    const fret = midi - OPEN_MIDI[s]!;
    if (fret >= 0 && fret <= MAX_FRET) return s;
  }
  return null;
}

/** Another string that plays `note`'s pitch (the nearest thicker, else thinner), or null. */
function otherString(note: StoredNote): number | null {
  for (const s of [6, 5, 4, 3, 2, 1]
    .filter((s) => s !== note.string)
    .sort((a, b) => Math.abs(a - note.string) - Math.abs(b - note.string))) {
    const fret = note.midi - OPEN_MIDI[s]!;
    if (fret >= 0 && fret <= MAX_FRET) return s;
  }
  return null;
}

/** The notes in played order. */
const played = (notes: readonly StoredNote[]) => [...notes].sort((a, b) => a.startMs - b.startMs);

/** The played-order number in a note button's label ("Note 12: …"). */
async function labelNumber(page: Page, id: string): Promise<number> {
  const label = (await noteButton(page, id).getAttribute('aria-label')) ?? '';
  return Number(/^Note (\d+):/.exec(label)?.[1]);
}

/**
 * Selects note `id` with the keyboard only: the skip link into the tab area, then ← / → along
 * played order.
 */
async function selectByKeyboard(page: Page, id: string): Promise<void> {
  const skip = page.getByRole('link', { name: 'Skip to tab' });
  await skip.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => focusedNote(page)).not.toBeNull();
  const from = await labelNumber(page, (await focusedNote(page))!);
  const to = await labelNumber(page, id);
  const key = to > from ? 'ArrowRight' : 'ArrowLeft';
  for (let i = 0; i < Math.abs(to - from); i++) await page.keyboard.press(key);
  await expect(noteButton(page, id)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => focusedNote(page)).toBe(id);
}

/** The stored tab's notes (none when it is not stored). */
async function storedNotes(page: Page, takeId: string): Promise<StoredNote[]> {
  return (await readTab<StoredTab>(page, takeId))?.notes ?? [];
}

test('keyboard only: ↑ / ↓ move strings, Delete / Backspace, I and Enter; all survive a reload', async ({
  page,
}) => {
  const errors = await goLive(page, FIXTURE);
  const takeId = await recordAndAnalyse(page);
  const before = played(await storedNotes(page, takeId));
  expect(before.length).toBeGreaterThanOrEqual(4);

  // ↑: the engine fingers the fixture on the thinnest strings it can, so first raise a note's
  // fret (a digit) until a thinner string plays it too; then ↑ moves it there, same pitch.
  const mover = before.find((n) => n.string > 1)!;
  expect(mover).toBeTruthy();
  await selectByKeyboard(page, mover.id);
  await page.keyboard.press('5');
  const raised = OPEN_MIDI[mover.string]! + 5;
  await expect.poll(() => storedNote(page, takeId, mover.id)).toMatchObject({ midi: raised });
  const to = thinnerString(mover.string, raised)!;
  expect(to).toBeLessThan(mover.string);
  await page.keyboard.press('ArrowUp');
  await expect
    .poll(() => storedNote(page, takeId, mover.id))
    .toMatchObject({
      string: to,
      fret: raised - OPEN_MIDI[to]!,
      midi: raised,
      locked: true,
      lowConfidence: false,
    });
  // ↓: back to the string it came from, same pitch.
  await page.keyboard.press('ArrowDown');
  await expect
    .poll(() => storedNote(page, takeId, mover.id))
    .toMatchObject({ string: mover.string, fret: 5, midi: raised, locked: true });

  // Delete: a middle note (not the mover); the next one is selected.
  const victim = before.find((n, i) => i > 0 && i < before.length - 1 && n.id !== mover.id)!;
  const next = before[before.indexOf(victim) + 1]!;
  await selectByKeyboard(page, victim.id);
  await page.keyboard.press('Delete');
  await expect(noteButton(page, victim.id)).toHaveCount(0);
  await expect.poll(() => selectedNote(page)).toBe(next.id);
  await expect
    .poll(async () => {
      const tab = await readTab<StoredTab>(page, takeId);
      return {
        gone: !tab?.notes.some((n) => n.id === victim.id),
        recorded: tab?.deletedStartMs.includes(victim.startMs),
      };
    })
    .toEqual({ gone: true, recorded: true });

  // Backspace deletes too: another middle note.
  const left = played(await storedNotes(page, takeId));
  const second = left.find((n, i) => i > 0 && i < left.length - 1 && n.id !== mover.id)!;
  await selectByKeyboard(page, second.id);
  await page.keyboard.press('Backspace');
  await expect(noteButton(page, second.id)).toHaveCount(0);
  await expect
    .poll(async () => {
      const tab = await readTab<StoredTab>(page, takeId);
      return {
        gone: !tab?.notes.some((n) => n.id === second.id),
        recorded: tab?.deletedStartMs.includes(second.startMs),
      };
    })
    .toEqual({ gone: true, recorded: true });

  // I: after the first note, midway to the second, on its string, fret 0, locked.
  const now = played(await storedNotes(page, takeId));
  const [first, after] = [now[0]!, now[1]!];
  await selectByKeyboard(page, first.id);
  await page.keyboard.press('i');
  const ids = new Set(now.map((n) => n.id));
  await expect
    .poll(async () => (await storedNotes(page, takeId)).find((n) => !ids.has(n.id)) ?? null)
    .toMatchObject({
      startMs: (first.startMs + after.startMs) / 2,
      string: first.string,
      fret: 0,
      midi: OPEN_MIDI[first.string],
      locked: true,
      lowConfidence: false,
    });
  const inserted = (await storedNotes(page, takeId)).find((n) => !ids.has(n.id))!;
  await expect(noteButton(page, inserted.id)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => focusedNote(page)).toBe(inserted.id);

  // Enter on a note: confirmed (locked, not flagged).
  const unlocked = played(await storedNotes(page, takeId)).find((n) => !n.locked)!;
  expect(unlocked).toBeTruthy();
  await selectByKeyboard(page, unlocked.id);
  await page.keyboard.press('Enter');
  await expect
    .poll(() => storedNote(page, takeId, unlocked.id))
    .toMatchObject({ locked: true, lowConfidence: false });

  const edited = await storedTab(page, takeId);
  await page.reload();
  await expect(tabArea(page)).toBeVisible({ timeout: 15_000 });
  expect(await storedTab(page, takeId)).toEqual(edited);
  await expect(noteButton(page, victim.id)).toHaveCount(0);
  await expect(noteButton(page, inserted.id)).toHaveCount(1);
  await expect(noteButton(page, second.id)).toHaveCount(0);
  // ↓ took it back to its own string, at the raised fret.
  await expect(noteButton(page, mover.id)).toHaveAttribute('aria-label', /, fret 5, /);
  expect(unexpected(errors)).toEqual([]);
});

test('mouse only: the popover moves and confirms; the toolbar inserts and deletes; all survive a reload', async ({
  page,
}) => {
  const errors = await goLive(page, FIXTURE);
  const takeId = await recordAndAnalyse(page);
  const before = played(await storedNotes(page, takeId));
  expect(before.length).toBeGreaterThanOrEqual(4);

  // Double-click: the popover; a position button moves the note, keeping its pitch.
  const mover = before.find((n) => otherString(n) !== null)!;
  const to = otherString(mover)!;
  await noteButton(page, mover.id).dblclick();
  const dialog = page.getByRole('dialog', { name: 'Edit note' });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole('button', { name: `String ${to}, fret ${mover.midi - OPEN_MIDI[to]!}` })
    .click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(() => storedNote(page, takeId, mover.id))
    .toMatchObject({ string: to, midi: mover.midi, locked: true });

  // Confirm locks another note.
  const other = played(await storedNotes(page, takeId)).find((n) => !n.locked)!;
  await noteButton(page, other.id).dblclick();
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(() => storedNote(page, takeId, other.id))
    .toMatchObject({ locked: true, lowConfidence: false });

  // The toolbar: Insert after a clicked note, then Delete the selected one.
  const toolbar = page.getByRole('toolbar', { name: 'Tab tools' });
  const now = played(await storedNotes(page, takeId));
  const ids = new Set(now.map((n) => n.id));
  await noteButton(page, now[1]!.id).click();
  await toolbar.getByRole('button', { name: 'Insert' }).click();
  await expect
    .poll(async () => (await storedNotes(page, takeId)).find((n) => !ids.has(n.id)) ?? null)
    .toMatchObject({ string: now[1]!.string, fret: 0, locked: true });
  const inserted = (await storedNotes(page, takeId)).find((n) => !ids.has(n.id))!;

  const victim = now[2]!;
  await noteButton(page, victim.id).click();
  await toolbar.getByRole('button', { name: 'Delete' }).click();
  await expect(noteButton(page, victim.id)).toHaveCount(0);
  await expect
    .poll(async () => (await readTab<StoredTab>(page, takeId))?.deletedStartMs ?? [])
    .toContain(victim.startMs);

  const edited = await storedTab(page, takeId);
  await page.reload();
  await expect(tabArea(page)).toBeVisible({ timeout: 15_000 });
  expect(await storedTab(page, takeId)).toEqual(edited);
  await expect(noteButton(page, inserted.id)).toHaveCount(1);
  await expect(noteButton(page, victim.id)).toHaveCount(0);
  expect(unexpected(errors)).toEqual([]);
});

test('the popover traps Tab, Esc closes it back to the note, and axe passes with it open', async ({
  page,
}) => {
  const errors = await goLive(page, FIXTURE);
  const takeId = await recordAndAnalyse(page);
  const before = await storedTab(page, takeId);
  const target = played(before!.notes)[1]!;
  const note = noteButton(page, target.id);
  await note.dblclick();
  const dialog = page.getByRole('dialog', { name: 'Edit note' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('spinbutton', { name: 'Fret' })).toBeFocused();
  const inside = () => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    expect(await inside()).toBe(true);
  }
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await inside()).toBe(true);
  }
  // No Tab-screen shortcut runs under it.
  await page.keyboard.press('n');
  await page.keyboard.press('Delete');
  await expect(note).toHaveCount(1);
  await expectNoSeriousAxe(page);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(note).toBeFocused();
  await page.waitForTimeout(500);
  expect(await storedTab(page, takeId)).toEqual(before);

  // A fret typed in the popover and Enter sets it.
  await note.dblclick();
  const field = dialog.getByRole('spinbutton', { name: 'Fret' });
  await field.fill('9');
  await field.press('Enter');
  await expect(dialog).toBeHidden();
  await expect
    .poll(() => storedNote(page, takeId, target.id))
    .toMatchObject({ fret: 9, locked: true });
  expect(unexpected(errors)).toEqual([]);
});

// Story "Re-fit feedback": the notes an edit's re-fit re-fingered are outlined for about 1.5 s
// and "<n> nearby notes re-fingered" follows the edit's announcement; undo outlines nothing.

/** The re-fit outline's hold and fade (`REFIT_HOLD_MS`, `REFIT_FADE_MS` in screens/Tab.tsx). */
const REFIT_HOLD_MS = 1500;
const REFIT_FADE_MS = 300;

interface RefitLog {
  /** The polite region's non-empty texts, in order. */
  polite: string[];
  /** Each change of the outlined notes: when, and which (with their `data-refit` state). */
  outlines: { at: number; ids: string[]; states: string[] }[];
}

/** Starts logging the polite region and the re-fit outlines in the page (`window.__refit`). */
function watchRefit(page: Page): Promise<void> {
  return page.evaluate(() => {
    const log: RefitLog = { polite: [], outlines: [] };
    (window as unknown as { __refit: RefitLog }).__refit = log;
    const region = document.querySelector('[aria-live="polite"]')!;
    let lastKey = '';
    const record = () => {
      const text = region.textContent ?? '';
      if (text && log.polite.at(-1) !== text) log.polite.push(text);
      const els = [...document.querySelectorAll('[data-refit]')];
      const ids = els.map((el) => el.getAttribute('data-note-id') ?? '');
      const states = els.map((el) => el.getAttribute('data-refit') ?? '');
      const key = `${ids.join(',')}|${states.join(',')}`;
      if (key !== lastKey) {
        lastKey = key;
        log.outlines.push({ at: performance.now(), ids, states });
      }
    };
    new MutationObserver(record).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-refit'],
    });
  });
}

const refitLog = (page: Page) =>
  page.evaluate(() => (window as unknown as { __refit: RefitLog }).__refit);

/** The other notes whose stored string or fret differ between `before` and `after`, sorted. */
function changedIds(
  before: Omit<StoredTab, 'updatedAt'>,
  after: Omit<StoredTab, 'updatedAt'>,
  targetId: string,
): string[] {
  const was = new Map(before.notes.map((n) => [n.id, n]));
  return after.notes
    .filter((n) => n.id !== targetId)
    .filter((n) => {
      const old = was.get(n.id);
      return old && (old.string !== n.string || old.fret !== n.fret);
    })
    .map((n) => n.id)
    .sort();
}

/**
 * The edit's announcement then "<n> nearby notes re-fingered"; exactly `changed` outlined, fading
 * about 1.5 s later and then gone.
 */
async function expectRefitShown(page: Page, editText: string, changed: string[]): Promise<void> {
  await expect
    .poll(async () => (await refitLog(page)).polite.slice(-2))
    .toEqual([editText, strings['tab.refingered'](changed.length)]);
  await expect(page.locator('[data-refit]')).toHaveCount(0, { timeout: 5_000 });
  const { outlines } = await refitLog(page);
  const shown = outlines.find((o) => o.ids.length > 0)!;
  expect([...shown.ids].sort()).toEqual(changed);
  expect(shown.states.every((s) => s === 'true')).toBe(true);
  const fading = outlines.find((o) => o.at > shown.at && o.states.includes('fading'))!;
  const gone = outlines.findLast((o) => o.ids.length === 0)!;
  expect(fading.at - shown.at).toBeGreaterThan(1_300);
  expect(fading.at - shown.at).toBeLessThan(2_000);
  expect(gone.at - shown.at).toBeGreaterThan(1_300);
  expect(gone.at - shown.at).toBeLessThan(2_500);
}

test('re-fit feedback on c_major: the move re-fingers no note, so no outline or re-fit announcement; undo outlines nothing', async ({
  page,
}) => {
  const errors = await goLive(page, FIXTURE);
  const takeId = await recordAndAnalyse(page);
  const before = await storedTab(page, takeId);
  // C3: the A string, fret 3; the popover offers the low E string, fret 8.
  const target = before!.notes.find((n) => n.string === 5 && n.fret === 3)!;
  expect(target).toBeTruthy();

  await watchRefit(page);
  await noteButton(page, target.id).dblclick();
  const dialog = page.getByRole('dialog', { name: 'Edit note' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'String 6, fret 8' }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(() => storedNote(page, takeId, target.id))
    .toMatchObject({ string: 6, fret: 8, locked: true });

  // The real engine re-fingers no other note for this move (n = 0), so this take shows no
  // outline; the outline, its count and its lifetime are asserted on a seeded tab (the test
  // below) whose re-fit is known to move its neighbours.
  expect(changedIds(before!, (await storedTab(page, takeId))!, target.id)).toEqual([]);

  // The move's announcement, and past the full hold and fade no re-fit announcement or outline.
  const moved = strings['tab.editMoved'](6, 8);
  await expect.poll(async () => (await refitLog(page)).polite.at(-1)).toBe(moved);
  await page.waitForTimeout(REFIT_HOLD_MS + REFIT_FADE_MS + 200);
  const { polite, outlines } = await refitLog(page);
  expect(polite.at(-1)).toBe(moved);
  expect(polite.filter((t) => t.includes('re-fingered'))).toEqual([]);
  expect(outlines.filter((o) => o.ids.length > 0)).toEqual([]);

  // Ctrl+Z: the stored Tab as before, no outline, the edited note selected.
  await page.keyboard.press('Control+z');
  await expect.poll(() => storedTab(page, takeId)).toEqual(before);
  await expect(page.locator('[data-refit]')).toHaveCount(0);
  await expect(noteButton(page, target.id)).toHaveAttribute('aria-pressed', 'true');
  expect((await refitLog(page)).outlines.at(-1)!.ids).toEqual([]);
  expect(unexpected(errors)).toEqual([]);
});

test('re-fit feedback on a seeded tab: a fret change re-fingers its neighbours, outlined about 1.5 s', async ({
  page,
}) => {
  const errors = collectErrors(page);
  // One phrase fingered high on the thick strings, where the engine would not put it: a fret
  // change on its first note re-fits the rest to the engine's own fingering.
  const seeded = [
    { string: 6, fret: 20, midi: 60 },
    { string: 6, fret: 22, midi: 62 },
    { string: 5, fret: 19, midi: 64 },
    { string: 5, fret: 20, midi: 65 },
  ].map(({ string, fret, midi }, i) => {
    const startMs = 1500 + i * 250;
    return {
      id: `s${i}`,
      startMs,
      endMs: startMs + 200,
      midi,
      confidence: 0.9,
      string: string as 5 | 6,
      fret,
      locked: false,
      lowConfidence: false,
    };
  });
  const takeId = await openSeededTab(page, seeded);
  const before = await storedTab(page, takeId);

  await watchRefit(page);
  await noteButton(page, 's0').click();
  await page.keyboard.press('1');
  await expect.poll(() => storedNote(page, takeId, 's0')).toMatchObject({ string: 6, fret: 1 });
  const changed = changedIds(before!, (await storedTab(page, takeId))!, 's0');
  expect(changed.length).toBeGreaterThan(0);
  await expectRefitShown(page, strings['tab.editFret'](1, 6), changed);

  await page.keyboard.press('Control+z');
  await expect.poll(() => storedTab(page, takeId)).toEqual(before);
  await expect(page.locator('[data-refit]')).toHaveCount(0);
  await expect(noteButton(page, 's0')).toHaveAttribute('aria-pressed', 'true');
  expect(unexpected(errors)).toEqual([]);
});

// Story "Undo and redo controls": the toolbar's Undo and Redo, their tooltips, the Insert and
// Delete reasons, and ⌘Z / ⌘⇧Z on macOS.

const toolButton = (page: Page, name: string) =>
  page.getByRole('toolbar', { name: 'Tab tools' }).getByRole('button', { name, exact: true });

/** The tool button is disabled or enabled with `tooltip` as its title and description. */
async function expectTool(page: Page, name: string, enabled: boolean, tooltip: string) {
  const button = toolButton(page, name);
  if (enabled) await expect(button).toBeEnabled();
  else await expect(button).toBeDisabled();
  await expect(button).toHaveAccessibleDescription(tooltip);
  await expect(button.locator('..')).toHaveAttribute('title', tooltip);
}

test('Undo and Redo buttons: a popover move, then Undo reverts it, focus on Redo; Redo restores it', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const takeId = await openSeededTab(page);
  const before = await storedTab(page, takeId);
  await expectTool(page, 'Undo', false, 'Nothing to undo');
  await expectTool(page, 'Redo', false, 'Nothing to redo');
  await expectTool(page, 'Delete', false, 'Select a note to delete');

  // Note 12 (index 11) is D4 on the B string at fret 3; the G string plays it at fret 7.
  await noteButton(page, 'note-11').dblclick();
  const dialog = page.getByRole('dialog', { name: 'Edit note' });
  await dialog.getByRole('button', { name: 'String 3, fret 7' }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(() => storedNote(page, takeId, 'note-11'))
    .toMatchObject({ string: 3, fret: 7 });
  await expectTool(page, 'Undo', true, 'Undo move to string 3');
  await expectTool(page, 'Redo', false, 'Nothing to redo');

  await toolButton(page, 'Undo').click();
  await expect.poll(() => storedTab(page, takeId)).toEqual(before);
  await expectTool(page, 'Undo', false, 'Nothing to undo');
  await expectTool(page, 'Redo', true, 'Redo move to string 3');
  await expect(toolButton(page, 'Redo')).toBeFocused();
  await expect(noteButton(page, 'note-11')).toHaveAttribute('aria-pressed', 'true');

  // Keyboard on the focused Redo: Enter redoes, focus moves back to Undo.
  await page.keyboard.press('Enter');
  await expect
    .poll(() => storedNote(page, takeId, 'note-11'))
    .toMatchObject({ string: 3, fret: 7 });
  await expectTool(page, 'Undo', true, 'Undo move to string 3');
  await expect(toolButton(page, 'Undo')).toBeFocused();
  await expectNoSeriousAxe(page);
  expect(unexpected(errors)).toEqual([]);
});

test('macOS: ⌘Z undoes and ⌘⇧Z redoes; Ctrl+Z and Ctrl+Y do nothing', async ({ page }) => {
  const errors = collectErrors(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
    Object.defineProperty(navigator, 'userAgentData', { get: () => ({ platform: 'macOS' }) });
  });
  const takeId = await openSeededTab(page);

  // Two edits on two notes: two undo steps.
  await noteButton(page, 'note-11').click();
  await page.keyboard.press('5');
  await expect.poll(() => storedNote(page, takeId, 'note-11')).toMatchObject({ fret: 5 });
  await page.keyboard.press('ArrowRight');
  await expect(noteButton(page, 'note-12')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('7');
  await expect.poll(() => storedNote(page, takeId, 'note-12')).toMatchObject({ fret: 7 });
  await expectTool(page, 'Undo', true, 'Undo set fret 7');

  // Ctrl+Z and Ctrl+Y are not the Mac's undo and redo: nothing changes.
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+y');
  // Past the 300 ms save debounce, so an undo they had queued would show here.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
  await expectTool(page, 'Undo', true, 'Undo set fret 7');
  await expectTool(page, 'Redo', false, 'Nothing to redo');
  expect(await storedNote(page, takeId, 'note-12')).toMatchObject({ fret: 7 });
  expect(await storedNote(page, takeId, 'note-11')).toMatchObject({ fret: 5 });

  // ⌘Z undoes one step.
  await page.keyboard.press('Meta+z');
  await expectTool(page, 'Undo', true, 'Undo set fret 5');
  await expectTool(page, 'Redo', true, 'Redo set fret 7');
  await expect.poll(() => storedNote(page, takeId, 'note-12')).toMatchObject({ fret: 9 });
  expect(await storedNote(page, takeId, 'note-11')).toMatchObject({ fret: 5 });

  await page.keyboard.press('Meta+Shift+z');
  await expectTool(page, 'Redo', false, 'Nothing to redo');
  await expect.poll(() => storedNote(page, takeId, 'note-12')).toMatchObject({ fret: 7 });
  expect(unexpected(errors)).toEqual([]);
});

test('No notes found: Undo, Redo, Insert and Delete disabled with their reasons', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('./#/library');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  const id = await seedTab(page, []);
  await page.goto(`./#/tab/${encodeURIComponent(id)}`);
  await expect(page.getByRole('heading', { name: 'No notes found' })).toBeVisible();
  const toolbar = page.getByRole('toolbar', { name: 'Tab tools' });
  await expect(toolbar.getByRole('button')).toHaveText(['Undo', 'Redo', 'Insert', 'Delete']);
  await expectTool(page, 'Undo', false, 'Nothing to undo');
  await expectTool(page, 'Redo', false, 'Nothing to redo');
  await expectTool(page, 'Insert', false, 'No notes yet');
  await expectTool(page, 'Delete', false, 'No notes yet');
  await expectNoSeriousAxe(page);
  expect(unexpected(errors)).toEqual([]);
});

test('deleting the only note: No notes found with "Undo delete note"; Undo brings it back', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const takeId = await openSeededTab(page, makeNotes(1));
  const before = await storedTab(page, takeId);
  await noteButton(page, 'note-00').click();
  await toolButton(page, 'Delete').click();
  await expect(page.getByRole('heading', { name: 'No notes found' })).toBeVisible();
  await expectTool(page, 'Undo', true, 'Undo delete note');
  await expectTool(page, 'Insert', false, 'No notes yet');
  await expectTool(page, 'Delete', false, 'No notes yet');
  await toolButton(page, 'Undo').click();
  await expect(noteButton(page, 'note-00')).toBeVisible();
  await expect.poll(() => storedTab(page, takeId)).toEqual(before);
  await expectTool(page, 'Redo', true, 'Redo delete note');
  expect(unexpected(errors)).toEqual([]);
});
