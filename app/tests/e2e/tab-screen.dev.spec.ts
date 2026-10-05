import { expect, test, type Page } from '@playwright/test';
import { layoutTab } from '../../src/model/tab-render';
import { collectErrors } from './helpers';
import { expectNoSeriousAxe } from './mic-helpers';
import {
  focusedNote,
  longestLine,
  makeNotes,
  noteButton,
  noteButtons,
  openSeededTab,
  readTake,
  selectedNote,
  tabArea,
  widthChars,
} from './tab-helpers';

// Story "Tab screen, reflow and selection" (US-6.2, US-6.3, US-8.2): the Tab screen on a seeded
// analysed take of 40 notes, one test per row of the plan's I/O matrix, in the `dev` project
// (the seed imports the dev server's storage module).

const NOTES = makeNotes();
const first = NOTES[0]!.id;
const second = NOTES[1]!.id;
const last = NOTES.at(-1)!.id;
const renameButton = (page: Page) => page.getByRole('button', { name: 'Rename take' });
const h1 = (page: Page) => page.getByRole('heading', { level: 1 });

/** Whether the page scrolls sideways. */
const pageScrollsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

/**
 * Whether anything of the tab area reaches past the viewport's right edge. (At 320 px the shell's
 * top bar is wider than the window, so the page check alone cannot speak for the tab there.)
 */
const tabOverflowsViewport = (page: Page) =>
  tabArea(page).evaluate((area) => {
    const right = document.documentElement.clientWidth;
    return [area, ...area.querySelectorAll('[role="group"], pre, [data-note-id]')].some(
      (el) => el.getBoundingClientRect().right > right + 0.5,
    );
  });

test('reflow: resizing re-lays the tab out within the width and keeps the selection and focus', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1200, height: 800 });
  await openSeededTab(page);
  const target = NOTES[25]!.id;
  await noteButton(page, target).click();
  await expect(noteButton(page, target)).toHaveAttribute('aria-pressed', 'true');
  expect(await focusedNote(page)).toBe(target);

  let previous = await widthChars(page);
  for (const width of [500, 900, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(() => widthChars(page)).not.toBe(previous);
    previous = await widthChars(page);
    expect(previous).toBeGreaterThanOrEqual(20);
    expect(await longestLine(page)).toBeLessThanOrEqual(previous);
    expect(await tabOverflowsViewport(page)).toBe(false);
    if (width >= 500) expect(await pageScrollsSideways(page)).toBe(false);
    // Every note button still sits inside its system's box.
    const overflow = await tabArea(page)
      .getByRole('group')
      .evaluateAll((groups) =>
        groups.some((g) => {
          const box = g.getBoundingClientRect();
          return [...g.querySelectorAll('[data-note-id]')].some(
            (b) => b.getBoundingClientRect().right > box.right + 0.5,
          );
        }),
      );
    expect(overflow).toBe(false);
    expect(await selectedNote(page)).toBe(target);
    expect(await focusedNote(page)).toBe(target);
  }
  expect(errors).toEqual([]);
});

test('Esc then →: the next note after the one that kept focus; the focused note keeps the tab stop', async ({
  page,
}) => {
  await openSeededTab(page);
  const n30 = NOTES[30]!.id;
  await noteButton(page, n30).click();
  await page.keyboard.press('Escape');
  await expect(tabArea(page).locator('[aria-pressed="true"]')).toHaveCount(0);
  await expect(noteButton(page, n30)).toHaveAttribute('tabindex', '0');
  await page.keyboard.press('ArrowRight');
  await expect(noteButton(page, NOTES[31]!.id)).toBeFocused();
  expect(await selectedNote(page)).toBe(NOTES[31]!.id);
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowLeft');
  await expect(noteButton(page, n30)).toBeFocused();
  expect(await selectedNote(page)).toBe(n30);
});

test('Esc then reflow: focus stays on the same note, which stays unselected', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await openSeededTab(page);
  const n30 = NOTES[30]!.id;
  await noteButton(page, n30).click();
  await page.keyboard.press('Escape');
  for (const width of [500, 900]) {
    const before = await widthChars(page);
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(() => widthChars(page)).not.toBe(before);
    await expect(noteButton(page, n30)).toBeFocused();
    await expect(tabArea(page).locator('[aria-pressed="true"]')).toHaveCount(0);
    await expect(noteButton(page, n30)).toHaveAttribute('tabindex', '0');
  }
});

test('note buttons sit over their digits in the real layout, at two widths', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await openSeededTab(page);
  const target = NOTES[11]!.id; // note 12
  for (const width of [1200, 600]) {
    const before = await widthChars(page);
    await page.setViewportSize({ width, height: 800 });
    if (width !== 1200) await expect.poll(() => widthChars(page)).not.toBe(before);
    await page.waitForTimeout(250); // past the reflow debounce
    const w = await widthChars(page);
    const layout = layoutTab(NOTES, w);
    const systemIndex = layout.systems.findIndex((s) => s.cells.some((c) => c.noteId === target));
    const system = layout.systems[systemIndex]!;
    const cell = system.cells.find((c) => c.noteId === target)!;
    const offset =
      system.lines.slice(0, cell.string - 1).reduce((n, l) => n + l.length + 1, 0) + cell.col;
    const { range, button, text } = await tabArea(page)
      .getByRole('group')
      .nth(systemIndex)
      .evaluate(
        (group, { offset, width, id }) => {
          const pre = group.querySelector('pre')!;
          const r = document.createRange();
          r.setStart(pre.firstChild!, offset);
          r.setEnd(pre.firstChild!, offset + width);
          const a = r.getBoundingClientRect();
          const b = group.querySelector(`[data-note-id="${id}"]`)!.getBoundingClientRect();
          return {
            range: { left: a.left, top: a.top, width: a.width },
            button: { left: b.left, top: b.top, width: b.width },
            text: r.toString(),
          };
        },
        { offset, width: cell.width, id: target },
      );
    expect(text).toBe('3');
    expect(Math.abs(range.left - button.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(range.top - button.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(range.width - button.width)).toBeLessThanOrEqual(1);
  }
});

test('label: each note button has its label; the 12th note reads as in US-6.2', async ({
  page,
}) => {
  await openSeededTab(page);
  await expect(noteButtons(page)).toHaveCount(NOTES.length);
  await expect(noteButton(page, NOTES[11]!.id)).toHaveAttribute(
    'aria-label',
    'Note 12: B string, fret 3, D4, at 4.25 seconds',
  );
  const labels = await noteButtons(page).evaluateAll((els) =>
    els.map((e) => e.getAttribute('aria-label') ?? ''),
  );
  expect(
    labels.every((l) =>
      /^Note \d+: .+ string, fret \d+, [A-G]#?-?\d, at \d+\.\d\d seconds$/.test(l),
    ),
  ).toBe(true);
  await expect(tabArea(page)).toHaveAttribute('aria-describedby', /.+/);
  await expect(tabArea(page).getByRole('group').first()).toHaveAttribute(
    'aria-label',
    /^Tab system 1 of \d+$/,
  );
});

test('arrows: → / ← select and focus the next / previous note, and stop at the ends', async ({
  page,
}) => {
  await openSeededTab(page);
  await noteButton(page, first).focus();
  expect(await selectedNote(page)).toBe(first);
  await page.keyboard.press('ArrowLeft');
  expect(await selectedNote(page)).toBe(first);
  await page.keyboard.press('ArrowRight');
  await expect(noteButton(page, second)).toBeFocused();
  expect(await selectedNote(page)).toBe(second);
  await page.keyboard.press('ArrowLeft');
  await expect(noteButton(page, first)).toBeFocused();
  // To the end, across the system break.
  await noteButton(page, NOTES.at(-2)!.id).click();
  await page.keyboard.press('ArrowRight');
  await expect(noteButton(page, last)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(noteButton(page, last)).toBeFocused();
  expect(await selectedNote(page)).toBe(last);
  // One Tab stop: the selected note.
  await expect(tabArea(page).locator('[data-note-id][tabindex="0"]')).toHaveCount(1);
  await expect(noteButton(page, last)).toHaveAttribute('tabindex', '0');
});

test('Esc: clears the selection; focus stays in the tab area', async ({ page }) => {
  await openSeededTab(page);
  await noteButton(page, second).click();
  expect(await selectedNote(page)).toBe(second);
  await page.keyboard.press('Escape');
  await expect(tabArea(page).locator('[aria-pressed="true"]')).toHaveCount(0);
  expect(await focusedNote(page)).toBe(second);
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="application"]'))).toBe(
    true,
  );
});

test('title field: arrows and Esc typed there leave the selection; Esc cancels the rename only', async ({
  page,
}) => {
  await openSeededTab(page, undefined, 'Seeded take');
  await noteButton(page, second).click();
  await renameButton(page).click();
  const field = page.getByRole('textbox', { name: 'Take title' });
  await expect(field).toBeFocused();
  await field.press('End');
  await field.pressSequentially(' x');
  await field.press('ArrowLeft');
  await field.press('ArrowRight');
  expect(await selectedNote(page)).toBe(second);
  await field.press('Escape');
  await expect(field).toHaveCount(0);
  await expect(h1(page)).toHaveText('Seeded take');
  await expect(renameButton(page)).toBeFocused();
  expect(await selectedNote(page)).toBe(second);
});

test('rename: type + Enter saves the title (take-session); empty reverts with no write', async ({
  page,
}) => {
  const id = await openSeededTab(page, undefined, 'Seeded take');
  await renameButton(page).click();
  const field = page.getByRole('textbox', { name: 'Take title' });
  await field.fill('  Riff in A  ');
  await field.press('Enter');
  await expect(h1(page)).toHaveText('Riff in A');
  await expect(renameButton(page)).toBeFocused();
  await expect.poll(async () => (await readTake(page, id)).title).toBe('Riff in A');
  const saved = await readTake(page, id);

  await renameButton(page).click();
  await field.fill('   ');
  await field.press('Enter');
  await expect(h1(page)).toHaveText('Riff in A');
  await page.waitForTimeout(200);
  expect(await readTake(page, id)).toMatchObject({
    title: 'Riff in A',
    updatedAt: saved.updatedAt,
  });

  // It survives a reload: it was written to storage.
  await page.reload();
  await expect(h1(page)).toHaveText('Riff in A');
});

test('skip link: the first focusable element of the screen; it moves focus to the selected, else the first, note', async ({
  page,
}) => {
  await openSeededTab(page);
  const skip = page.getByRole('link', { name: 'Skip to tab' });
  // Tab from the last navigation link reaches the skip link first.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link').last().focus();
  await page.keyboard.press('Tab');
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(noteButton(page, first)).toBeFocused();

  await noteButton(page, NOTES[30]!.id).click();
  await skip.focus();
  await page.keyboard.press('Enter');
  await expect(noteButton(page, NOTES[30]!.id)).toBeFocused();
});

test('note list: toggling it on shows an <ol> of the same labels in the same order', async ({
  page,
}) => {
  await openSeededTab(page);
  const toggle = page.getByRole('button', { name: 'Note list view' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const items = page.getByTestId('tab-note-list').locator('li');
  await expect(items).toHaveCount(NOTES.length);
  const labels = await noteButtons(page).evaluateAll((els) =>
    els
      .map((e) => ({ id: e.getAttribute('data-note-id')!, label: e.getAttribute('aria-label')! }))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((e) => e.label),
  );
  expect(await items.allTextContents()).toEqual(labels);
  expect(await page.getByTestId('tab-note-list').evaluate((el) => el.tagName)).toBe('OL');
});

test('toolbar focus: arrows and Esc with focus in the toolbar change no selection', async ({
  page,
}) => {
  await openSeededTab(page);
  await noteButton(page, second).click();
  // The toolbar has no buttons yet (later stories): add one to hold focus.
  const toolbar = page.getByRole('toolbar', { name: 'Tab tools' });
  await toolbar.evaluate((el) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Probe';
    el.append(button);
  });
  await toolbar.getByRole('button', { name: 'Probe' }).focus();
  for (const key of ['ArrowRight', 'ArrowLeft', 'Escape']) await page.keyboard.press(key);
  expect(await selectedNote(page)).toBe(second);
  await expect(toolbar.getByRole('button', { name: 'Probe' })).toBeFocused();
});

test('axe: the analysed tab has no serious or critical violations, light and dark', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openSeededTab(page);
  await noteButton(page, second).click();
  await page.getByRole('button', { name: 'Note list view' }).click();
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(
      colorScheme,
    );
    await expectNoSeriousAxe(page);
  }
  expect(errors).toEqual([]);
});
