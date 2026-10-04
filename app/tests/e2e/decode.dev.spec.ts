import { expect, test, type Page } from '@playwright/test';
import { FIXTURE, goLive, held } from './mic-helpers';

// Ticket 12 (AD-15; Recording retro A5): a `recorded` take whose raw file is gone analyses from
// its compressed audio, decoded at the take's rate (`audio/decode.ts`), from the recorded webm
// and from a WAV-fallback copy; and a take saved by a failure stop (mic-lost) analyses when its
// Tab is opened. Runs in the `dev` project (the fake mic, `?holdAnalysis`, and the dev server's
// modules imported by URL).
//
// The WAV copy is checked strictly against the raw path: with analysis held, the test runs the
// app's own engine client on the take's raw file in the page, with the same input
// (`engineInput`) and the same fret mapping (notes with no playable position dropped) as
// `session/analysis.ts`; the raw file is then deleted and the Tab opened without hold, so the
// app analyses the decoded WAV, and the stored tab must hold the same notes, each starting within
// one frame. The recorded webm is lossy (Opus splits or merges notes) and offset 3–17 ms from the
// raw file, so it is checked only to analyse and find notes (user decision, 2026-10-04).

/**
 * One analysis frame, ms: the engine's hop (`HOP_LENGTH` = 256 samples, engine/src/pyin.rs) at
 * its analysis rate (`TARGET_RATE` = `SAMPLE_RATE` = 22 050 Hz, engine/src/preprocess.rs and
 * pyin.rs), about 11.6 ms.
 */
const ENGINE_HOP = 256;
const ENGINE_RATE = 22_050;
const FRAME_MS = (ENGINE_HOP / ENGINE_RATE) * 1000;
/** The engine reports `startMs` rounded to whole ms, so two starts differ by up to 1 ms more. */
const START_ROUNDING_MS = 1;

interface NoteKey {
  midi: number;
  startMs: number;
}

interface TakeState {
  status: string | null;
  audioMime: string | null;
  stopReason: string | null;
  rawExists: boolean;
  /** The saved tab's notes, by start; null when there is no tab. */
  notes: NoteKey[] | null;
}

const recordButton = (page: Page) => page.getByRole('button', { name: 'Record', exact: true });
const stopButton = (page: Page) => page.getByRole('button', { name: 'Stop', exact: true });
const systems = (page: Page) => page.getByTestId('tab-systems');

/** The take's status, audio type and stop reason, whether its raw file exists, and its notes. */
function readState(page: Page, id: string): Promise<TakeState> {
  return page.evaluate(async (takeId) => {
    const get = (store: string) =>
      new Promise<unknown>((resolve, reject) => {
        const open = indexedDB.open('tabcreator');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const req = db.transaction(store).objectStore(store).get(takeId);
          req.onsuccess = () => {
            resolve(req.result ?? null);
            db.close();
          };
          req.onerror = () => reject(req.error);
        };
      });
    const take = (await get('takes')) as {
      status: string;
      audioMime: string | null;
      stopReason?: string;
    } | null;
    const tab = (await get('tabs')) as { notes: NoteKey[] } | null;
    let rawExists = true;
    try {
      const root = await navigator.storage.getDirectory();
      await (await root.getDirectoryHandle('raw')).getFileHandle(`${takeId}.f32`);
    } catch {
      rawExists = false;
    }
    return {
      status: take?.status ?? null,
      audioMime: take?.audioMime ?? null,
      stopReason: take?.stopReason ?? null,
      rawExists,
      notes: tab
        ? [...tab.notes]
            .sort((a, b) => a.startMs - b.startMs)
            .map(({ midi, startMs }) => ({ midi, startMs }))
        : null,
    };
  }, id);
}

/** Records about 3 s with analysis held and stops; returns the take id once it is saved. */
async function recordHeldTake(page: Page): Promise<string> {
  await recordButton(page).click();
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('timer')).toHaveText('0:03', { timeout: 6_000 });
  await stopButton(page).click();
  await expect(page).toHaveURL(/#\/tab\/[^/]+$/, { timeout: 15_000 });
  const id = decodeURIComponent(new URL(page.url()).hash.slice('#/tab/'.length));
  await expect(page.locator(`[data-take-id="${id}"]`)).toBeVisible();
  await expect.poll(async () => (await readState(page, id)).status).toBe('recorded');
  return id;
}

/**
 * The raw path's notes for the take, by start: its raw file through the app's engine client,
 * with the app's engine input and fret mapping, as `session/analysis.ts` runs them (analysis is
 * held, so the app itself never runs it).
 */
function rawReference(page: Page, id: string): Promise<NoteKey[]> {
  return page.evaluate(async (takeId) => {
    const load = <T>(path: string) => import(/* @vite-ignore */ path) as Promise<T>;
    const { engineClient } = await load<typeof import('../../src/engine/engine-client')>(
      '/src/engine/engine-client.ts',
    );
    const { engineInput } = await load<typeof import('../../src/session/analysis')>(
      '/src/session/analysis.ts',
    );
    const { db } = await load<typeof import('../../src/storage/db')>('/src/storage/db.ts');
    const { audioStore } = await load<typeof import('../../src/storage/audio-store')>(
      '/src/storage/audio-store.ts',
    );
    const take = (await db.getTake(takeId))!;
    const pcm = await audioStore.readRaw(takeId);
    const result = await engineClient.analyze(
      takeId,
      pcm,
      take.sampleRate,
      engineInput(take),
      () => {},
    );
    const positions = await engineClient.mapFrets(
      takeId,
      result.notes.map(({ midi, startMs, endMs }) => ({ midi, startMs, endMs })),
      [],
      take.settings.maxFret,
    );
    return result.notes
      .filter((_, i) => positions[i])
      .map(({ midi, startMs }) => ({ midi, startMs }))
      .sort((a, b) => a.startMs - b.startMs);
  }, id);
}

/** Deletes the take's raw file from OPFS, as if it were gone. */
function deleteRawFile(page: Page, id: string): Promise<void> {
  return page.evaluate(async (takeId) => {
    const root = await navigator.storage.getDirectory();
    await (await root.getDirectoryHandle('raw')).removeEntry(`${takeId}.f32`);
  }, id);
}

/** The names in OPFS `raw/`. */
function rawFiles(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const raw = (await root.getDirectoryHandle('raw')) as unknown as {
      keys(): AsyncIterable<string>;
    };
    const names: string[] = [];
    for await (const name of raw.keys()) names.push(name);
    return names;
  });
}

/**
 * Replaces the take's compressed webm with a 16-bit WAV of its own raw PCM, written by the app's
 * `encodeWavBlob` (recovery's fallback format), and records `audio/wav` as its audio type.
 */
function swapToWav(page: Page, id: string): Promise<void> {
  return page.evaluate(async (takeId) => {
    const load = <T>(path: string) => import(/* @vite-ignore */ path) as Promise<T>;
    const { encodeWavBlob } =
      await load<typeof import('../../src/audio/encode')>('/src/audio/encode.ts');
    const { db } = await load<typeof import('../../src/storage/db')>('/src/storage/db.ts');
    const take = (await db.getTake(takeId))!;
    const root = await navigator.storage.getDirectory();
    const rawFile = await (await root.getDirectoryHandle('raw')).getFileHandle(`${takeId}.f32`);
    const pcm = new Float32Array(await (await rawFile.getFile()).arrayBuffer());
    const audio = await root.getDirectoryHandle('audio');
    const wav = await audio.getFileHandle(`${takeId}.wav`, { create: true });
    const writable = await wav.createWritable();
    await writable.write(encodeWavBlob(pcm, take.sampleRate));
    await writable.close();
    await audio.removeEntry(`${takeId}.webm`);
    await db.patchTake(takeId, { audioMime: 'audio/wav' }, 'library-session');
  }, id);
}

/** Opens the take's Tab without hold and waits for its analysed tab. */
async function openAndAnalyse(page: Page, id: string): Promise<TakeState> {
  await page.goto(`./#/tab/${encodeURIComponent(id)}`);
  await expect(page.locator(`[data-take-id="${id}"]`)).toBeVisible();
  await expect(systems(page)).toBeVisible({ timeout: 20_000 });
  await expect(systems(page).locator('pre').first()).toContainText('e|');
  return readState(page, id);
}

test('raw file gone: the take analyses from its webm and finds notes', async ({ page }) => {
  const errors = await goLive(page, held());
  const id = await recordHeldTake(page);

  await deleteRawFile(page, id);
  const state = await openAndAnalyse(page, id);
  expect(state).toMatchObject({
    status: 'analyzed',
    audioMime: 'audio/webm;codecs=opus',
    rawExists: false,
  });
  // Opus is lossy and the webm is offset from the raw file, so only analysing and finding notes
  // is required (user decision, 2026-10-04); the WAV test below checks the decode strictly.
  expect(state.notes!.length).toBeGreaterThan(0);
  // The decoded audio is never written back, and the raw file is never recreated.
  expect(await rawFiles(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('raw file gone, WAV-fallback copy: the take decodes and analyses (Recording retro A5)', async ({
  page,
}) => {
  const errors = await goLive(page, held());
  const id = await recordHeldTake(page);
  const reference = await rawReference(page, id);
  expect(reference.length).toBeGreaterThan(0);

  await swapToWav(page, id);
  await deleteRawFile(page, id);
  const state = await openAndAnalyse(page, id);
  expect(state).toMatchObject({ status: 'analyzed', audioMime: 'audio/wav', rawExists: false });
  // A 16-bit copy of the raw PCM at the take's rate: exactly the raw path's notes, each start
  // within one frame.
  const decoded = state.notes!;
  test
    .info()
    .annotations.push(
      { type: 'wav-reference-notes', description: JSON.stringify(reference) },
      { type: 'wav-decoded-notes', description: JSON.stringify(decoded) },
    );
  expect(decoded.map((n) => n.midi)).toEqual(reference.map((n) => n.midi));
  decoded.forEach((n, i) => {
    expect(Math.abs(n.startMs - reference[i]!.startMs)).toBeLessThanOrEqual(
      FRAME_MS + START_ROUNDING_MS,
    );
  });
  expect(await rawFiles(page)).toEqual([]);
  expect(errors).toEqual([]);
});

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

test('a take saved by a mic-lost stop analyses when its Tab is opened', async ({ page }) => {
  // As record.dev.spec.ts's unplug test: the scale on the first input, silence on the second.
  const errors = await goLive(page, held(`${FIXTURE},silence_60s`));
  await recordButton(page).click();
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('timer')).toHaveText('0:03', { timeout: 6_000 });
  await page.evaluate((device) => window.__fakeMic!.unplug(device), `fake-mic-${FIXTURE}`);
  await expect(page.getByTestId('toast')).toHaveText(
    'Microphone disconnected — recording stopped and saved',
    { timeout: 5_000 },
  );
  // A failure stop stays on Record: the take never reached its Tab.
  await expect(page).toHaveURL(/#\/record$/);
  await expect.poll(() => takeIds(page)).toHaveLength(1);
  const [id] = await takeIds(page);
  await expect.poll(async () => (await readState(page, id!)).status).toBe('recorded');
  expect(await readState(page, id!)).toMatchObject({
    stopReason: 'mic-lost',
    rawExists: true,
    notes: null,
  });

  const state = await openAndAnalyse(page, id!);
  expect(state).toMatchObject({ status: 'analyzed', stopReason: 'mic-lost', rawExists: false });
  expect(state.notes!.length).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
