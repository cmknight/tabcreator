import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousAxe } from './mic-helpers';

// Runs in the `dev` project only: the fake mic (US-0.4) plays c_major_scale_pos1 (7.95 s at
// 48 kHz) as the microphone. Story 3.4: Record then Stop saves a take and opens its Tab.

const FIXTURE = 'c_major_scale_pos1';
const MIME = 'audio/webm;codecs=opus';

interface SavedTake {
  take: {
    id: string;
    status: string;
    stopReason?: string;
    audioMime: string | null;
    durationMs: number;
    sampleRate: number;
  } | null;
  rawSamples: number | null;
  /** RMS over the raw samples; null when the raw file is missing. */
  rawRms: number | null;
  /** RMS over the decoded compressed copy; null when missing or undecodable. */
  decodedRms: number | null;
  /** The compressed file's decoded duration in s; null when missing or undecodable. */
  decodedSeconds: number | null;
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

const recordButton = (page: Page) => page.getByRole('button', { name: 'Record', exact: true });
const stopButton = (page: Page) => page.getByRole('button', { name: 'Stop', exact: true });
const timer = (page: Page) => page.getByRole('timer');

async function goLive(page: Page): Promise<string[]> {
  const errors = collectErrors(page);
  await page.goto(`./?fakeMic=${FIXTURE}#/record`);
  await page.getByRole('button', { name: 'Allow microphone' }).click();
  await expect(page.getByRole('meter', { name: 'Input level' })).toBeVisible();
  return errors;
}

/**
 * From now until the Tab opens, keeps the store's elapsed time while the take is `stopping`:
 * once the audio clock passes the stop time it is frozen at the audio-clock time between start
 * and stop. Uses the dev server's module instance (the same URL the app loaded).
 */
async function watchStopClock(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const path = '/src/session/recording-session.ts';
    const { recordingSession } = (await import(
      /* @vite-ignore */ path
    )) as typeof import('../../src/session/recording-session');
    const w = window as unknown as { __stopClockMs: number | null };
    w.__stopClockMs = null;
    const id = setInterval(() => {
      const { recording } = recordingSession.getSnapshot();
      if (recording === 'stopping') w.__stopClockMs = recordingSession.readElapsedMs();
      if (location.hash.startsWith('#/tab/')) clearInterval(id);
    }, 2);
  });
}

/** The take's record, its raw sample count and its compressed copy's decoded duration. */
function readSaved(page: Page, id: string): Promise<SavedTake> {
  return page.evaluate(async (takeId) => {
    const take = await new Promise<SavedTake['take']>((resolve, reject) => {
      const open = indexedDB.open('tabcreator');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const get = db.transaction('takes').objectStore('takes').get(takeId);
        get.onsuccess = () => {
          resolve((get.result as SavedTake['take']) ?? null);
          db.close();
        };
        get.onerror = () => reject(get.error);
      };
    });
    const rms = (samples: Float32Array) => {
      let sum = 0;
      for (const v of samples) sum += v * v;
      return samples.length ? Math.sqrt(sum / samples.length) : 0;
    };
    const root = await navigator.storage.getDirectory();
    let rawSamples: number | null;
    let rawRms: number | null;
    try {
      const raw = await (await root.getDirectoryHandle('raw')).getFileHandle(`${takeId}.f32`);
      const samples = new Float32Array(await (await raw.getFile()).arrayBuffer());
      rawSamples = samples.length;
      rawRms = rms(samples);
    } catch {
      rawSamples = null;
      rawRms = null;
    }
    let decodedSeconds: number | null;
    let decodedRms: number | null;
    try {
      const file = await (await root.getDirectoryHandle('audio')).getFileHandle(`${takeId}.webm`);
      const ctx = new OfflineAudioContext(1, 1, 48_000);
      const buffer = await ctx.decodeAudioData(await (await file.getFile()).arrayBuffer());
      decodedSeconds = buffer.duration;
      decodedRms = rms(buffer.getChannelData(0));
    } catch {
      decodedSeconds = null;
      decodedRms = null;
    }
    return { take, rawSamples, rawRms, decodedSeconds, decodedRms };
  }, id);
}

/** Waits for the Tab of the new take and returns its id. */
async function tabTakeId(page: Page): Promise<string> {
  await expect(page).toHaveURL(/#\/tab\/[^/]+$/, { timeout: 15_000 });
  const id = decodeURIComponent(new URL(page.url()).hash.slice('#/tab/'.length));
  await expect(page.locator(`[data-take-id="${id}"]`)).toBeVisible();
  return id;
}

test('Record then Stop saves the take and opens its Tab', async ({ page }) => {
  const errors = await goLive(page);
  await expect(timer(page)).toHaveText('0:00');
  await expect(recordButton(page)).toHaveAttribute('aria-pressed', 'false');

  await recordButton(page).click();
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(timer(page)).toHaveText('0:02', { timeout: 5_000 });
  await expectNoSeriousAxe(page);
  await expect(timer(page)).toHaveText('0:04', { timeout: 5_000 });

  await watchStopClock(page);
  await stopButton(page).click();
  const id = await tabTakeId(page);

  const saved = await readSaved(page, id);
  const stopClockMs = await page.evaluate(
    () => (window as unknown as { __stopClockMs: number | null }).__stopClockMs,
  );
  expect(saved.take).toMatchObject({
    id,
    status: 'recorded',
    stopReason: 'user',
    audioMime: MIME,
  });
  const { durationMs, sampleRate } = saved.take!;
  expect(durationMs).toBeGreaterThan(4_000);
  expect(durationMs).toBeLessThan(7_000);
  expect(saved.rawSamples).not.toBeNull();
  expect(Math.abs(durationMs - (saved.rawSamples! / sampleRate) * 1000)).toBeLessThanOrEqual(50);
  expect(stopClockMs).not.toBeNull();
  expect(Math.abs(durationMs - stopClockMs!)).toBeLessThanOrEqual(50);
  expect(saved.decodedSeconds).not.toBeNull();
  expect(saved.decodedSeconds!).toBeGreaterThan(durationMs / 1000 - 0.5);
  // Both copies hold the scale, not silence (RMS above −40 dBFS).
  expect(saved.rawRms!).toBeGreaterThan(0.01);
  expect(saved.decodedRms!).toBeGreaterThan(0.01);
  expect(errors).toEqual([]);
});

test('leaving Record keeps recording; returning shows Stop and the running timer', async ({
  page,
}) => {
  const errors = await goLive(page);
  await recordButton(page).click();
  const startedAt = Date.now();
  await expect(stopButton(page)).toBeVisible();

  await page.getByRole('link', { name: 'Library' }).click();
  await expect(page).toHaveURL(/#\/library$/);
  await page.waitForTimeout(2_000);
  await page.getByRole('link', { name: 'Record' }).click();
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(timer(page)).not.toHaveText(/^0:0[01]$/);

  await stopButton(page).click();
  const stoppedAt = Date.now();
  const id = await tabTakeId(page);
  const saved = await readSaved(page, id);
  expect(saved.take?.status).toBe('recorded');
  // The whole time on the Library counts: the take ran from Record to Stop.
  expect(saved.take!.durationMs).toBeGreaterThan(stoppedAt - startedAt - 500);
  expect(errors).toEqual([]);
});

test('no Record button without a live mic', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(`./?fakeMic=${FIXTURE}#/record`);
  await expect(page.getByRole('button', { name: 'Allow microphone' })).toBeVisible();
  await expect(recordButton(page)).toHaveCount(0);

  await page.evaluate(() => window.__fakeMic!.failNext('NotAllowedError'));
  await page.getByRole('button', { name: 'Allow microphone' }).click();
  await expect(page.getByRole('heading', { name: 'Microphone access is blocked' })).toBeVisible();
  await expect(recordButton(page)).toHaveCount(0);
  await expect(page.getByRole('timer')).toHaveCount(0);
  expect(errors.filter((e) => !e.includes('NotAllowedError'))).toEqual([]);
});

// Story 3.5: Space on Record (ui/a11y/shortcuts.ts).
test('Space with focus on the page starts the take, and Space again stops it', async ({ page }) => {
  const errors = await goLive(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  await page.keyboard.press('Space');
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(timer(page)).toHaveText('0:01', { timeout: 5_000 });
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await page.keyboard.press('Space');
  const id = await tabTakeId(page);
  const saved = await readSaved(page, id);
  expect(saved.take).toMatchObject({ status: 'recorded', stopReason: 'user' });
  expect(errors).toEqual([]);
});

test('Space on the focused Record button toggles once (its own click)', async ({ page }) => {
  const errors = await goLive(page);
  await recordButton(page).focus();

  await page.keyboard.press('Space');
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  // Not toggled twice: still recording a moment later, focus kept on the button.
  await expect(timer(page)).toHaveText('0:01', { timeout: 5_000 });
  await expect(stopButton(page)).toBeFocused();
  await expect(page).toHaveURL(/#\/record$/);

  await page.keyboard.press('Space');
  const id = await tabTakeId(page);
  expect((await readSaved(page, id)).take?.status).toBe('recorded');
  expect(errors).toEqual([]);
});

test('Space does nothing off Record, held Space toggles once', async ({ page }) => {
  const errors = await goLive(page);
  await page.getByRole('link', { name: 'Library' }).click();
  await expect(page).toHaveURL(/#\/library$/);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Space');
  await page.getByRole('link', { name: 'Record' }).click();
  await expect(recordButton(page)).toHaveAttribute('aria-pressed', 'false');

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  // A held key: one keydown, then auto-repeats.
  await page.keyboard.down('Space');
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() =>
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', repeat: true, bubbles: true, cancelable: true }),
      ),
    );
  }
  await page.keyboard.up('Space');
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(timer(page)).toHaveText('0:01', { timeout: 5_000 });
  await stopButton(page).click();
  await tabTakeId(page);
  expect(errors).toEqual([]);
});
