import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { STRING_LETTERS } from '../../src/model/tab-render';
import { seedTheme, expectTheme, THEMES } from './a11y-helpers';
import { clipboard, toast } from './export-helpers';
import { collectErrors, recordButton, stopButton, timer } from './helpers';
import { watchHygiene } from './hygiene';
import { meter } from './mic-helpers';
import { readTab } from './storage-helpers';
import { focusedNote, noteButton, selectedNote } from './tab-helpers';

// Story "Accessibility sweep: axe in both themes and keyboard-only flow" (CAP-21, US-8.2, the
// EXPERIENCE Accessibility Floor), in the production-mic lane, once per theme (the stored pref,
// seeded before the first load): record → edit → export with the keyboard alone. After the
// `goto` the test only presses keys (`page.keyboard`): no click, double-click, hover or mouse.
//
// Focus is visible at every focus move: the focused element matches `:focus-visible`, and its
// computed outline or box-shadow while focused differs from the same element's once blurred, and
// is not transparent; so a permanent style (a selected note's selection outline, the active nav
// link's underline) never counts as the indicator. A note's indicator must be its ring, the
// `.note:focus-visible` box-shadow (TabArea.module.css). After the measure, focus is put back on
// the element, which must match `:focus-visible` again.

/** The focus-indicator properties of an element, as computed. */
interface Indicator {
  outlineStyle: string;
  outlineWidth: string;
  outlineColor: string;
  boxShadow: string;
}

interface Measured {
  tag: string;
  name: string;
  noteId: string | null;
  focusVisible: boolean;
  focused: Indicator;
  blurred: Indicator;
  /** Focus was put back on the element and it matches `:focus-visible` again. */
  restored: boolean;
}

/** Measures the focused element focused and blurred, then puts focus back; null for none. */
function measureFocus(page: Page): Promise<Measured | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || el === document.documentElement) return null;
    const read = (): Indicator => {
      const s = getComputedStyle(el);
      return {
        outlineStyle: s.outlineStyle,
        outlineWidth: s.outlineWidth,
        outlineColor: s.outlineColor,
        boxShadow: s.boxShadow,
      };
    };
    const focusVisible = el.matches(':focus-visible');
    const focused = read();
    el.blur();
    const blurred = read();
    el.focus({ preventScroll: true });
    return {
      tag: el.tagName.toLowerCase(),
      name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim(),
      noteId: el.getAttribute('data-note-id'),
      focusVisible,
      focused,
      blurred,
      restored: document.activeElement === el && el.matches(':focus-visible'),
    };
  });
}

/** Whether a computed colour (`rgb(…)`, `rgba(…)`) is not fully transparent. */
const opaque = (color: string) => {
  const alpha = /^rgba\([^)]*,\s*([\d.]+)\)$/.exec(color);
  return color !== 'transparent' && (alpha === null || Number(alpha[1]) > 0);
};

/** Whether a computed box-shadow draws something: not `none`, with a non-transparent colour. */
const shadowDraws = (shadow: string) =>
  shadow !== 'none' && (shadow.match(/rgba?\([^)]*\)/g) ?? []).some(opaque);

/** Whether the outline, as focused, is drawn and differs from the blurred one. */
const outlineRing = (m: Measured) =>
  m.focused.outlineStyle !== 'none' &&
  parseFloat(m.focused.outlineWidth) > 0 &&
  opaque(m.focused.outlineColor) &&
  (m.focused.outlineStyle !== m.blurred.outlineStyle ||
    m.focused.outlineWidth !== m.blurred.outlineWidth ||
    m.focused.outlineColor !== m.blurred.outlineColor);

/** Whether the box-shadow, as focused, is drawn and differs from the blurred one. */
const shadowRing = (m: Measured) =>
  shadowDraws(m.focused.boxShadow) && m.focused.boxShadow !== m.blurred.boxShadow;

/** Fails unless focus is on an element showing an indicator present only while focused. */
async function expectFocusVisible(page: Page, where: string): Promise<Measured> {
  const m = await measureFocus(page);
  expect(m, `focus is on an element, not the body (${where})`).not.toBeNull();
  const what = `<${m!.tag}> "${m!.name}" (${where}): ${JSON.stringify(m)}`;
  expect(m!.focusVisible, `matches :focus-visible: ${what}`).toBe(true);
  if (m!.noteId !== null) {
    expect(shadowRing(m!), `a note's focus ring (its box-shadow) shows: ${what}`).toBe(true);
  } else {
    expect(outlineRing(m!) || shadowRing(m!), `a focus-only indicator shows: ${what}`).toBe(true);
  }
  expect(m!.restored, `focus restored, still :focus-visible: ${what}`).toBe(true);
  return m!;
}

/**
 * Presses `key` (Tab, Shift+Tab or an arrow) until the focused element's name matches `name`,
 * checking focus is visible after each press. A Tab past either end of the page leaves focus on
 * the body (the browser's own UI) for a press; that press is skipped, not checked. Fails after
 * `max` presses.
 */
async function moveFocusTo(page: Page, key: string, name: RegExp, max = 40): Promise<void> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(key);
    const onBody = await page.evaluate(
      () => !document.activeElement || document.activeElement === document.body,
    );
    if (onBody && key.endsWith('Tab')) continue;
    const m = await expectFocusVisible(page, `after ${key} #${i + 1}`);
    if (name.test(m.name)) return;
  }
  throw new Error(`${name} not reached within ${max} presses of ${key}`);
}

type StoredNote = { id: string; string: number; fret: number; locked: boolean };
type StoredTab = { notes: StoredNote[] };

const storedNote = async (page: Page, takeId: string, id: string) =>
  (await readTab<StoredTab>(page, takeId))?.notes.find((n) => n.id === id);

/** How many times `fret` stands alone (not part of a longer number) on string `string`'s lines. */
function fretCount(text: string, string: number, fret: number): number {
  const letter = STRING_LETTERS[string - 1]!;
  const token = new RegExp(`(?<![0-9])${fret}(?![0-9])`, 'g');
  return text
    .split('\n')
    .filter((l) => l.startsWith(`${letter}|`))
    .reduce((n, l) => n + (l.slice(2).match(token)?.length ?? 0), 0);
}

for (const theme of THEMES) {
  test(`record, analyse, edit, copy and download with the keyboard only; focus always visible (${theme})`, async ({
    page,
    context,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const hygiene = await watchHygiene(page, baseURL!);
    const errors = collectErrors(page);
    await seedTheme(page, theme);
    await page.goto('./#/record');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Record');
    await expectTheme(page, theme);

    // 1. Tab to Allow microphone; Enter. Focus stays on a visible element as the card goes.
    await moveFocusTo(page, 'Tab', /^Allow microphone$/);
    await page.keyboard.press('Enter');
    await expect(meter(page)).toBeVisible();
    await expectFocusVisible(page, 'after Enter on Allow microphone');

    // 2. Tab to Record; Enter; a ~3 s take; Enter again stops it (the same button, now Stop).
    await moveFocusTo(page, 'Tab', /^Record$/);
    await expect(recordButton(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(timer(page)).toHaveText('0:03', { timeout: 8_000 });
    await expect(stopButton(page)).toBeFocused();
    await expectFocusVisible(page, 'Stop');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/tab\/[^/]+$/, { timeout: 15_000 });
    const takeId = decodeURIComponent(new URL(page.url()).hash.slice('#/tab/'.length));
    // The route change moved focus to the Tab screen's heading, visibly.
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
    await expectFocusVisible(page, 'the Tab screen heading');

    // 3. After analysis, back to the skip link ("Skip to tab"); Enter puts focus on a note.
    await expect(page.getByTestId('tab-status-line')).toBeVisible({ timeout: 20_000 });
    const analysed = await readTab<StoredTab>(page, takeId);
    expect(analysed?.notes.length ?? 0).toBeGreaterThan(1);
    await moveFocusTo(page, 'Shift+Tab', /^Skip to tab$/);
    await page.keyboard.press('Enter');
    await expect.poll(() => focusedNote(page)).not.toBeNull();
    await expectFocusVisible(page, 'the tab area after the skip link');

    // The tab as exported before the edit, for comparison (Ctrl+Shift+C, step 6's key).
    await page.keyboard.press('Control+Shift+C');
    await expect(toast(page)).toHaveText('Tab copied');
    const original = await clipboard(page);

    // 4. → to a note (selected), a digit sets its fret, ↑/↓ moves its string; all stored.
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => selectedNote(page)).not.toBeNull();
    const noteId = (await selectedNote(page))!;
    expect(await focusedNote(page)).toBe(noteId);
    await expectFocusVisible(page, 'the selected note');
    const before = analysed!.notes.find((n) => n.id === noteId)!;
    const fret = before.fret === 5 ? 7 : 5;
    await page.keyboard.press(String(fret));
    await expect.poll(() => storedNote(page, takeId, noteId)).toMatchObject({ fret, locked: true });
    await expect(noteButton(page, noteId)).toHaveAttribute(
      'aria-label',
      new RegExp(`, fret ${fret}, `),
    );
    // ↓ to the next thicker string, or ↑ when the note is already on the low E.
    const move = before.string === 6 ? 'ArrowUp' : 'ArrowDown';
    const movedTo = before.string === 6 ? 5 : before.string + 1;
    await page.keyboard.press(move);
    await expect.poll(async () => (await storedNote(page, takeId, noteId))?.string).toBe(movedTo);
    await expectFocusVisible(page, 'the moved note');

    // 5. Ctrl+Z undoes the move; Ctrl+Shift+Z redoes it.
    await page.keyboard.press('Control+z');
    await expect
      .poll(async () => (await storedNote(page, takeId, noteId))?.string)
      .toBe(before.string);
    await page.keyboard.press('Control+Shift+z');
    await expect.poll(async () => (await storedNote(page, takeId, noteId))?.string).toBe(movedTo);
    await expectFocusVisible(page, 'after undo and redo');
    const edited = (await storedNote(page, takeId, noteId))!;

    // 6. Ctrl+Shift+C copies the tab: the edited note's fret is on its new string's line, and gone
    // from where it was.
    await page.keyboard.press('Control+Shift+C');
    await expect(toast(page)).toHaveText('Tab copied');
    await expect.poll(() => clipboard(page)).not.toBe(original);
    const copied = await clipboard(page);
    expect(copied.startsWith('TabCreator — ')).toBe(true);
    expect(fretCount(copied, edited.string, edited.fret)).toBe(
      fretCount(original, edited.string, edited.fret) + 1,
    );
    expect(fretCount(copied, before.string, before.fret)).toBe(
      fretCount(original, before.string, before.fret) - 1,
    );
    await expectFocusVisible(page, 'after Ctrl+Shift+C');
    expect(await focusedNote(page)).toBe(noteId);

    // 7. Back into the toolbar, Home then → to Download, Enter: the file is the copied tab.
    const toolbar = page.getByRole('toolbar', { name: 'Tab tools' });
    const inToolbar = () => toolbar.evaluate((el) => el.contains(document.activeElement));
    for (let i = 0; i < 40 && !(await inToolbar()); i++) {
      await page.keyboard.press('Shift+Tab');
      await expectFocusVisible(page, `Shift+Tab #${i + 1} towards the toolbar`);
    }
    expect(await inToolbar()).toBe(true);
    await page.keyboard.press('Home');
    await expectFocusVisible(page, 'the first toolbar button');
    await moveFocusTo(page, 'ArrowRight', /^Download$/, 12);
    const [file] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
    expect(file.suggestedFilename()).toMatch(/\.txt$/);
    const text = (await readFile(await file.path(), 'utf8')).replace(/\r\n/g, '\n');
    expect(text).toBe(copied);
    const after = await expectFocusVisible(page, 'after Enter on Download');
    expect(after.name).toBe('Download');

    expect(errors).toEqual([]);
    hygiene.expectClean();
  });
}
