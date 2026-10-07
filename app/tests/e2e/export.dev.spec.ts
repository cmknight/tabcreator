import { expect, test, type Page } from '@playwright/test';
import { clipboard, copy, download, toast, toolButton } from './export-helpers';
import { collectErrors, recordButton, stopButton, timer } from './helpers';
import { FIXTURE, goLive } from './mic-helpers';
import { makeNotes, openSeededTab, seedTab } from './tab-helpers';

// Story "Copy and Download on the Tab screen" (CAP-18): the toolbar's Copy and Download, and
// Ctrl+Shift+C, in the `dev` project (the fake mic and the seeding import of the storage module).

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
});

/** The export's tab systems (after the 4-line header), each as its lines. */
function systems(text: string): string[][] {
  return text
    .replace(/\n$/, '')
    .split('\n')
    .slice(4)
    .join('\n')
    .split('\n\n')
    .map((s) => s.split('\n'));
}

/** Whether any tab line has a bar line inside it (the closing `|` and `x|` openers aside). */
function hasBarLines(text: string): boolean {
  return systems(text).some((lines) => lines.some((l) => l.slice(2, -1).includes('|')));
}

/** Records about 2 s of the fake mic and waits for its analysed tab. */
async function recordAndAnalyse(page: Page): Promise<void> {
  await recordButton(page).click();
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(timer(page)).toHaveText('0:02', { timeout: 5_000 });
  await stopButton(page).click();
  await expect(page).toHaveURL(/#\/tab\/[^/]+$/, { timeout: 15_000 });
  await expect(page.getByTestId('tab-status-line')).toBeVisible({ timeout: 20_000 });
}

test('a recorded take: Copy then Download give the same text, its systems aligned', async ({
  page,
}) => {
  const errors = await goLive(page, FIXTURE);
  await recordAndAnalyse(page);

  const copied = await copy(page);
  const { name, text } = await download(page);
  expect(name).toMatch(/\.txt$/);
  expect(text).toBe(copied); // but for the line endings, checked in `download`
  expect(text.startsWith('TabCreator — ')).toBe(true);
  const tab = systems(text);
  expect(tab.length).toBeGreaterThan(0);
  for (const lines of tab) {
    expect(lines).toHaveLength(6);
    for (const line of lines) expect(line.length).toBe(lines[0]!.length);
  }
  expect(errors).toEqual([]);
});

test('Download names the file from the title: "Blues / Riff 🎸 in A♯" → blues-riff-in-a.txt', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openSeededTab(page, makeNotes(20), 'Seeded take');
  await page.getByRole('button', { name: 'Rename take' }).click();
  const field = page.getByRole('textbox', { name: 'Take title' });
  await field.fill('Blues / Riff 🎸 in A♯');
  await field.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Blues / Riff 🎸 in A♯');
  const { name, text } = await download(page);
  expect(name).toBe('blues-riff-in-a.txt');
  expect(text.split('\n')[0]).toBe('TabCreator — Blues / Riff 🎸 in A♯');
  expect(errors).toEqual([]);
});

test('Ctrl+Shift+C copies the tab and toasts "Tab copied"; not from the title field', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openSeededTab(page, makeNotes(20), 'Shortcut take');
  await page.evaluate(() => navigator.clipboard.writeText('before'));

  // From the title field the keys stay the field's.
  await page.getByRole('button', { name: 'Rename take' }).click();
  const field = page.getByRole('textbox', { name: 'Take title' });
  await field.press('Control+Shift+C');
  expect(await clipboard(page)).toBe('before');
  await field.press('Escape');

  await page.getByRole('heading', { level: 1 }).focus();
  await page.keyboard.press('Control+Shift+C');
  await expect(toast(page)).toHaveText('Tab copied');
  const copied = await clipboard(page);
  expect(copied.split('\n')[0]).toBe('TabCreator — Shortcut take');
  expect(copied).toBe((await download(page)).text);
  expect(errors).toEqual([]);
});

test('a count-in take with Bar lines off: neither export has bar lines', async ({ page }) => {
  const errors = collectErrors(page);
  await openSeededTab(page, makeNotes(40), 'Count-in take', { countInBpm: 120 });
  const barLines = toolButton(page, 'Bar lines');
  await expect(barLines).toHaveAttribute('aria-pressed', 'true');
  const withBars = await copy(page);
  expect(hasBarLines(withBars)).toBe(true);

  await barLines.click();
  await expect(barLines).toHaveAttribute('aria-pressed', 'false');
  const copied = await copy(page);
  const { text } = await download(page);
  expect(hasBarLines(copied)).toBe(false);
  expect(hasBarLines(text)).toBe(false);
  expect(text).toBe(copied);

  // Ctrl+Shift+C, focus off any text field, copies the same text.
  await page.evaluate(() => navigator.clipboard.writeText('before'));
  await page.getByRole('heading', { level: 1 }).focus();
  await page.keyboard.press('Control+Shift+C');
  await expect.poll(() => clipboard(page)).not.toBe('before');
  const shortcut = await clipboard(page);
  expect(hasBarLines(shortcut)).toBe(false);
  expect(shortcut).toBe(copied);
  expect(errors).toEqual([]);
});

test('No notes found: Copy and Download are disabled with their reasons', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('./#/library');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  // Every note hidden by the trim: the tab shows No notes found.
  const id = await seedTab(page, makeNotes(20), 'Trimmed take', { trimStartMs: 12_000 });
  await page.goto(`./#/tab/${encodeURIComponent(id)}`);
  await expect(page.getByTestId('tab-no-notes')).toBeVisible();
  await expect(toolButton(page, 'Copy')).toBeDisabled();
  await expect(toolButton(page, 'Download')).toBeDisabled();
  await expect(toolButton(page, 'Copy').locator('..')).toHaveAttribute('title', 'No notes to copy');
  await expect(toolButton(page, 'Download').locator('..')).toHaveAttribute(
    'title',
    'No notes to download',
  );
  expect(errors).toEqual([]);
});
