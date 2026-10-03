import { expect, test, type Page } from '@playwright/test';
import { countGetUserMedia, expectNoSeriousAxe, gumCalls } from './mic-helpers';

// Runs in the `dev` project only: the fake mic (US-0.4) plays open_strings as the microphone,
// six plucks low E → high E, each 900 ms, 1 s apart, from when the stream opens.

const SETUP_TITLE = 'TabCreator needs your microphone';
/**
 * In tune needs 500 ms of readings. The page timestamps DOM changes, which trail the polls by a
 * render each, so allow some jitter between the two ends.
 */
const IN_TUNE_MS = 500;
const JITTER_MS = 40;

const CHIP_NAMES = ['Low E', 'A', 'D', 'G', 'B', 'High E'];

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

const setupCard = (page: Page) => page.getByRole('region', { name: SETUP_TITLE });
const meter = (page: Page) => page.getByRole('meter', { name: 'Input level' });
const needle = (page: Page) => page.getByRole('img', { name: /^Tuning needle/ });
const h1 = (page: Page) => page.getByRole('heading', { level: 1 });

interface Entry {
  t: number;
  string: string | null;
  cents: number | null;
  inTune: boolean;
}

declare global {
  interface Window {
    __tunerLog?: Entry[];
    __politeLog?: string[];
  }
}

/**
 * Logs every change of the tuner readout with a page timestamp, and every text the shared
 * polite live region receives (a MutationObserver).
 */
async function watchReadout(page: Page): Promise<void> {
  await page.evaluate(() => {
    const log: Entry[] = [];
    window.__tunerLog = log;
    const polite: string[] = [];
    window.__politeLog = polite;
    const record = () => {
      const said = document.querySelector('[aria-live="polite"]')?.textContent ?? '';
      if (said && polite[polite.length - 1] !== said) polite.push(said);
      const readout = document.querySelector<HTMLElement>('[data-testid="tuner-readout"]');
      if (!readout) return;
      const entry = {
        t: performance.now(),
        string: readout.dataset.string ?? null,
        cents: readout.dataset.cents === undefined ? null : Number(readout.dataset.cents),
        inTune: readout.querySelector('[data-testid="tuner-in-tune"]') !== null,
      };
      const last = log[log.length - 1];
      if (
        last &&
        last.string === entry.string &&
        last.cents === entry.cents &&
        last.inTune === entry.inTune
      )
        return;
      log.push(entry);
    };
    new MutationObserver(record).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  });
}

test('open_strings on the Tuner ticks all six chips, In tune only after 500 ms in range', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await countGetUserMedia(page);

  // First visit: the setup card replaces the tuner, and nothing is requested before Allow.
  await page.goto('./?fakeMic=open_strings#/tuner');
  await expect(h1(page)).toHaveText('Tuner');
  await expect(setupCard(page)).toBeVisible();
  await expect(needle(page)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Done — go to Record' })).toHaveCount(0);
  await page.waitForTimeout(200);
  expect(await gumCalls(page)).toBe(0);
  await expectNoSeriousAxe(page);

  await watchReadout(page);
  await page.getByRole('button', { name: 'Allow microphone' }).click();
  await expect(needle(page)).toBeVisible();
  await expect(meter(page)).toBeVisible();
  expect(await gumCalls(page)).toBe(1);
  for (const name of CHIP_NAMES) {
    await expect(page.getByRole('listitem', { name: `${name} string, not yet tuned` })).toHaveCount(
      1,
    );
  }
  // Axe while live runs in the Tune first test: here it would delay renders during the plucks.

  // All six tick as the plucks play (about 6.2 s of audio).
  for (const name of CHIP_NAMES) {
    await expect(page.getByRole('listitem', { name: `${name} string, in tune` })).toHaveCount(1, {
      timeout: 15_000,
    });
  }
  await expect(
    page.getByTestId('tuner-panel').getByText('All six strings in tune', { exact: true }),
  ).toBeVisible();
  // Announced politely through the shared region: each string as it enters In tune, then all six
  // (queued after the sixth string's own announcement, in the same poll).
  const politeLog = () => page.evaluate(() => window.__politeLog ?? []);
  await expect.poll(politeLog).toContain('All six strings in tune');
  const said = await politeLog();
  const allSix = said.indexOf('All six strings in tune');
  for (const name of CHIP_NAMES) {
    expect(said).toContain(`${name} string in tune`);
    expect(said.indexOf(`${name} string in tune`)).toBeLessThan(allSix);
  }
  // Then the input goes silent: after 3 s the no-pitch state, ticks kept.
  await expect(page.getByText('Play a single open string')).toBeVisible({ timeout: 10_000 });
  await expect(needle(page)).toHaveAccessibleName(
    'Tuning needle, −50 to +50 cents: No pitch detected',
  );
  await expect(page.getByTestId('tuner-needle-mark')).toHaveCount(0);
  await expect(page.locator('li[data-ticked]')).toHaveCount(6);
  await expectNoSeriousAxe(page);

  // In tune appeared only after 500 ms of in-range readings on the same string.
  const log = await page.evaluate(() => window.__tunerLog ?? []);
  const shown = new Set<string>();
  for (let i = 0; i < log.length; i++) {
    const entry = log[i]!;
    if (!entry.inTune || log[i - 1]?.inTune) continue;
    // The run of in-range readings on this string leading up to it.
    let start = i;
    while (start > 0) {
      const prev = log[start - 1]!;
      if (prev.string !== entry.string || prev.cents === null || Math.abs(prev.cents) > 3.05) break;
      start--;
    }
    expect(entry.t - log[start]!.t, `In tune on string ${entry.string}`).toBeGreaterThanOrEqual(
      IN_TUNE_MS - JITTER_MS,
    );
    shown.add(entry.string!);
  }
  expect([...shown].sort()).toEqual(['1', '2', '3', '4', '5', '6']);

  expect(errors).toEqual([]);
});

test('a denied request shows the denied card on the Tuner; Try again recovers', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('./?fakeMic=open_strings#/tuner');
  await expect(setupCard(page)).toBeVisible();
  await page.evaluate(() => window.__fakeMic!.failNext('NotAllowedError'));
  await page.getByRole('button', { name: 'Allow microphone' }).click();
  const card = page.getByRole('region', { name: 'Microphone access is blocked' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading', { name: 'Microphone access is blocked' })).toBeFocused();
  await expectNoSeriousAxe(page);
  await card.getByRole('button', { name: 'Try again' }).click();
  await expect(needle(page)).toBeVisible();
  await expect(card).toHaveCount(0);
  // Focus followed the swap to the tuner panel, the first thing below the h1.
  await expect(page.getByTestId('tuner-panel')).toBeFocused();
  expect(errors).toEqual([]);
});

test('Tune first opens the Tuner; Done — go to Record returns with the mic still live', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await countGetUserMedia(page);
  await page.goto('./?fakeMic=open_strings#/record');
  await page.getByRole('button', { name: 'Allow microphone' }).click();
  await expect(meter(page)).toBeVisible();

  const tuneFirst = page.getByRole('link', { name: 'Tune first' });
  await expect(tuneFirst).toHaveAttribute('href', '#/tuner');
  await tuneFirst.click();
  await expect(page).toHaveURL(/#\/tuner$/);
  await expect(h1(page)).toHaveText('Tuner');
  await expect(needle(page)).toBeVisible();
  // Axe on the live Tuner, while the fixture plays.
  await expectNoSeriousAxe(page);

  const done = page.getByRole('link', { name: 'Done — go to Record' });
  await expect(done).toHaveAttribute('href', '#/record');
  await done.click();
  await expect(page).toHaveURL(/#\/record$/);
  await expect(h1(page)).toHaveText('Record');
  await expect(meter(page)).toBeVisible();
  await expect(setupCard(page)).toHaveCount(0);
  expect(await gumCalls(page)).toBe(1);
  expect(errors).toEqual([]);
});

test('dark mode: the live Tuner, with a reading and a ticked chip, passes axe', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  const errors = collectErrors(page);
  await page.goto('./?fakeMic=open_strings#/tuner');
  await page.getByRole('button', { name: 'Allow microphone' }).click();
  await expect(needle(page)).toBeVisible();
  // The dark tokens are in force, so axe's contrast check sees the dark colours.
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(
    'dark',
  );
  await expect(page.locator('li[data-ticked]').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('tuner-needle-mark')).toBeVisible();
  await expectNoSeriousAxe(page);
  expect(errors).toEqual([]);
});

test('ticks are kept when leaving the Tuner and coming back', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('./?fakeMic=open_strings#/tuner');
  await page.getByRole('button', { name: 'Allow microphone' }).click();
  const ticked = page.locator('li[data-ticked]');
  await expect(ticked.first()).toBeVisible({ timeout: 10_000 });
  const names = await ticked.evaluateAll((items) => items.map((li) => li.ariaLabel));
  const nav = page.getByRole('navigation');
  await nav.getByRole('link', { name: 'Library' }).click();
  await expect(h1(page)).toHaveText('Library');
  await nav.getByRole('link', { name: 'Tuner' }).click();
  // At once on return, before any re-tick could happen (In tune needs 500 ms of new readings).
  await expect(needle(page)).toBeVisible({ timeout: 300 });
  // A subset: another string may tick between capturing the set and leaving.
  const back = await ticked.evaluateAll((items) => items.map((li) => li.ariaLabel));
  expect(back).toEqual(expect.arrayContaining(names));
  expect(errors).toEqual([]);
});

test('leaving right after the sixth tick still announces All six strings in tune', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('./?fakeMic=open_strings#/tuner');
  await expect(setupCard(page)).toBeVisible();
  await watchReadout(page);
  await page.getByRole('button', { name: 'Allow microphone' }).click();
  await expect(page.locator('li[data-ticked]')).toHaveCount(6, { timeout: 15_000 });
  // At once: the sixth string's own announcement is still being held in the polite region.
  await page.getByRole('navigation').getByRole('link', { name: 'Library' }).click();
  await expect(h1(page)).toHaveText('Library');
  const politeLog = () => page.evaluate(() => window.__politeLog ?? []);
  await expect.poll(politeLog).toContain('All six strings in tune');
  const said = await politeLog();
  expect(said.indexOf('All six strings in tune')).toBeGreaterThan(
    said.indexOf('High E string in tune'),
  );
  expect(errors).toEqual([]);
});
