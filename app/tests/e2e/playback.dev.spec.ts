import { expect, test, type Page } from '@playwright/test';
import { goLive } from './mic-helpers';
import { makeNotes, noteButton, openSeededTab, seedTab, type SeedTake } from './tab-helpers';

// Story "Playback with a following cursor" (US-6.5): one test per row of the plan's I/O matrix
// from Cursor 1× to Trim, in the `dev` project (the fake mic, the DEV-only
// `window.__playbackTrace`, and the seeding import of the dev server's modules).
//
// Cursor timing is checked on the media clock (the plan's Design Notes): `audio.currentTime` read
// once the outline moved to a note is committed, against that note's `startMs`. Seeks are read
// at the element's `seeking` event, where `currentTime` is the seek target.

/** The fake-mic fixture is 7.95 s of the C major scale. */
const RECORD_SECONDS = '0:08';
/** The cursor lands at or after a note's onset, and within this much of it on the media clock. */
const CURSOR_BOUND_MS = 50;
/** A seek lands this close to 100 ms before the note. */
const SEEK_TOLERANCE_MS = 30;

const recordButton = (page: Page) => page.getByRole('button', { name: 'Record', exact: true });
const stopButton = (page: Page) => page.getByRole('button', { name: 'Stop', exact: true });
const playButton = (page: Page) =>
  page.getByRole('group', { name: 'Playback' }).getByRole('button', { name: /^(Play|Pause)$/ });

interface TraceEntry {
  noteId: string;
  mediaMs: number;
}

/** Records about 8 s of the scale from the fake mic and waits for its analysed tab. */
async function recordScale(page: Page): Promise<string> {
  await goLive(page);
  await recordButton(page).click();
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('timer')).toHaveText(RECORD_SECONDS, { timeout: 12_000 });
  await stopButton(page).click();
  await expect(page).toHaveURL(/#\/tab\/[^/]+$/, { timeout: 15_000 });
  await expect(page.getByTestId('tab-status-line')).toBeVisible({ timeout: 30_000 });
  await expect(playButton(page)).toBeEnabled();
  return decodeURIComponent(new URL(page.url()).hash.slice('#/tab/'.length));
}

/** The saved tab's note starts by id. */
function noteStarts(page: Page, id: string): Promise<Record<string, number>> {
  return page.evaluate(
    (takeId) =>
      new Promise<Record<string, number>>((resolve, reject) => {
        const open = indexedDB.open('tabcreator');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const get = db.transaction('tabs').objectStore('tabs').get(takeId);
          get.onsuccess = () => {
            const notes = (get.result?.notes ?? []) as { id: string; startMs: number }[];
            resolve(Object.fromEntries(notes.map((n) => [n.id, n.startMs])));
            db.close();
          };
          get.onerror = () => reject(get.error);
        };
      }),
    id,
  );
}

/** Starts recording the `<audio>` element's seek targets (ms) in `window.__seeks`. */
function watchSeeks(page: Page): Promise<void> {
  return page.evaluate(() => {
    const w = window as unknown as { __seeks: number[] };
    w.__seeks = [];
    const audio = document.querySelector('audio')!;
    audio.addEventListener('seeking', () => w.__seeks.push(audio.currentTime * 1000));
  });
}

function seeks(page: Page): Promise<number[]> {
  return page.evaluate(() => (window as unknown as { __seeks: number[] }).__seeks);
}

/** The `<audio>` element's state. */
function audioState(page: Page) {
  return page.evaluate(() => {
    const a = document.querySelector('audio')!;
    return {
      paused: a.paused,
      currentMs: a.currentTime * 1000,
      playbackRate: a.playbackRate,
      preservesPitch: a.preservesPitch,
    };
  });
}

/** Plays the whole take at `speed` and checks every cursor change against its note's onset. */
async function checkCursor(page: Page, speed: '1×' | '0.75×'): Promise<void> {
  const id = await recordScale(page);
  const starts = await noteStarts(page, id);
  const noteCount = Object.keys(starts).length;
  expect(noteCount).toBeGreaterThan(5);
  if (speed !== '1×')
    await page.getByRole('button', { name: `${parseFloat(speed)} times speed` }).click();
  await page.evaluate(() => {
    window.__playbackTrace = [];
  });
  await playButton(page).click();
  await expect(playButton(page)).toHaveAttribute('aria-label', 'Pause');
  // The take plays to its end (about 8 s at 1×, 10.7 s at 0.75×), then Play shows again.
  await expect(playButton(page)).toHaveAttribute('aria-label', 'Play', { timeout: 20_000 });
  const trace = await page.evaluate(() => window.__playbackTrace ?? []);
  test.info().annotations.push({ type: 'playback-trace', description: JSON.stringify(trace) });
  // Playing from 0:00 to the end crosses every onset inside the media. A note may be skipped
  // only when the next starts so soon after it that no frame falls between them; any frame gap
  // is within the cursor bound checked below, so a skipped note's successor starts within it.
  const endMs = await page.evaluate(() => document.querySelector('audio')!.duration * 1000);
  const played = Object.entries(starts)
    .filter(([, start]) => start < endMs)
    .sort((a, b) => a[1] - b[1]);
  const traced = new Set((trace as TraceEntry[]).map((t) => t.noteId));
  played.forEach(([id, start], i) => {
    if (traced.has(id)) return;
    const next = played[i + 1];
    expect(next, `note ${id} at ${start} ms was never outlined`).toBeDefined();
    expect(next![1] - start, `note ${id} at ${start} ms was never outlined`).toBeLessThanOrEqual(
      CURSOR_BOUND_MS,
    );
  });
  for (const { noteId, mediaMs } of trace as TraceEntry[]) {
    const start = starts[noteId];
    expect(start, `note ${noteId}`).toBeDefined();
    const lag = mediaMs - start!;
    expect(lag, `note ${noteId}`).toBeGreaterThanOrEqual(0);
    expect(lag, `note ${noteId}`).toBeLessThanOrEqual(CURSOR_BOUND_MS);
  }
  // The end clears the cursor.
  await expect(page.locator('[data-playing]')).toHaveCount(0);
}

/**
 * Seeds an analysed take (`makeNotes()`: 40 notes from 1.5 s, 250 ms apart, over 13 s) with a
 * compressed audio file: a 13 s WAV of a 220 Hz tone written with the app's `encodeWavBlob`, as
 * decode.dev.spec.ts does. Opens its Tab screen once the audio has loaded; returns the take id.
 */
async function openTakeWithAudio(page: Page, extra: SeedTake = {}): Promise<string> {
  await page.goto('./#/library');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  const id = await seedTab(page, makeNotes(), 'Seeded with audio', {
    audioMime: 'audio/wav',
    ...extra,
  });
  await page.evaluate(async (takeId) => {
    const path = '/src/audio/encode.ts';
    const { encodeWavBlob } = (await import(
      /* @vite-ignore */ path
    )) as typeof import('../../src/audio/encode');
    const rate = 48_000;
    const pcm = new Float32Array(rate * 13);
    for (let i = 0; i < pcm.length; i++) pcm[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / rate);
    const root = await navigator.storage.getDirectory();
    const audio = await root.getDirectoryHandle('audio', { create: true });
    const file = await audio.getFileHandle(`${takeId}.wav`, { create: true });
    const writable = await file.createWritable();
    await writable.write(encodeWavBlob(pcm, rate));
    await writable.close();
  }, id);
  await page.goto(`./#/tab/${encodeURIComponent(id)}`);
  await expect(playButton(page)).toBeEnabled();
  await page.waitForFunction(() => (document.querySelector('audio')?.readyState ?? 0) >= 1);
  await watchSeeks(page);
  return id;
}

/** `makeNotes()`'s note `i` starts at 1.5 s + i × 250 ms. */
const startOf = (i: number) => 1500 + i * 250;
const noteId = (i: number) => `note-${String(i).padStart(2, '0')}`;

test('Cursor 1×: every cursor change lands within 50 ms of its note on the media clock', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await checkCursor(page, '1×');
});

test('Cursor 0.75×: the same bound on the media clock', async ({ page }) => {
  test.setTimeout(90_000);
  await checkCursor(page, '0.75×');
});

test('Click seek: a note clicked while playing seeks 100 ms before it and keeps playing', async ({
  page,
}) => {
  await openTakeWithAudio(page);
  await playButton(page).click();
  await expect.poll(async () => (await audioState(page)).currentMs).toBeGreaterThan(300);
  await noteButton(page, noteId(20)).click();
  await expect.poll(() => seeks(page)).toHaveLength(1);
  const [target] = await seeks(page);
  expect(Math.abs(target! - (startOf(20) - 100))).toBeLessThanOrEqual(SEEK_TOLERANCE_MS);
  expect((await audioState(page)).paused).toBe(false);
  await expect(noteButton(page, noteId(20))).toHaveAttribute('aria-pressed', 'true');
  // Playing on from there: the cursor reaches the clicked note.
  await expect(noteButton(page, noteId(20))).toHaveAttribute('data-playing', 'true');
});

test('P seek: with a note selected, P seeks 100 ms before it and plays; no selection, nothing', async ({
  page,
}) => {
  await openTakeWithAudio(page);
  // No selection: P does nothing.
  await page.locator('body').press('p');
  expect((await audioState(page)).paused).toBe(true);
  expect(await seeks(page)).toEqual([]);
  // Select note 12 (paused: a click only selects), then P.
  await noteButton(page, noteId(12)).click();
  expect(await seeks(page)).toEqual([]);
  await page.keyboard.press('p');
  await expect.poll(() => seeks(page)).toHaveLength(1);
  const [target] = await seeks(page);
  expect(Math.abs(target! - (startOf(12) - 100))).toBeLessThanOrEqual(SEEK_TOLERANCE_MS);
  await expect.poll(async () => (await audioState(page)).paused).toBe(false);
  await expect(playButton(page)).toHaveAttribute('aria-label', 'Pause');
});

test('Space: toggles play / pause from the body and a focused note; not in the title field or on other buttons', async ({
  page,
}) => {
  await openTakeWithAudio(page);
  // The body.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press(' ');
  await expect.poll(async () => (await audioState(page)).paused).toBe(false);
  await page.keyboard.press(' ');
  await expect.poll(async () => (await audioState(page)).paused).toBe(true);
  // A focused note: Space plays and pauses, and never presses (seeks to) the note.
  await noteButton(page, noteId(3)).click();
  await page.keyboard.press(' ');
  await expect.poll(async () => (await audioState(page)).paused).toBe(false);
  await page.keyboard.press(' ');
  await expect.poll(async () => (await audioState(page)).paused).toBe(true);
  expect(await seeks(page)).toEqual([]);
  await expect(noteButton(page, noteId(3))).toBeFocused();
  // Another button keeps its native Space: a speed segment is pressed, playback stays paused.
  await page.getByRole('button', { name: '0.5 times speed' }).focus();
  await page.keyboard.press(' ');
  await expect(page.getByRole('button', { name: '0.5 times speed' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect((await audioState(page)).paused).toBe(true);
  // The title field: Space types.
  await page.getByRole('button', { name: 'Rename take' }).click();
  const field = page.getByRole('textbox', { name: 'Take title' });
  await field.press('End');
  await field.press(' ');
  await expect(field).toHaveValue('Seeded with audio ');
  expect((await audioState(page)).paused).toBe(true);
});

test('Speed: 0.75× sets the playback rate with pitch preserved', async ({ page }) => {
  await openTakeWithAudio(page);
  expect(await audioState(page)).toMatchObject({ playbackRate: 1, preservesPitch: true });
  await page.getByRole('button', { name: '0.75 times speed' }).click();
  await expect(page.getByRole('button', { name: '0.75 times speed' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(await audioState(page)).toMatchObject({ playbackRate: 0.75, preservesPitch: true });
  await playButton(page).click();
  await expect.poll(async () => (await audioState(page)).paused).toBe(false);
  expect(await audioState(page)).toMatchObject({ playbackRate: 0.75, preservesPitch: true });
});

test('No audio: Play disabled with "Audio deleted"; Space does nothing', async ({ page }) => {
  await openSeededTab(page);
  const play = playButton(page);
  await expect(play).toBeDisabled();
  await expect(play).toHaveAccessibleDescription('Audio deleted');
  await expect(page.locator('span[title="Audio deleted"]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '1 times speed' })).toBeEnabled();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press(' ');
  await expect(play).toHaveAttribute('aria-label', 'Play');
  expect(await page.evaluate(() => document.querySelector('audio')!.paused)).toBe(true);
});

test('Trim: playback starts at the trim start and pauses at the trim end', async ({ page }) => {
  await openTakeWithAudio(page, { trimStartMs: 1000, trimEndMs: 3000 });
  await playButton(page).click();
  // Play from 0:00 seeks to the trim start first.
  await expect.poll(async () => (await seeks(page)).length).toBeGreaterThan(0);
  expect((await seeks(page))[0]).toBeCloseTo(1000, 0);
  await expect(playButton(page)).toHaveAttribute('aria-label', 'Pause');
  await expect(playButton(page)).toHaveAttribute('aria-label', 'Play', { timeout: 5_000 });
  const state = await audioState(page);
  expect(state.paused).toBe(true);
  expect(state.currentMs).toBeCloseTo(3000, 0);
  await expect(page.locator('[data-playing]')).toHaveCount(0);
});
