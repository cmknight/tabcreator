import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  CAPTURE_START_MARK,
  CAPTURE_STOP_MARK,
  RECORD_KEYDOWN_MARK,
} from '../../src/model/latency-marks';
import { recordButton, stopButton, timer } from './helpers';
import { watchHygiene } from './hygiene';
import { nav } from './library-helpers';
import { goLive, meter } from './mic-helpers';
import { rawFileExists, readTab, readTake, takeCount } from './storage-helpers';

// The production-mic lane (`prod-mic` project): the production build, with Chromium's fake
// capture device looping testdata/synth/c_major_scale_pos1_noisy.wav as the microphone, the
// permission granted and Chrome's own autoplay policy.

const ASSETS = join(import.meta.dirname, '..', '..', 'dist', 'assets');

/** The start times of the page's User Timing marks named `name`, in order. */
const markTimes = (page: Page, name: string): Promise<number[]> =>
  page.evaluate((n) => performance.getEntriesByName(n).map((e) => e.startTime), name);

// Story 3.4: recording loads the recorder worklet from its own same-origin JS file, under the
// production CSP, with no violation.
test('Record then Stop loads the worklet as a same-origin script with no CSP violation', async ({
  page,
  baseURL,
}) => {
  // Chromium reports worklet module fetches neither as requests nor in resource timing, so
  // the built files show where the worklet comes from: its own JS file, which the app's
  // bundle references by a relative (same-origin) URL, never inlined as data: or blob:.
  const files = readdirSync(ASSETS);
  const worklet = files.filter((f) => /^recorder-worklet-[\w-]+\.js$/.test(f));
  expect(worklet).toHaveLength(1);
  const bundles = files.filter((f) => f.endsWith('.js') && !worklet.includes(f));
  expect(
    bundles.filter((f) => readFileSync(join(ASSETS, f), 'utf8').includes(worklet[0]!)),
  ).toHaveLength(1);
  const served = await page.request.get(new URL(`assets/${worklet[0]}`, baseURL).href);
  expect(served.headers()['content-type']).toMatch(/javascript/);
  expect(await served.text()).toContain('registerProcessor');

  const hygiene = await watchHygiene(page, baseURL!);
  await goLive(page, null);
  await expect(recordButton(page)).toBeVisible();
  await recordButton(page).click();
  // The timer runs only once the worklet is loaded and the capture started.
  await expect(timer(page)).toHaveText('0:01', { timeout: 5_000 });
  await stopButton(page).click();
  await expect(page).toHaveURL(/#\/tab\/[^/]+$/, { timeout: 15_000 });
  hygiene.expectClean();
});

// Done when 1: Space starts a take within 100 ms of the keydown, measured by the two marks the
// production build sets (`record-keydown` at the handled keydown, `record-capture-start` when
// the worklet copies its first frame); Space again stops it and opens its Tab.
test('Space starts a take within 100 ms, and Space again stops it and opens its Tab', async ({
  page,
  baseURL,
}) => {
  const hygiene = await watchHygiene(page, baseURL!);
  await goLive(page, null);
  await expect(recordButton(page)).toBeVisible();
  // Focus on the page itself, not a control: Space on a focused button is the button's own.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  await page.keyboard.press('Space');
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await markTimes(page, CAPTURE_START_MARK)).length).toBe(1);
  const marks = {
    keydown: await markTimes(page, RECORD_KEYDOWN_MARK),
    start: await markTimes(page, CAPTURE_START_MARK),
  };
  expect(marks.keydown).toHaveLength(1);
  expect(marks.start).toHaveLength(1);
  const latencyMs = marks.start[0]! - marks.keydown[0]!;
  test.info().annotations.push({ type: 'space-to-capture-ms', description: latencyMs.toFixed(1) });
  expect(latencyMs).toBeGreaterThanOrEqual(0);
  expect(latencyMs).toBeLessThanOrEqual(100);

  await expect(timer(page)).toHaveText('0:01', { timeout: 5_000 });
  // The page did not scroll on Space.
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.keyboard.press('Space');
  await expect(page).toHaveURL(/#\/tab\/[^/]+$/, { timeout: 15_000 });
  expect((await markTimes(page, RECORD_KEYDOWN_MARK)).length).toBeGreaterThanOrEqual(2);
  hygiene.expectClean();
});

// Story 3.7 (CAP-5, Done when 1): a take left running stops itself at 5:00, its stop scheduled
// on the audio clock, and its compressed copy fits in 5 MB. Slow: the full five minutes.
test('a take runs to the 5:00 cap, stops itself, and its compressed copy is at most 5 MB @slow', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(7 * 60_000);
  const hygiene = await watchHygiene(page, baseURL!);
  await goLive(page, null);
  await expect(recordButton(page)).toBeVisible();
  await recordButton(page).click();
  await expect(timer(page)).toHaveText('0:01', { timeout: 5_000 });

  await expect(page.getByTestId('near-limit')).toHaveText('30 seconds left', {
    timeout: 4.75 * 60_000,
  });
  await expect(timer(page)).toHaveText(/^4:(29|3[0-5])$/);
  await expect(page).toHaveURL(/#\/tab\/[^/]+$/, { timeout: 60_000 });
  const id = decodeURIComponent(new URL(page.url()).hash.slice('#/tab/'.length));

  const readSaved = async () => {
    const take = await readTake<{ status: string; stopReason?: string; durationMs: number }>(
      page,
      id,
    );
    const compressedBytes = await page.evaluate(async (takeId) => {
      const root = await navigator.storage.getDirectory();
      const file = await (await root.getDirectoryHandle('audio')).getFileHandle(`${takeId}.webm`);
      return (await file.getFile()).size;
    }, id);
    const rawExists = await rawFileExists(page, id);
    return { take, compressedBytes, rawExists };
  };

  // Story 5.6: the Tab screen analyses the take; wait for it to be analysed and its raw file gone.
  await expect
    .poll(
      async () => {
        const { take, rawExists } = await readSaved();
        return { status: take?.status, rawExists };
      },
      { timeout: 60_000 },
    )
    .toEqual({ status: 'analyzed', rawExists: false });
  const saved = await readSaved();

  expect(saved.take).toMatchObject({ status: 'analyzed', stopReason: 'max-length' });
  expect(Math.abs(saved.take!.durationMs - 300_000)).toBeLessThanOrEqual(50);
  test.info().annotations.push({
    type: 'compressed-bytes',
    description: String(saved.compressedBytes),
  });
  expect(saved.compressedBytes).toBeGreaterThan(0);
  // 5 MB as in CAP-5, in decimal bytes (CAP-25 states sweep, Recording retro A5).
  expect(saved.compressedBytes).toBeLessThanOrEqual(5_000_000);
  hygiene.expectClean();
});

// Story 5.6 (the tracer, US-4.4, US-4.5): a stopped take is analysed and its tab shown, from
// storage. Within 2 s of the Stop click the Tab screen shows a system whose first line is the
// high e string; the take is analysed (engine version and warnings), its tab has notes, and its
// raw file is gone.
test('Record 3 s, Stop: the tab shows within 2 s; the take is analysed and its raw file deleted', async ({
  page,
  baseURL,
}) => {
  const hygiene = await watchHygiene(page, baseURL!);
  await goLive(page, null);
  await expect(recordButton(page)).toBeVisible();
  await recordButton(page).click();
  await expect(timer(page)).toHaveText('0:03', { timeout: 8_000 });

  // Timed from before the click, so the click itself counts against the 2 s.
  const stoppedAt = Date.now();
  await stopButton(page).click();
  const firstPre = page.locator('[data-take-id] pre').first();
  await expect(firstPre).toBeVisible({ timeout: 2_000 });
  const elapsedMs = Date.now() - stoppedAt;
  test.info().annotations.push({ type: 'stop-to-tab-ms', description: String(elapsedMs) });
  expect(elapsedMs).toBeLessThanOrEqual(2_000);
  expect((await firstPre.textContent())!.split('\n')[0]).toMatch(/^e\|/);

  const id = decodeURIComponent(new URL(page.url()).hash.slice('#/tab/'.length));
  const stored = {
    take: await readTake<{
      status: string;
      analysisVersion: string | null;
      warnings?: { tuningOffsetCents: number; belowRangeNotes: number };
    }>(page, id),
    tab: await readTab<{ notes: unknown[] }>(page, id),
    rawExists: await rawFileExists(page, id),
  };

  expect(stored.take?.status).toBe('analyzed');
  expect(stored.take?.analysisVersion).not.toBeNull();
  expect(stored.take?.warnings).toEqual({
    tuningOffsetCents: expect.any(Number),
    belowRangeNotes: expect.any(Number),
  });
  expect(stored.tab?.notes.length).toBeGreaterThan(0);
  expect(stored.rawExists).toBe(false);
  hygiene.expectClean();
});

// CAP-25 states sweep (Recording retro A5; epic recording Done-when 1): Space stops a take within
// 100 ms of the keydown, measured by the production build's marks. The clock starts in the Space
// shortcut handler (the second `record-keydown`, the stop's; the start's keydown clears every
// latency mark first) and ends when the worklet's `stopped` message reaches the main thread
// (`record-capture-stop`). The stop is scheduled 50 ms ahead on the audio clock (recorder.ts
// LOOKAHEAD_S), so that lookahead is inside the measure. Several takes: the median within 100 ms,
// and every take within 150 ms.
test('Space stops a take within 100 ms of the keydown (median of 5), each within 150 ms', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const RUNS = 5;
  const hygiene = await watchHygiene(page, baseURL!);
  const errors = await goLive(page, null);
  const latencies: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    await expect(recordButton(page)).toBeVisible();
    await expect(meter(page)).toBeVisible();
    // Focus on the page itself, not a control: Space on a focused button is the button's own.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Space');
    await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(timer(page)).toHaveText('0:01', { timeout: 5_000 });
    await page.keyboard.press('Space');
    await expect.poll(async () => (await markTimes(page, CAPTURE_STOP_MARK)).length).toBe(1);
    const marks = {
      keydown: await markTimes(page, RECORD_KEYDOWN_MARK),
      stop: await markTimes(page, CAPTURE_STOP_MARK),
    };
    expect(marks.keydown).toHaveLength(2);
    latencies.push(marks.stop[0]! - marks.keydown[1]!);
    // The take opens its Tab; wait for its analysis so it cannot load the next take's stop.
    await expect(page).toHaveURL(/#\/tab\/[^/]+$/, { timeout: 15_000 });
    await expect(page.getByTestId('tab-status-line')).toBeVisible({ timeout: 20_000 });
    await nav(page, 'Record').click();
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  test.info().annotations.push({
    type: 'space-to-capture-stop-ms',
    description: `median ${median.toFixed(1)}; runs ${latencies.map((l) => l.toFixed(1)).join(', ')}`,
  });
  for (const ms of latencies) {
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThanOrEqual(150);
  }
  expect(median).toBeLessThanOrEqual(100);
  expect(errors).toEqual([]);
  hygiene.expectClean();
});

// CAP-25 states sweep (Recording retro A5): shortcuts never fire while focus is in a text field
// (EXPERIENCE Interaction Primitives): Space in the Tempo field starts no take.
test('Space in the Tempo field starts no take', async ({ page, baseURL }) => {
  const hygiene = await watchHygiene(page, baseURL!);
  const errors = await goLive(page, null);
  const tempo = page.getByRole('spinbutton', { name: 'Tempo' });
  await tempo.focus();
  await page.keyboard.press('Space');
  await expect(tempo).toBeFocused();
  // Long enough for a take that had started to show 0:01.
  await page.waitForTimeout(1_500);
  await expect(recordButton(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(stopButton(page)).toHaveCount(0);
  await expect(timer(page)).toHaveText('0:00');
  expect(await markTimes(page, RECORD_KEYDOWN_MARK)).toEqual([]);
  expect(await takeCount(page)).toBe(0);
  expect(errors).toEqual([]);
  hygiene.expectClean();
});
