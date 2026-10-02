import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousAxe } from './mic-helpers';

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
    let warning = '';
    let polite = '';
    new MutationObserver(() => {
      const now = performance.now();
      if (p.meterAt === null && document.querySelector('[role="meter"]')) p.meterAt = now;
      const line = document.querySelector('[data-testid="input-level-warning"]');
      const text = line?.textContent ?? '';
      if (line && text !== warning) {
        warning = text;
        p.warnings.push({ text, at: now });
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

const meter = (page: Page) => page.getByRole('meter', { name: 'Input level' });
const warningLine = (page: Page) => page.getByTestId('input-level-warning');

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

async function goLive(page: Page, fixture: string): Promise<string[]> {
  const errors = collectErrors(page);
  await probe(page);
  await page.goto(`./?fakeMic=${fixture}#/record`);
  await page.getByRole('button', { name: 'Allow microphone' }).click();
  await expect(meter(page)).toBeVisible();
  return errors;
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
  const errors = await goLive(page, 'level_too_hot');
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
  const errors = await goLive(page, 'silence_60s');
  await expect(meter(page)).toHaveAttribute('aria-valuenow', '-60');
  await expect(meter(page)).toHaveAttribute('aria-valuetext', '−60 dBFS');
  await expect(warningLine(page)).toHaveText(TOO_QUIET, { timeout: 5000 });
  const after = await warningAfterMeter(page, TOO_QUIET);
  expect(after).not.toBeNull();
  expect(after!).toBeGreaterThanOrEqual(2900);
  expect(after!).toBeLessThan(3600);
  expect((await read(page)).warnings.filter((w) => w.text !== '')).toHaveLength(1);
  await expect(meter(page)).toHaveAttribute('aria-valuetext', '−60 dBFS, too quiet');
  await expect.poll(async () => (await read(page)).polite).toEqual([TOO_QUIET]);
  // The line keeps its height whether or not it shows a warning.
  expect((await warningLine(page).boundingBox())!.height).toBeGreaterThanOrEqual(24);
  await expectNoSeriousAxe(page);
  expect(errors).toEqual([]);
});

test('open_strings shows no warning and the fill updates at ≥ 30 fps', async ({ page }) => {
  const errors = await goLive(page, 'open_strings');
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

  // No warning for the fixture's length.
  const { meterAt } = await read(page);
  const elapsed = await page.evaluate((at) => performance.now() - at!, meterAt);
  await page.waitForTimeout(Math.max(0, 6500 - elapsed));
  const p = await read(page);
  expect(p.warnings.filter((w) => w.text !== '')).toEqual([]);
  expect(p.polite).toEqual([]);
  expect(errors).toEqual([]);
});

test('the fill and peak tick have no transition under prefers-reduced-motion', async ({ page }) => {
  const errors = await goLive(page, 'open_strings');
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
