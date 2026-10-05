import { expect, test, type Page } from '@playwright/test';
import { collectErrors, recordButton, stopButton, timer } from './helpers';
import { FIXTURE, expectNoSeriousAxe, goLive } from './mic-helpers';
import {
  focusedNote,
  makeNotes,
  noteButton,
  openSeededTab,
  selectedNote,
  tabArea,
} from './tab-helpers';

// Story "Flags, warnings and bar lines on screen": the status line and Next to check, flagged
// notes, the warning banners, the "Maximum length reached" toast and the Bar lines toggle, one
// test per row of the plan's I/O matrix, in the `dev` project (the fake mic and the seeding
// import of the dev server's storage module).

const statusCounts = (page: Page) => page.getByTestId('tab-status-line').locator('p');
const nextToCheck = (page: Page) => page.getByRole('button', { name: 'Next to check' });
const barLines = (page: Page) => page.getByRole('button', { name: 'Bar lines' });
const toast = (page: Page) => page.getByTestId('toast');
const warning = (page: Page, kind: 'tuning' | 'drop' | 'uncertain' | 'clipped') =>
  page.getByTestId(`tab-warning-${kind}`);
const anyWarning = (page: Page) => page.locator('[data-testid^="tab-warning-"]');

/** 40 notes, three flagged (indexes 5, 17 and 30, in played order). */
const FLAGGED = [5, 17, 30];
const flaggedId = (i: number) => `note-${String(i).padStart(2, '0')}`;

/** Records about 3 s from the live fake mic and stops; returns the take id once its Tab opens. */
async function recordTake(page: Page): Promise<string> {
  await recordButton(page).click();
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(timer(page)).toHaveText('0:03', { timeout: 6_000 });
  await stopButton(page).click();
  await expect(page).toHaveURL(/#\/tab\/[^/]+$/, { timeout: 15_000 });
  return decodeURIComponent(new URL(page.url()).hash.slice('#/tab/'.length));
}

/** Records a take (`recordTake`) and waits for its analysed tab. Returns the take id. */
async function recordAndAnalyse(page: Page): Promise<string> {
  const id = await recordTake(page);
  await expect(page.getByTestId('tab-status-line')).toBeVisible({ timeout: 20_000 });
  return id;
}

/** Resolves after two animation frames: the screen has rendered and run its effects. */
function frames(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

/** The number of lines in the tab that carry a bar line (a `|` besides the prefix and end). */
function barredLines(page: Page): Promise<number> {
  return tabArea(page)
    .locator('pre')
    .evaluateAll(
      (pres) =>
        pres
          .flatMap((p) => (p.textContent ?? '').split('\n'))
          .filter((l) => l.split('|').length - 1 > 2).length,
    );
}

test('tuning: a take recorded 45 cents flat shows the tuning banner with Open tuner', async ({
  page,
}) => {
  const errors = await goLive(page, 'detuned_-45c');
  await recordAndAnalyse(page);
  // The engine's offset estimate from a short take lands within a few cents of the fixture's
  // −45 (43 in practice); the wording and direction are what this story renders.
  await expect(warning(page, 'tuning')).toContainText(
    /^Your guitar seems about 4[2-8] cents flat — tune up and record again for accurate tab/,
  );
  const link = warning(page, 'tuning').getByRole('link', { name: 'Open tuner' });
  await expect(link).toHaveAttribute('href', '#/tuner');
  await expect(warning(page, 'drop')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('drop: a take in drop D shows the drop-tuning banner', async ({ page }) => {
  const errors = await goLive(page, 'drop_d');
  await recordAndAnalyse(page);
  await expect(warning(page, 'drop')).toContainText('Looks like drop tuning — not supported in v1');
  expect(errors).toEqual([]);
});

test('clean: an in-tune take in standard tuning shows neither banner', async ({ page }) => {
  const errors = await goLive(page, FIXTURE);
  await recordAndAnalyse(page);
  await expect(warning(page, 'tuning')).toHaveCount(0);
  await expect(warning(page, 'drop')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('status: "40 notes · 3 to check" under the toolbar, the count in the warning colour', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openSeededTab(page, makeNotes(40, FLAGGED));
  await expect(statusCounts(page)).toHaveText('40 notes · 3 to check');
  const colours = await statusCounts(page).evaluate((p) => ({
    line: getComputedStyle(p).color,
    check: getComputedStyle(p.querySelector('span')!).color,
  }));
  expect(colours.line).toBe('rgb(94, 90, 84)'); // text-muted
  expect(colours.check).toBe('rgb(138, 90, 0)'); // warning
  await expect(nextToCheck(page)).toBeEnabled();
  expect(errors).toEqual([]);
});

test('N cycle: N four times visits the flagged notes in time order, wrapping to the first', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openSeededTab(page, makeNotes(40, FLAGGED));
  const seen: (string | null)[] = [];
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('n');
    seen.push(await selectedNote(page));
    expect(await focusedNote(page)).toBe(seen.at(-1));
  }
  const ids = FLAGGED.map(flaggedId);
  expect(seen).toEqual([...ids, ids[0]]);
  // The button does the same, from the selection.
  await nextToCheck(page).click();
  expect(await selectedNote(page)).toBe(ids[1]);
  expect(await focusedNote(page)).toBe(ids[1]);
  expect(errors).toEqual([]);
});

test('N none: with nothing flagged Next to check is disabled with its reason; N does nothing', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openSeededTab(page, makeNotes(40));
  await expect(statusCounts(page)).toHaveText('40 notes · 0 to check');
  await expect(nextToCheck(page)).toBeDisabled();
  await expect(nextToCheck(page)).toHaveAccessibleDescription('No notes to check');
  await expect(nextToCheck(page).locator('..')).toHaveAttribute('title', 'No notes to check');
  await page.keyboard.press('n');
  expect(await selectedNote(page)).toBeNull();
  expect(errors).toEqual([]);
});

test('flag label: a flagged note ends ", check this note", with the check fill and dotted underline', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openSeededTab(page, makeNotes(40, FLAGGED));
  const flagged = noteButton(page, flaggedId(5));
  await expect(flagged).toHaveAccessibleName(/^Note 6: .*, check this note$/);
  await expect(noteButton(page, flaggedId(6))).not.toHaveAccessibleName(/check this note/);
  const style = await flagged.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      background: s.backgroundColor,
      underline: `${s.borderBottomWidth} ${s.borderBottomStyle} ${s.borderBottomColor}`,
    };
  });
  expect(style).toEqual({
    background: 'rgb(252, 232, 178)',
    underline: '2px dotted rgb(138, 90, 0)',
  });
  // Selected, it keeps the fill and shows the selection outline too.
  await flagged.click();
  await expect(flagged).toHaveAttribute('aria-pressed', 'true');
  const selected = await flagged.evaluate((el) => {
    const s = getComputedStyle(el);
    return { background: s.backgroundColor, outline: `${s.outlineWidth} ${s.outlineStyle}` };
  });
  expect(selected).toEqual({ background: 'rgb(252, 232, 178)', outline: '2px solid' });
  // The digits still show through: the lines sit above the fill (hit-testing them, which their
  // pointer-events: none otherwise skips, finds the <pre> over the button).
  const onTop = await flagged.evaluate((el) => {
    const pre = el.parentElement!.querySelector('pre')!;
    const box = el.getBoundingClientRect();
    pre.style.pointerEvents = 'auto';
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    pre.style.pointerEvents = '';
    return top?.tagName;
  });
  expect(onTop).toBe('PRE');
  expect(errors).toEqual([]);
});

test('clipped: a take recorded too hot shows the clipping banner, with no Dismiss', async ({
  page,
}) => {
  // level_too_hot clips through the fake mic, so the take is saved with clipped: true.
  const errors = await goLive(page, 'level_too_hot');
  await recordTake(page);
  await expect(warning(page, 'clipped')).toContainText(
    'This take clipped — move back or lower the input and record again',
  );
  await expect(warning(page, 'clipped').getByRole('button')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('max length: the toast after the auto-stop; not after reopening the analysed take', async ({
  page,
}) => {
  const errors = await goLive(page, `${FIXTURE}&maxTakeMs=3000`);
  await recordButton(page).click();
  // No Stop: the take stops itself at 0:03 and opens its Tab.
  await expect(page).toHaveURL(/#\/tab\/[^/]+$/, { timeout: 10_000 });
  const id = decodeURIComponent(new URL(page.url()).hash.slice('#/tab/'.length));
  await expect(toast(page)).toHaveText('Maximum length reached');
  await expect(page.getByTestId('tab-status-line')).toBeVisible({ timeout: 20_000 });

  await page.getByRole('link', { name: 'Library' }).click();
  await expect(toast(page)).toHaveCount(0, { timeout: 6_000 });
  await page.goto(`./#/tab/${encodeURIComponent(id)}`);
  await expect(page.getByTestId('tab-status-line')).toBeVisible();
  await frames(page);
  await expect(toast(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('all uncertain: every note flagged shows the all-uncertain banner, with no Dismiss', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const all = Array.from({ length: 12 }, (_, i) => i);
  await openSeededTab(page, makeNotes(12, all));
  await expect(warning(page, 'uncertain')).toContainText(
    'Every note is uncertain — check the input level and room noise, then re-analyse',
  );
  await expect(warning(page, 'uncertain').getByRole('button')).toHaveCount(0);
  await expect(statusCounts(page)).toHaveText('12 notes · 12 to check');
  expect(errors).toEqual([]);
});

test('dismiss: a dismissed tuning banner is back when the take is reopened', async ({ page }) => {
  const errors = collectErrors(page);
  const id = await openSeededTab(page, makeNotes(40), 'Flat take', {
    warnings: { tuningOffsetCents: -45, belowRangeNotes: 0 },
  });
  await expect(warning(page, 'tuning')).toContainText('about 45 cents flat');
  await page.getByRole('button', { name: 'Dismiss tuning warning' }).click();
  await expect(warning(page, 'tuning')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();

  await page.getByRole('link', { name: 'Library' }).click();
  await expect(page).toHaveURL(/#\/library$/);
  await page.goto(`./#/tab/${encodeURIComponent(id)}`);
  await expect(warning(page, 'tuning')).toContainText('about 45 cents flat');
  expect(errors).toEqual([]);
});

test('bar lines: shown with a count-in; off hides them, a reload keeps it off, on restores', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1200, height: 800 });
  await openSeededTab(page, makeNotes(40), 'Count-in take', { countInBpm: 120 });
  await expect(barLines(page)).toHaveAttribute('aria-pressed', 'true');
  expect(await barredLines(page)).toBeGreaterThan(0);

  await barLines(page).click();
  await expect(barLines(page)).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => barredLines(page)).toBe(0);

  await page.reload();
  await expect(barLines(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(tabArea(page).locator('pre').first()).toBeVisible();
  expect(await barredLines(page)).toBe(0);

  await barLines(page).click();
  await expect(barLines(page)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => barredLines(page)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('no count-in: a take without a count-in tempo has no Bar lines button', async ({ page }) => {
  const errors = collectErrors(page);
  await openSeededTab(page, makeNotes(40));
  await expect(page.getByRole('toolbar', { name: 'Tab tools' })).toHaveCount(1);
  await expect(barLines(page)).toHaveCount(0);
  expect(await barredLines(page)).toBe(0);
  expect(errors).toEqual([]);
});

test('axe: no serious or critical violations on a tab with flags and every banner, light and dark', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openSeededTab(page, makeNotes(40, FLAGGED), 'Flagged take', {
    clipped: true,
    countInBpm: 120,
    warnings: { tuningOffsetCents: 48, belowRangeNotes: 3 },
  });
  await expect(anyWarning(page)).toHaveCount(3);
  await noteButton(page, flaggedId(5)).click();
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await expectNoSeriousAxe(page);
  }
  expect(errors).toEqual([]);
});
