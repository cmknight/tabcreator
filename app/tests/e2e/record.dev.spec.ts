import { expect, test, type Page } from '@playwright/test';
import { MIME, collectErrors } from './helpers';
import { expectNoSeriousAxe, FIXTURE, goLive, held, meter } from './mic-helpers';

// Runs in the `dev` project only: the fake mic (US-0.4) plays c_major_scale_pos1 (7.95 s at
// 48 kHz) as the microphone. Story 3.4: Record then Stop saves a take and opens its Tab.
// Story 3.6: the count-in (`silence_60s` where click energy is measured).

interface SavedTake {
  take: {
    id: string;
    status: string;
    stopReason?: string;
    audioMime: string | null;
    durationMs: number;
    sampleRate: number;
    countInBpm?: number;
    clipped?: boolean;
  } | null;
  rawSamples: number | null;
  /** RMS over the raw samples; null when the raw file is missing. */
  rawRms: number | null;
  /** RMS over the decoded compressed copy; null when missing or undecodable. */
  decodedRms: number | null;
  /** The compressed file's decoded duration in s; null when missing or undecodable. */
  decodedSeconds: number | null;
  /**
   * The loudest 30 ms Goertzel amplitude at each count-in click frequency (1000 and 1500 Hz) in
   * the raw and the decoded audio; a click at −12 dBFS would read about 0.25.
   */
  clicks: { raw: number[]; decoded: number[] } | null;
}

const recordButton = (page: Page) => page.getByRole('button', { name: 'Record', exact: true });
const stopButton = (page: Page) => page.getByRole('button', { name: 'Stop', exact: true });
const timer = (page: Page) => page.getByRole('timer');

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
    /** The loudest Goertzel amplitude at `hz` over 30 ms windows, hopped by 10 ms. */
    const tone = (samples: Float32Array, rate: number, hz: number) => {
      const n = Math.round(rate * 0.03);
      const hop = Math.round(rate * 0.01);
      const coeff = 2 * Math.cos((2 * Math.PI * hz) / rate);
      let loudest = 0;
      for (let at = 0; at + n <= samples.length; at += hop) {
        let s1 = 0;
        let s2 = 0;
        for (let i = at; i < at + n; i++) {
          const s0 = samples[i]! + coeff * s1 - s2;
          s2 = s1;
          s1 = s0;
        }
        const power = Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2);
        loudest = Math.max(loudest, (2 * Math.sqrt(power)) / n);
      }
      return loudest;
    };
    const CLICK_HZ = [1000, 1500];
    let rawClicks: number[] | null = null;
    let decodedClicks: number[] | null = null;
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
      const rate = take?.sampleRate ?? 48_000;
      rawClicks = CLICK_HZ.map((hz) => tone(samples, rate, hz));
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
      decodedClicks = CLICK_HZ.map((hz) => tone(buffer.getChannelData(0), buffer.sampleRate, hz));
    } catch {
      decodedSeconds = null;
      decodedRms = null;
    }
    const clicks = rawClicks && decodedClicks ? { raw: rawClicks, decoded: decodedClicks } : null;
    return { take, rawSamples, rawRms, decodedSeconds, decodedRms, clicks };
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
  const errors = await goLive(page, held());
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
  const errors = await goLive(page, held());
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

// Story 3.8: without a live mic, Record shows disabled, the mic card's heading its reason.
test('without a live mic Record is aria-disabled, described by the card heading; click and Space do nothing', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto(`./?fakeMic=${FIXTURE}#/record`);
  await expect(page.getByRole('button', { name: 'Allow microphone' })).toBeVisible();
  await expect(recordButton(page)).toBeVisible();
  await expect(recordButton(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(recordButton(page)).toHaveAccessibleDescription('TabCreator needs your microphone');
  await expectNoSeriousAxe(page);

  // aria-disabled: Playwright waits for "enabled" unless forced; the click must do nothing.
  await recordButton(page).click({ force: true });
  await blur(page);
  await page.keyboard.press('Space');
  await expectNoTake(page);
  // Nothing asked for the mic: the setup card is still there.
  await expect(page.getByRole('button', { name: 'Allow microphone' })).toBeVisible();
  // Space on the focused (still focusable) Record button: its own click, which does nothing.
  await recordButton(page).focus();
  await expect(recordButton(page)).toBeFocused();
  await page.keyboard.press('Space');
  await expectNoTake(page);
  await expect(
    page.getByRole('heading', { name: 'TabCreator needs your microphone' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow microphone' })).toBeVisible();

  await page.evaluate(() => window.__fakeMic!.failNext('NotAllowedError'));
  await page.getByRole('button', { name: 'Allow microphone' }).click();
  await expect(page.getByRole('heading', { name: 'Microphone access is blocked' })).toBeVisible();
  await expect(recordButton(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(recordButton(page)).toHaveAccessibleDescription('Microphone access is blocked');
  await recordButton(page).click({ force: true });
  await blur(page);
  await page.keyboard.press('Space');
  await expectNoTake(page);
  await expect(page.getByRole('heading', { name: 'Microphone access is blocked' })).toBeVisible();
  expect(errors.filter((e) => !e.includes('NotAllowedError'))).toEqual([]);
});

test('with a live mic Record is enabled, with no description', async ({ page }) => {
  const errors = await goLive(page);
  await expect(recordButton(page)).not.toHaveAttribute('aria-disabled');
  await expect(recordButton(page)).not.toHaveAttribute('aria-describedby');
  expect(errors).toEqual([]);
});

// Story 3.5: Space on Record (ui/a11y/shortcuts.ts).
test('Space with focus on the page starts the take, and Space again stops it', async ({ page }) => {
  const errors = await goLive(page, held());
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
  const errors = await goLive(page, held());
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

/** Blurs whatever has focus, so keys go to the page itself. */
const blur = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

/**
 * The number of saved takes (0 before the database exists). Never creates the database: an open
 * that would create it is aborted, so the app's own first open still runs its upgrade.
 */
function takeCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('tabcreator');
        let missing = false;
        open.onupgradeneeded = () => {
          missing = true;
          open.transaction?.abort();
        };
        open.onerror = () => (missing ? resolve(0) : reject(open.error));
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('takes')) {
            db.close();
            resolve(0);
            return;
          }
          const count = db.transaction('takes').objectStore('takes').count();
          count.onsuccess = () => {
            resolve(count.result);
            db.close();
          };
          count.onerror = () => reject(count.error);
        };
      }),
  );
}

const keydownMarks = (page: Page) =>
  page.evaluate(() => performance.getEntriesByName('record-keydown').length);

/** No take started: no keydown mark, no take saved, the button still offers Record. */
async function expectNoTake(page: Page): Promise<void> {
  await page.waitForTimeout(500);
  expect(await keydownMarks(page)).toBe(0);
  expect(await takeCount(page)).toBe(0);
  await expect(recordButton(page)).toHaveAttribute('aria-pressed', 'false');
}

test('Space off Record does nothing', async ({ page }) => {
  const errors = await goLive(page);
  await page.getByRole('link', { name: 'Library' }).click();
  await expect(page).toHaveURL(/#\/library$/);
  await blur(page);
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  await page.getByRole('link', { name: 'Record' }).click();
  await expectNoTake(page);
  expect(errors).toEqual([]);
});

test('held Space: auto-repeats while recording do not stop the take', async ({ page }) => {
  const errors = await goLive(page);
  await blur(page);
  await page.keyboard.down('Space');
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  // Now recording: the auto-repeats of the held key reach the toggle's stop path if unguarded.
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() =>
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', repeat: true, bubbles: true, cancelable: true }),
      ),
    );
  }
  await page.keyboard.up('Space');
  await page.waitForTimeout(500);
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/#\/record$/);
  expect(await keydownMarks(page)).toBe(1);
  await expect(timer(page)).toHaveText('0:01', { timeout: 5_000 });
  await stopButton(page).click();
  await tabTakeId(page);
  expect(errors).toEqual([]);
});

test('Space after clicking the Record nav link starts a take (links ignore Space)', async ({
  page,
}) => {
  const errors = await goLive(page);
  await page.getByRole('link', { name: 'Record' }).click();
  await expect(page.getByRole('link', { name: 'Record' })).toBeFocused();
  await page.keyboard.press('Space');
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(timer(page)).toHaveText('0:01', { timeout: 5_000 });
  await stopButton(page).click();
  await tabTakeId(page);
  expect(errors).toEqual([]);
});

test('Space in the Microphone select does not start a take', async ({ page }) => {
  const errors = await goLive(page, 'open_strings,silence_60s');
  const select = page.getByRole('combobox', { name: 'Microphone' });
  await select.focus();
  await page.keyboard.press('Space');
  await expectNoTake(page);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

// Story 3.6: the count-in.

const countInToggle = (page: Page) => page.getByRole('button', { name: 'Count-in', exact: true });
const tempoField = (page: Page) => page.getByRole('spinbutton', { name: 'Tempo' });
const cancelButton = (page: Page) => page.getByRole('button', { name: 'Cancel count-in' });
const beat = (page: Page) => page.getByTestId('count-in-beat');

/** Turns the count-in on at `bpm` through the Record screen's controls. */
async function countInOn(page: Page, bpm: number): Promise<void> {
  await countInToggle(page).click();
  await expect(countInToggle(page)).toHaveAttribute('aria-pressed', 'true');
  await tempoField(page).fill(String(bpm));
  await tempoField(page).press('Enter');
  await expect(tempoField(page)).toHaveValue(String(bpm));
  await blur(page);
}

test('count-in at 120 BPM: capture opens 2.0 s after the click; the take has countInBpm and no click', async ({
  page,
}) => {
  const errors = await goLive(page, held('silence_60s'));
  await countInOn(page, 120);

  await recordButton(page).click();
  await expect(cancelButton(page)).toBeVisible();
  // No take during the count-in: it is created at the capture start.
  expect(await takeCount(page)).toBe(0);
  await expect(stopButton(page)).toBeVisible({ timeout: 5_000 });
  const clock = await page.evaluate(() => window.__recordingClock);
  expect(clock).toBeDefined();
  expect(Math.abs(clock!.captureStart - clock!.clickTime - 2)).toBeLessThanOrEqual(0.02);
  await expect(timer(page)).toHaveText('0:03', { timeout: 6_000 });

  await stopButton(page).click();
  const id = await tabTakeId(page);
  const saved = await readSaved(page, id);
  expect(saved.take).toMatchObject({ status: 'recorded', countInBpm: 120 });
  expect(saved.take!.durationMs).toBeGreaterThan(2_500);
  // No click in either copy: the click frequencies stay at the silence floor.
  expect(saved.clicks).not.toBeNull();
  for (const amplitude of [...saved.clicks!.raw, ...saved.clicks!.decoded]) {
    expect(amplitude).toBeLessThan(0.001);
  }
  expect(errors).toEqual([]);
});

test('count-in: the beats 4-3-2-1 show and are announced; controls disabled; Cancel', async ({
  page,
}) => {
  const errors = await goLive(page, held());
  await countInOn(page, 60);
  await recordButton(page).click();

  await expect(cancelButton(page)).toHaveText('Cancel');
  // Not a toggle during the count-in: no aria-pressed.
  await expect(cancelButton(page)).not.toHaveAttribute('aria-pressed');
  await expect(page.getByText('Count-in · 60 BPM')).toBeVisible();
  await expect(timer(page)).toHaveCount(0);
  await expect(countInToggle(page)).toBeDisabled();
  await expect(tempoField(page)).toBeDisabled();
  const alert = page.getByRole('alert');
  for (const n of ['4', '3', '2', '1']) {
    await expect(beat(page)).toHaveText(n, { timeout: 2_000 });
    await expect(alert).toHaveText(n, { timeout: 2_000 });
    if (n === '3') await expectNoSeriousAxe(page);
  }

  // Recording: the timer is back, the controls stay disabled.
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true', { timeout: 3_000 });
  await expect(beat(page)).toHaveCount(0);
  await expect(timer(page)).toBeVisible();
  await expect(countInToggle(page)).toBeDisabled();
  await expect(tempoField(page)).toBeDisabled();
  // Past 0.5 s, so the take is kept (story 3.7).
  await expect(timer(page)).toHaveText('0:01', { timeout: 5_000 });
  await stopButton(page).click();
  const id = await tabTakeId(page);
  expect((await readSaved(page, id)).take).toMatchObject({ status: 'recorded', countInBpm: 60 });

  // The pref is remembered across a reload.
  // The mic was granted, so it goes live again without a click.
  await page.goto(`./?fakeMic=${held()}#/record`);
  await expect(meter(page)).toBeVisible();
  await expect(countInToggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(tempoField(page)).toHaveValue('60');
  await expect(countInToggle(page)).toBeEnabled();
  expect(errors).toEqual([]);
});

test('count-in: Esc, the Cancel button and Space each cancel; no take is created', async ({
  page,
}) => {
  const errors = await goLive(page);
  await countInOn(page, 60);

  // Esc.
  await recordButton(page).click();
  await expect(cancelButton(page)).toBeVisible();
  await blur(page);
  await page.keyboard.press('Escape');
  await expect(recordButton(page)).toHaveAttribute('aria-pressed', 'false');

  // The Record button, reading Cancel.
  await recordButton(page).click();
  await cancelButton(page).click();
  await expect(recordButton(page)).toHaveAttribute('aria-pressed', 'false');

  // Space, from the page.
  await blur(page);
  await page.keyboard.press('Space');
  await expect(cancelButton(page)).toBeVisible();
  await page.keyboard.press('Space');
  await expect(recordButton(page)).toHaveAttribute('aria-pressed', 'false');

  // Past when the last count-in would have opened its capture: still nothing.
  await page.waitForTimeout(4_500);
  expect(await takeCount(page)).toBe(0);
  await expect(recordButton(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(countInToggle(page)).toBeEnabled();
  await expect(page).toHaveURL(/#\/record$/);
  expect(errors).toEqual([]);
});

// Story 3.7: the length cap, its warning, short takes and the recording announcements. The dev
// override `?maxTakeMs=8000&warnLeadMs=3000` stands in for the 5:00 cap and the 4:30 warning.

const LIMITS = 'maxTakeMs=8000&warnLeadMs=3000';
const nearLimit = (page: Page) => page.getByTestId('near-limit');

/**
 * From now on, records every non-empty text the polite live region shows, in order, in
 * `window.__announced`.
 */
async function watchAnnouncements(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __announced: string[] };
    w.__announced = [];
    const region = document.querySelector('[role="status"][aria-live="polite"]')!;
    new MutationObserver(() => {
      const text = region.textContent ?? '';
      if (text) w.__announced.push(text);
    }).observe(region, { childList: true, characterData: true, subtree: true });
  });
}

/** The polite announcements so far that are among `texts`, in order. */
async function announced(page: Page, texts: readonly string[]): Promise<string[]> {
  const all = await page.evaluate(
    () => (window as unknown as { __announced: string[] }).__announced,
  );
  return all.filter((t) => texts.includes(t));
}

/** The names of the files in OPFS `raw/` and `audio/` (none when a directory is missing). */
function opfsFiles(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const names: string[] = [];
    for (const dir of ['raw', 'audio']) {
      try {
        const handle = await root.getDirectoryHandle(dir);
        for await (const name of (handle as unknown as { keys(): AsyncIterable<string> }).keys()) {
          names.push(`${dir}/${name}`);
        }
      } catch {
        // No such directory: nothing in it.
      }
    }
    return names;
  });
}

test('near the cap: "30 seconds left" shows and is announced once; at the cap it stops and saves', async ({
  page,
}) => {
  // The dev take-limit overrides ride in the query after the fixture.
  const errors = await goLive(page, held(`${FIXTURE}&${LIMITS}`));
  await watchAnnouncements(page);

  await recordButton(page).click();
  await expect(timer(page)).toHaveText('0:03', { timeout: 6_000 });
  await expect(nearLimit(page)).toHaveCount(0);
  await expect(nearLimit(page)).toHaveText('30 seconds left', { timeout: 2_000 });
  await expect(timer(page)).toHaveText(/^0:0[4-6]$/);
  await expectNoSeriousAxe(page);

  // No Stop: the take stops itself at 0:08 and opens its Tab.
  const id = await tabTakeId(page);
  const saved = await readSaved(page, id);
  expect(saved.take).toMatchObject({
    id,
    status: 'recorded',
    stopReason: 'max-length',
    audioMime: MIME,
  });
  expect(Math.abs(saved.take!.durationMs - 8_000)).toBeLessThanOrEqual(50);
  expect(saved.rawSamples).not.toBeNull();
  expect(saved.decodedSeconds).not.toBeNull();

  const texts = ['Recording started', '30 seconds left', 'Recording stopped'];
  await expect.poll(() => announced(page, texts)).toEqual(texts);
  expect(errors).toEqual([]);
});

test('too short: a take stopped at once (under 0.5 s) is discarded with a toast; Record stays', async ({
  page,
}) => {
  const errors = await goLive(page);
  await recordButton(page).click();
  // Stop as soon as the take records: well under 0.5 s.
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  await stopButton(page).click();

  await expect(page.getByTestId('toast')).toHaveText('Too short — nothing recorded', {
    timeout: 5_000,
  });
  await expect(recordButton(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page).toHaveURL(/#\/record$/);
  expect(await takeCount(page)).toBe(0);
  await expect.poll(() => opfsFiles(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('Record then Stop announces "Recording started", then "Recording stopped"', async ({
  page,
}) => {
  const errors = await goLive(page);
  await watchAnnouncements(page);
  await recordButton(page).click();
  await expect(timer(page)).toHaveText('0:01', { timeout: 5_000 });
  await stopButton(page).click();
  await tabTakeId(page);
  const texts = ['Recording started', 'Recording stopped'];
  await expect.poll(() => announced(page, texts)).toEqual(texts);
  expect(errors).toEqual([]);
});

// Story 3.8: clipping during a take is saved as `clipped` (US-1.3, spine AD-14).
for (const [fixture, clipped] of [
  ['level_too_hot', true],
  ['open_strings', false],
] as const) {
  test(`a take recorded from ${fixture} is saved with clipped: ${clipped}`, async ({ page }) => {
    const errors = await goLive(page, held(fixture));
    await recordButton(page).click();
    await expect(timer(page)).toHaveText('0:02', { timeout: 5_000 });
    await stopButton(page).click();
    const id = await tabTakeId(page);
    const saved = await readSaved(page, id);
    expect(saved.take).toMatchObject({ status: 'recorded', stopReason: 'user', clipped });
    expect(errors).toEqual([]);
  });
}

// Story 3.8: the Microphone select is disabled from the count-in until the take is saved (CAP-2).
test('the Microphone select is disabled with its reason during the count-in and recording, enabled after', async ({
  page,
}) => {
  const errors = await goLive(page, 'open_strings,silence_60s');
  const select = page.getByRole('combobox', { name: 'Microphone' });
  const field = select.locator('..');
  const REASON = "Can't change the microphone while recording";
  await expect(select).toBeEnabled();
  await expect(field).not.toHaveAttribute('title');
  await expect(select).not.toHaveAttribute('aria-describedby');

  // 40 BPM: a 6 s count-in, long enough to inspect.
  await countInOn(page, 40);
  await recordButton(page).click();
  await expect(cancelButton(page)).toBeVisible();
  await expect(select).toBeDisabled();
  await expect(field).toHaveAttribute('title', REASON);
  await expect(select).toHaveAccessibleDescription(REASON);

  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
  await expect(select).toBeDisabled();
  await expect(field).toHaveAttribute('title', REASON);
  await expect(select).toHaveAccessibleDescription(REASON);
  await expectNoSeriousAxe(page);

  await expect(timer(page)).toHaveText('0:01', { timeout: 5_000 });
  await stopButton(page).click();
  await tabTakeId(page);
  await page.getByRole('link', { name: 'Record' }).click();
  await expect(select).toBeEnabled();
  await expect(field).not.toHaveAttribute('title');
  await expect(select).not.toHaveAttribute('aria-describedby');
  expect(errors).toEqual([]);
});

// Story 3.9: failure stops keep the take. A mic loss mid-take saves it as `mic-lost` and stays
// on Record; a full disk (the dev `__storageFullHook`) saves it as `storage-full` with a banner.

const OPEN_DEVICE = 'fake-mic-open_strings';
const LOST_TITLE = 'Microphone access was lost';
const STORAGE_FULL = 'Storage is full — recording stopped and saved';
const storageBanner = (page: Page) => page.getByTestId('storage-full-banner');

/** The ids of every saved take. */
function takeIds(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open('tabcreator');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const keys = db.transaction('takes').objectStore('takes').getAllKeys();
          keys.onsuccess = () => {
            resolve(keys.result as string[]);
            db.close();
          };
          keys.onerror = () => reject(keys.error);
        };
      }),
  );
}

/**
 * Waits until the take has `ms` of audio-clock time, then runs `then` (by name) at once. Rejects
 * when that time is not reached within 15 s (the take stopped early).
 */
async function atElapsed(
  page: Page,
  ms: number,
  then: 'unplug' | 'revoke' | 'storageFull',
): Promise<void> {
  await page.evaluate(
    async ([at, action, device]) => {
      const path = '/src/session/recording-session.ts';
      const { recordingSession } = (await import(
        /* @vite-ignore */ path
      )) as typeof import('../../src/session/recording-session');
      const deadline = Date.now() + 15_000;
      await new Promise<void>((resolve, reject) => {
        const id = setInterval(() => {
          if (recordingSession.readElapsedMs() < at) {
            if (Date.now() > deadline) {
              clearInterval(id);
              reject(new Error(`atElapsed: the take never reached ${at} ms (did it stop early?)`));
            }
            return;
          }
          clearInterval(id);
          if (action === 'unplug') window.__fakeMic!.unplug(device);
          else if (action === 'revoke') window.__fakeMic!.revoke();
          else (window as unknown as { __storageFullHook: boolean }).__storageFullHook = true;
          resolve();
        }, 2);
      });
    },
    [ms, then, OPEN_DEVICE] as const,
  );
}

/** Waits for the one saved take to be `recorded` and returns it. */
async function savedTake(page: Page): Promise<SavedTake> {
  await expect.poll(() => takeIds(page)).toHaveLength(1);
  const [id] = await takeIds(page);
  await expect.poll(async () => (await readSaved(page, id!)).take?.status).toBe('recorded');
  return readSaved(page, id!);
}

test('unplug mid-take: the take is saved as mic-lost, a toast, the mic live on the other input', async ({
  page,
}) => {
  const errors = await goLive(page, held('open_strings,silence_60s'));
  await recordButton(page).click();
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  await atElapsed(page, 3_000, 'unplug');

  await expect(page.getByTestId('toast')).toHaveText(
    'Microphone disconnected — recording stopped and saved',
    { timeout: 5_000 },
  );
  await expect(recordButton(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(meter(page)).toBeVisible();
  // Live on the silent input left.
  await expect(meter(page)).toHaveAttribute('aria-valuenow', '-60');
  await expect(page.getByRole('region', { name: LOST_TITLE })).toHaveCount(0);
  await expect(page).toHaveURL(/#\/record$/);

  const saved = await savedTake(page);
  expect(saved.take).toMatchObject({ status: 'recorded', stopReason: 'mic-lost', audioMime: MIME });
  expect(Math.abs(saved.take!.durationMs - 3_000)).toBeLessThanOrEqual(500);
  expect(saved.rawSamples).not.toBeNull();
  expect(saved.decodedSeconds).not.toBeNull();
  // Recording did not continue on the fallback input.
  await page.waitForTimeout(500);
  expect(await takeIds(page)).toHaveLength(1);
  await expect(recordButton(page)).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});

test('revoke mid-take: the take is saved as mic-lost, then the lost card', async ({ page }) => {
  const errors = await goLive(page, held('open_strings,silence_60s'));
  await recordButton(page).click();
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  await atElapsed(page, 3_000, 'revoke');

  await expect(page.getByRole('region', { name: LOST_TITLE })).toBeVisible({ timeout: 5_000 });
  await expect(page).toHaveURL(/#\/record$/);
  await expect(page.getByTestId('toast')).toHaveCount(0);
  const saved = await savedTake(page);
  expect(saved.take).toMatchObject({ status: 'recorded', stopReason: 'mic-lost', audioMime: MIME });
  expect(Math.abs(saved.take!.durationMs - 3_000)).toBeLessThanOrEqual(500);
  expect(errors).toEqual([]);
});

test('storage full mid-take: saved as storage-full, the error banner with a Library link, mic live; the next take clears it', async ({
  page,
}) => {
  const errors = await goLive(page, held());
  await recordButton(page).click();
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  await atElapsed(page, 2_000, 'storageFull');

  await expect(storageBanner(page)).toBeVisible({ timeout: 5_000 });
  await expect(storageBanner(page)).toContainText(STORAGE_FULL);
  const link = storageBanner(page).getByRole('link', { name: 'Go to Library' });
  await expect(link).toHaveAttribute('href', '#/library');
  await expect(storageBanner(page)).not.toHaveAttribute('aria-live');
  await expect(page.locator('[aria-live="assertive"]')).toHaveText(STORAGE_FULL);
  // Above the h1, no Dismiss.
  await expect(storageBanner(page).getByRole('button')).toHaveCount(0);
  const order = await page.evaluate(() => {
    const banner = document.querySelector('[data-testid="storage-full-banner"]')!;
    const h1 = document.querySelector('h1')!;
    return banner.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING;
  });
  expect(order).toBeTruthy();
  await expect(recordButton(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(meter(page)).toBeVisible();
  await expect(page).toHaveURL(/#\/record$/);
  await expectNoSeriousAxe(page);

  const saved = await savedTake(page);
  expect(saved.take).toMatchObject({
    status: 'recorded',
    stopReason: 'storage-full',
    audioMime: MIME,
  });
  // Story 5.2 (DS2): was "only the samples written to the raw file" (within 50 ms of it), the
  // defect. The length now counts every captured chunk until the stop completes, as the
  // compressed copy does: from the hook at 2 s plus the stop, and never less than the raw file.
  const { durationMs, sampleRate } = saved.take!;
  const rawMs = (saved.rawSamples! / sampleRate) * 1000;
  expect(rawMs).toBeGreaterThanOrEqual(1_000);
  expect(rawMs).toBeLessThanOrEqual(3_000);
  expect(durationMs).toBeGreaterThanOrEqual(2_000);
  expect(durationMs).toBeLessThanOrEqual(4_000);
  expect(durationMs).toBeGreaterThanOrEqual(Math.floor(rawMs));

  // Record remounting with the banner showing announces it again: via its link to the Library
  // and back.
  await page.evaluate(() => {
    const w = window as unknown as { __assertive: string[] };
    w.__assertive = [];
    const region = document.querySelector('[role="alert"][aria-live="assertive"]')!;
    new MutationObserver(() => {
      const text = region.textContent ?? '';
      if (text) w.__assertive.push(text);
    }).observe(region, { childList: true, characterData: true, subtree: true });
  });
  await link.click();
  await expect(page).toHaveURL(/#\/library$/);
  await page.getByRole('link', { name: 'Record', exact: true }).click();
  await expect(page).toHaveURL(/#\/record$/);
  await expect(storageBanner(page)).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __assertive: string[] }).__assertive))
    .toEqual([STORAGE_FULL]);

  // The banner shows until the next take starts.
  await page.evaluate(() => {
    (window as unknown as { __storageFullHook: boolean }).__storageFullHook = false;
  });
  await recordButton(page).click();
  await expect(storageBanner(page)).toHaveCount(0);
  await expect(timer(page)).toHaveText('0:01', { timeout: 5_000 });
  await stopButton(page).click();
  await tabTakeId(page);
  expect(errors).toEqual([]);
});
