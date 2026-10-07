import { expect, test, type Locator, type Page } from '@playwright/test';
import { strings } from '../../src/ui/strings';
import { recordButton, stopButton, timer } from './helpers';
import { expectNoSeriousAxe, goLive, held, meter } from './mic-helpers';
import { takeCount } from './storage-helpers';
import { makeNotes, noteButton, openSeededTab } from './tab-helpers';

// Story "Shell reflow, focus and shortcuts help" (CAP-21, AD-18; EXPERIENCE.md :89, :126-146,
// :152-162): one test per row of the plan's I/O matrix, in the `dev` project (the fake mic and
// the seeded takes need the dev server).

const NAV_LINKS = ['Record', 'Library', 'Tuner', 'Settings'] as const;
const nav = (page: Page) => page.getByRole('navigation', { name: strings['global.navLabel'] });
const navLink = (page: Page, name: string) => nav(page).getByRole('link', { name, exact: true });
const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
const dialog = (page: Page) => page.getByRole('dialog', { name: strings['global.shortcutsTitle'] });
const closeButton = (page: Page) =>
  dialog(page).getByRole('button', { name: strings['global.close'], exact: true });
const settingsButton = (page: Page) =>
  page.getByRole('button', { name: strings['settings.keyboardShortcuts'], exact: true });

/** Whether the page scrolls sideways. */
const pageScrollsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

/**
 * At 320 px: no sideways scroll, every nav link inside the window, and the wrapped top bar not
 * sticky (several rows tall, it would cover focused content: WCAG 2.4.11).
 */
async function expectReflows(page: Page): Promise<void> {
  await expect(h1(page)).toBeVisible();
  expect(await pageScrollsSideways(page)).toBe(false);
  await expect(page.locator('header')).toHaveCSS('position', 'static');
  for (const name of NAV_LINKS) {
    const link = navLink(page, name);
    await expect(link).toBeInViewport({ ratio: 1 });
  }
}

/** The recording store's state, from the dev server's module instance. */
const recordingState = (page: Page) =>
  page.evaluate(async () => {
    const path = '/src/session/recording-session.ts';
    const { recordingSession } = (await import(
      /* @vite-ignore */ path
    )) as typeof import('../../src/session/recording-session');
    return recordingSession.getSnapshot().recording;
  });

/** Whether focus is inside `locator`. */
const focusInside = (locator: Locator) =>
  locator.evaluate((el) => el.contains(document.activeElement));

test.describe('reflow at 320 px', () => {
  test.use({ viewport: { width: 320, height: 720 } });

  test('Record, Tuner and Settings do not scroll sideways; every nav link is in view', async ({
    page,
  }) => {
    await goLive(page);
    await expectReflows(page);
    await navLink(page, 'Tuner').click();
    await expect(meter(page)).toBeVisible();
    await expectReflows(page);
    await navLink(page, 'Settings').click();
    await expect(h1(page)).toHaveText(strings['settings.title']);
    await expectReflows(page);
    // Scrolled to the bottom, then the h1 focused again: it shows, not covered by the bar.
    // (Blurred first: focusing the element that already has focus would not scroll.)
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await h1(page).focus();
    await expect(h1(page)).toBeFocused();
    // Focus scrolls it just into view, at the top edge (sub-pixel rounding: not quite ratio 1).
    await expect(h1(page)).toBeInViewport({ ratio: 0.9 });
    const covered = await h1(page).evaluate((el) => {
      const box = el.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + 4, box.top + box.height / 2);
      return hit === null || !el.contains(hit);
    });
    expect(covered).toBe(false);
  });

  test('the mic setup card, the Tab screen and the Library do not scroll sideways', async ({
    page,
  }) => {
    await page.goto('./#/record');
    await expect(page.getByRole('button', { name: 'Allow microphone' })).toBeVisible();
    await expectReflows(page);
    await openSeededTab(page, makeNotes(), 'A take with a rather long title that has to wrap');
    await expectReflows(page);
    await navLink(page, 'Library').click();
    await expect(h1(page)).toHaveText(strings['library.title']);
    await expectReflows(page);
  });
});

test('desktop: the top bar stays one sticky row, 56 px tall', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('./#/settings');
  await expect(h1(page)).toBeVisible();
  const box = await page.locator('header').boundingBox();
  expect(Math.round(box!.height)).toBe(57); // 56 px and its 1 px bottom border
  await expect(page.locator('header')).toHaveCSS('position', 'sticky');
});

test('route focus: a nav link focuses the new h1; the same link again keeps focus', async ({
  page,
}) => {
  await page.goto('./#/record');
  await expect(h1(page)).toHaveText('Record');
  await navLink(page, 'Library').click();
  await expect(h1(page)).toHaveText(strings['library.title']);
  await expect(h1(page)).toBeFocused();
  await navLink(page, 'Record').click();
  await expect(h1(page)).toHaveText('Record');
  await expect(h1(page)).toBeFocused();
  await navLink(page, 'Record').click();
  await expect(navLink(page, 'Record')).toBeFocused();
});

test('route focus: a route change scrolls the new screen to the top', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 400 });
  await page.goto('./#/settings');
  await expect(h1(page)).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await navLink(page, 'Library').click();
  await expect(h1(page)).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('route focus: a Library row opens the Tab with its h1 focused', async ({ page }) => {
  const id = await openSeededTab(page, makeNotes(), 'Row take');
  await navLink(page, 'Library').click();
  await expect(h1(page)).toHaveText(strings['library.title']);
  await page.locator(`li[data-take-id="${id}"]`).getByRole('link').click();
  await expect(h1(page)).toHaveText('Row take');
  await expect(h1(page)).toBeFocused();
});

test('route focus: Stop opens the Tab with its h1 focused', async ({ page }) => {
  await goLive(page, held());
  await recordButton(page).click();
  await expect(timer(page)).toHaveText('0:01', { timeout: 5_000 });
  await stopButton(page).click();
  await expect(page).toHaveURL(/#\/tab\//);
  await expect(h1(page)).toBeFocused();
});

test('back with the dialog open: the dialog closes and the new h1 has focus', async ({ page }) => {
  await page.goto('./#/record');
  await navLink(page, 'Settings').click();
  await expect(h1(page)).toHaveText(strings['settings.title']);
  await page.keyboard.press('?');
  await expect(dialog(page)).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/#\/record$/);
  await expect(dialog(page)).toHaveCount(0);
  await expect(h1(page)).toHaveText('Record');
  await expect(h1(page)).toBeFocused();
});

test('`?` on a Tab note opens the dialog, Close focused, Tab trapped; Esc returns to the note', async ({
  page,
}) => {
  const notes = makeNotes();
  await openSeededTab(page, notes);
  const id = notes[3]!.id;
  await noteButton(page, id).click();
  await expect(noteButton(page, id)).toBeFocused();
  await page.keyboard.press('?');
  await expect(dialog(page)).toBeVisible();
  await expect(closeButton(page)).toBeFocused();
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    expect(await focusInside(dialog(page))).toBe(true);
  }
  await page.keyboard.press('Shift+Tab');
  expect(await focusInside(dialog(page))).toBe(true);
  // `?` again does nothing while it is open: no second dialog.
  await page.keyboard.press('?');
  await expect(dialog(page)).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(noteButton(page, id)).toBeFocused();
  // Esc went to the dialog, not to the selection.
  await expect(noteButton(page, id)).toHaveAttribute('aria-pressed', 'true');
});

test('`?` typed in the Library search is text, not the dialog', async ({ page }) => {
  await openSeededTab(page);
  await navLink(page, 'Library').click();
  const search = page.getByRole('searchbox', { name: strings['library.search'] });
  await search.click();
  await page.keyboard.press('?');
  await expect(search).toHaveValue('?');
  await expect(dialog(page)).toHaveCount(0);
});

test("Settings' Keyboard shortcuts button opens the dialog; Close and Esc return to it", async ({
  page,
}) => {
  await page.goto('./#/settings');
  await expect(settingsButton(page)).toHaveAttribute('aria-haspopup', 'dialog');
  await settingsButton(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(closeButton(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(settingsButton(page)).toBeFocused();
  await settingsButton(page).click();
  await closeButton(page).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(settingsButton(page)).toBeFocused();
});

test('the dialog lists every shortcut once, grouped by where it works', async ({ page }) => {
  await page.goto('./#/settings');
  await settingsButton(page).click();
  const captions = await dialog(page).locator('caption').allTextContents();
  expect(captions).toEqual(['Global', 'Record', 'Tab', 'Trim handle']);
  const descriptions = await dialog(page).locator('td').allTextContents();
  expect(new Set(descriptions).size).toBe(descriptions.length);
  for (const text of [
    strings['global.shortcutHelp'],
    strings['global.shortcutCancelCountIn'],
    strings['global.shortcutCloseOverlay'],
    strings['record.shortcutRecordStop'],
    strings['tab.shortcutPlayPause'],
    strings['tab.shortcutSetFret'],
    strings['tab.shortcutRedo'],
    strings['tab.shortcutCopy'],
    strings['tab.shortcutTrimNudge'],
    strings['tab.shortcutTrimNudgeBig'],
  ]) {
    expect(descriptions).toContain(text);
  }
  const row = (description: string) =>
    dialog(page)
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: description }) });
  await expect(row(strings['tab.shortcutSetFret']).locator('kbd')).toHaveText(['0–9']);
  await expect(row(strings['tab.shortcutDelete']).locator('kbd')).toHaveText([
    'Delete',
    'Backspace',
  ]);
  await expect(row(strings['tab.shortcutRedo']).locator('kbd')).toHaveText([
    'Ctrl+Shift+Z',
    'Ctrl+Y',
  ]);
  await expect(dialog(page)).toContainText(strings['global.shortcutsNote']);
});

test('Esc cancels a count-in from a Settings field and from the disabled tempo field', async ({
  page,
}) => {
  await goLive(page);
  const countIn = page.getByRole('button', { name: 'Count-in', exact: true });
  const tempo = page.getByRole('spinbutton', { name: 'Tempo' });
  await countIn.click();
  await tempo.fill('40');
  await tempo.press('Enter');
  await expect(tempo).toHaveValue('40');

  // From a Settings Defaults field (the count-in keeps running off Record; 4 beats at 40 BPM
  // last 6 s, and the take is only created when they end).
  await recordButton(page).click();
  await expect(page.getByRole('button', { name: 'Cancel count-in' })).toBeVisible();
  await navLink(page, 'Settings').click();
  expect(await recordingState(page)).toBe('count-in');
  const field = page.getByRole('spinbutton', { name: strings['global.minNoteLength'] });
  await field.focus();
  await page.keyboard.press('Escape');
  expect(await recordingState(page)).toBe('idle');
  await expect(field).toBeFocused();
  expect(await takeCount(page)).toBe(0);

  // With focus left behind by the tempo field: the count-in disables the field, and Chrome moves
  // focus off a disabled control to <body>. This proves Esc cancels with focus where the field
  // left it; the Settings half above proves it fires from inside an enabled field.
  await navLink(page, 'Record').click();
  await tempo.focus();
  await recordButton(page).evaluate((b: HTMLElement) => b.click());
  await expect(page.getByRole('button', { name: 'Cancel count-in' })).toBeVisible();
  await expect(tempo).toBeDisabled();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await page.keyboard.press('Escape');
  expect(await recordingState(page)).toBe('idle');
  await expect(recordButton(page)).toHaveAttribute('aria-pressed', 'false');
  expect(await takeCount(page)).toBe(0);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`axe: the dialog open in ${scheme} has no serious or critical violations`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('./#/settings');
    await settingsButton(page).click();
    await expect(dialog(page)).toBeVisible();
    await expectNoSeriousAxe(page);
  });
}
