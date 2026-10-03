import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousAxe, goLive, meter } from './mic-helpers';

// Runs in the `dev` project only: the fake mic (US-0.4) plays a fixture as the microphone.
// Fixtures: level_too_hot clips from 300 ms (5.55 s long), silence_60s, open_strings (6.7 s,
// no clipping, never quiet for 3 s).

const TOO_LOUD = 'Too loud — move back or lower the input';
const TOO_QUIET = 'Too quiet — move closer to the guitar';

interface Probe {
  /** `performance.now()` when the meter first appeared. */
  meterAt: number | null;
  /** Every change of the warning line's text, with its time. */
  warnings: { text: string; at: number }[];
  /** Every non-empty text the polite live region took. */
  polite: string[];
}

/** Watches the meter, its warning line and the polite live region from page start. */
async function probe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const p: Probe = { meterAt: null, warnings: [], polite: [] };
    (window as unknown as { __probe: Probe }).__probe = p;
    // null while no warning line is mounted, so a remounted line's first text is recorded.
    let warning: string | null = null;
    let polite = '';
    new MutationObserver(() => {
      const now = performance.now();
      if (p.meterAt === null && document.querySelector('[role="meter"]')) p.meterAt = now;
      const line = document.querySelector('[data-testid="input-level-warning"]');
      const text = line ? (line.textContent ?? '') : null;
      if (text !== warning) {
        warning = text;
        if (text !== null) p.warnings.push({ text, at: now });
      }
      const region = document.querySelector('[aria-live="polite"]')?.textContent ?? '';
      if (region !== polite) {
        polite = region;
        if (region !== '') p.polite.push(region);
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
}

const read = (page: Page) => page.evaluate(() => (window as unknown as { __probe: Probe }).__probe);

/** The fill's visible width and the peak tick's position (%), and whether the tick shows. */
const bar = (page: Page) =>
  page.evaluate(() => {
    const fill = document.querySelector<HTMLElement>('[data-testid="input-level-fill"]')!;
    const peak = document.querySelector<HTMLElement>('[data-testid="input-level-peak"]')!;
    const right = /^inset\(0(?:px)? ([\d.]+)% 0(?:px)? 0(?:px)?\)$/.exec(fill.style.clipPath);
    return {
      clipPath: fill.style.clipPath,
      fillPercent: right ? 100 - Number(right[1]) : NaN,
      peakPercent: parseFloat(peak.style.left),
      peakVisible: peak.style.visibility === 'visible',
    };
  });
const warningLine = (page: Page) => page.getByTestId('input-level-warning');

/** Record live on `fixture`, probed from page start. */
async function goLiveProbed(page: Page, fixture: string): Promise<string[]> {
  await probe(page);
  return goLive(page, fixture);
}

/** The first time the warning line read `text`, relative to the meter appearing (ms). */
async function warningAfterMeter(page: Page, text: string): Promise<number | null> {
  const p = await read(page);
  const hit = p.warnings.find((w) => w.text === text);
  return hit && p.meterAt !== null ? hit.at - p.meterAt : null;
}

test('level_too_hot shows Too loud within 200 ms of the first clipped frame, announced once', async ({
  page,
}) => {
  const errors = await goLiveProbed(page, 'level_too_hot');
  await expect(warningLine(page)).toHaveText(TOO_LOUD);
  // The fixture starts no later than the meter appears and clips from 300 ms in.
  const after = await warningAfterMeter(page, TOO_LOUD);
  expect(after).not.toBeNull();
  expect(after!).toBeLessThanOrEqual(300 + 200);
  // Icon + text, and not a live region itself.
  await expect(warningLine(page).locator('svg')).toHaveCount(1);
  expect(await warningLine(page).getAttribute('aria-live')).toBeNull();
  await expect(meter(page)).toHaveAttribute('aria-valuetext', /dBFS, too loud$/);

  // Announced politely once while it stays (the fixture clips throughout its 5.55 s).
  await expect.poll(async () => (await read(page)).polite).toEqual([TOO_LOUD]);
  await page.waitForTimeout(1000);
  expect((await read(page)).polite).toEqual([TOO_LOUD]);

  await expectNoSeriousAxe(page);
  expect(errors).toEqual([]);
});

test('silence_60s shows Too quiet after 3 s, not before 2.9 s', async ({ page }) => {
  const errors = await goLiveProbed(page, 'silence_60s');
  await expect(meter(page)).toHaveAttribute('aria-valuenow', '-60');
  await expect(meter(page)).toHaveAttribute('aria-valuetext', '−60 dBFS');
  await expect(warningLine(page)).toHaveText(TOO_QUIET, { timeout: 5000 });
  const after = await warningAfterMeter(page, TOO_QUIET);
  expect(after).not.toBeNull();
  expect(after!).toBeGreaterThanOrEqual(2900);
  expect(after!).toBeLessThan(3600);
  expect((await read(page)).warnings.filter((w) => w.text !== '')).toHaveLength(1);
  await expect(meter(page)).toHaveAttribute('aria-valuetext', '−60 dBFS, too quiet');
  // Silence: an empty fill and no peak tick.
  const silent = await bar(page);
  expect(silent.clipPath).toBe('inset(0px 100% 0px 0px)');
  expect(silent.peakVisible).toBe(false);
  await expect.poll(async () => (await read(page)).polite).toEqual([TOO_QUIET]);
  // The line keeps its height whether or not it shows a warning.
  expect((await warningLine(page).boundingBox())!.height).toBeGreaterThanOrEqual(24);
  await expectNoSeriousAxe(page);
  expect(errors).toEqual([]);
});

test('open_strings shows no warning and the fill updates at ≥ 30 fps', async ({ page }) => {
  const errors = await goLiveProbed(page, 'open_strings');
  const fill = page.getByTestId('input-level-fill');

  // Count changes of the fill's style over 1 s.
  const updates = await fill.evaluate(
    (el) =>
      new Promise<number>((resolve) => {
        let count = 0;
        const observer = new MutationObserver((records) => (count += records.length));
        observer.observe(el, { attributes: true, attributeFilter: ['style'] });
        setTimeout(() => {
          observer.disconnect();
          resolve(count);
        }, 1000);
      }),
  );
  expect(updates).toBeGreaterThanOrEqual(30);

  // An empty warning line keeps its height.
  await expect(warningLine(page)).toHaveText('');
  expect((await warningLine(page).boundingBox())!.height).toBeGreaterThanOrEqual(24);

  // The peak tick shows, at or right of the fill's edge.
  await expect
    .poll(async () => {
      const b = await bar(page);
      return b.peakVisible && b.fillPercent > 0 && b.peakPercent >= b.fillPercent;
    })
    .toBe(true);

  // No warning for the fixture's length.
  const { meterAt } = await read(page);
  const elapsed = await page.evaluate((at) => performance.now() - at!, meterAt);
  await page.waitForTimeout(Math.max(0, 6500 - elapsed));
  const p = await read(page);
  expect(p.warnings.filter((w) => w.text !== '')).toEqual([]);
  expect(p.polite).toEqual([]);
  await expectNoSeriousAxe(page);
  expect(errors).toEqual([]);
});

test('after a stretch away from Record, the warning starts afresh', async ({ page }) => {
  const errors = await goLiveProbed(page, 'silence_60s');
  await expect(warningLine(page)).toHaveText(TOO_QUIET, { timeout: 5000 });
  const nav = page.getByRole('navigation');
  await nav.getByRole('link', { name: 'Library' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Library');
  await page.waitForTimeout(1000);

  const returnAt = await page.evaluate(() => performance.now());
  await nav.getByRole('link', { name: 'Record' }).click();
  await expect(meter(page)).toBeVisible();
  // The remounted line never shows the old warning, and Too quiet needs 3 s of new quiet.
  await expect(warningLine(page)).toHaveText('');
  await expect(warningLine(page)).toHaveText(TOO_QUIET, { timeout: 5000 });
  const after = (await read(page)).warnings.filter((w) => w.at >= returnAt);
  expect(after.map((w) => w.text)).toEqual(['', TOO_QUIET]);
  expect(after[1]!.at - returnAt).toBeGreaterThanOrEqual(2900);
  expect(errors).toEqual([]);
});

test('the fill and peak tick have no transition under prefers-reduced-motion', async ({ page }) => {
  const errors = await goLiveProbed(page, 'open_strings');
  const durations = () =>
    page.evaluate(() =>
      ['input-level-fill', 'input-level-peak'].map(
        (id) =>
          getComputedStyle(document.querySelector(`[data-testid="${id}"]`)!).transitionDuration,
      ),
    );
  expect((await durations()).every((d) => d !== '0s')).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await durations()).toEqual(['0s', '0s']);
  expect(errors).toEqual([]);
});
