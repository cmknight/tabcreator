import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { devices, expect, type Browser, type Page, type Response } from '@playwright/test';
import type { Tab, Take } from '../../src/model/types';
import { strings } from '../../src/ui/strings';
import { watchHygiene } from './hygiene';
import { backupButton, heading, restoreButton, row } from './library-helpers';
import {
  loopPcm,
  readFixtureWav,
  restoreSeed,
  seedAnalysedTake,
  seedBackup,
  wavFile,
} from './seed-helpers';
import { opfsFileBase64, opfsFiles, readTab, readTakes } from './storage-helpers';

// Story "Latency gates and backup on the production build" (Library retro B4, DS12): backup and
// restore on the production build, under its CSP, with the built backup-worker chunk, at the root
// (backup-restore.spec.ts, `chromium` project) and under /tabcreator/
// (backup-restore-subpath.spec.ts, `subpath` project). The library is seeded through Restore
// from backup (seed-helpers.ts): an analysed take with WAV audio and a tab, and a tab-less take
// with no audio. Back up library downloads a zip; restored into a fresh context it reproduces
// every take, tab and audio byte; restoring it again imports nothing. Both contexts stay clean
// (no CSP violation, refused load, failed or off-origin request), and each loads the
// `assets/backup-worker-*.js` chunk from under its base path.

const FIXTURE = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'testdata',
  'synth',
  'c_major_scale_pos1.wav',
);

/** The seeded ids: the take with audio and a tab, and the tab-less take with neither. */
const WITH_TAB = 'backup-with-tab';
const TAB_LESS = 'backup-tab-less';

/** The seed: 1 s of the fixture as WAV on a take with a small tab, and a recorded take. */
function seedZip(): Buffer {
  const { samples, sampleRate } = readFixtureWav(FIXTURE);
  const wav = wavFile(loopPcm(samples, sampleRate), sampleRate);
  const base = Date.now() - 10_000;
  const withTab = seedAnalysedTake({
    id: WITH_TAB,
    title: 'Backed up with a tab',
    notes: [
      {
        id: 'b-n1',
        startMs: 100,
        endMs: 400,
        midi: 45,
        confidence: 0.9,
        string: 5,
        fret: 0,
        locked: false,
        lowConfidence: false,
      },
      {
        id: 'b-n2',
        startMs: 500,
        endMs: 800,
        midi: 47,
        confidence: 0.3,
        string: 5,
        fret: 2,
        locked: false,
        lowConfidence: true,
      },
    ],
    createdAt: new Date(base).toISOString(),
  });
  const tabLess: Take = {
    ...withTab.take,
    id: TAB_LESS,
    title: 'Backed up without a tab',
    createdAt: new Date(base + 1000).toISOString(),
    updatedAt: new Date(base + 1000).toISOString(),
    status: 'recorded',
    analysisVersion: null,
  };
  return seedBackup([
    { take: { ...withTab.take, audioMime: 'audio/wav' }, audio: wav, tab: withTab.tab },
    { take: tabLess },
  ]);
}

/** What a restore must reproduce: every take and tab (as JSON) and every audio file's bytes. */
interface Library {
  takes: string;
  tabs: string;
  audio: Record<string, string | null>;
}

async function snapshot(page: Page): Promise<Library> {
  const takes = (await readTakes<Take>(page)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const tabs: (Tab | null)[] = [];
  for (const t of takes) tabs.push(await readTab<Tab>(page, t.id));
  const audio: Record<string, string | null> = {};
  for (const path of await opfsFiles(page)) {
    if (path.startsWith('audio/')) audio[path] = await opfsFileBase64(page, path);
  }
  return { takes: JSON.stringify(takes), tabs: JSON.stringify(tabs), audio };
}

/**
 * Records the page's own responses in `page`'s context from now on (not the service worker's:
 * its precache install fetches every chunk, the backup worker's too), to find the backup
 * worker's chunk among them. Started just before the action that must load it, so a load by an
 * earlier step (the seed's restore) cannot satisfy the check.
 */
function responsesFromNow(page: Page): Response[] {
  const seen: Response[] = [];
  page.context().on('response', (r) => {
    if (r.request().serviceWorker() === null) seen.push(r);
  });
  return seen;
}

/** Asserts the built backup-worker chunk loaded (status 200) from `assets/` under `baseURL`. */
function expectBackupWorker(seen: readonly Response[], baseURL: string) {
  const assets = new URL('assets/', baseURL).href;
  const chunk = seen.filter((r) => {
    const url = r.url();
    return url.startsWith(assets) && /^backup-worker-[\w-]+\.js$/.test(url.slice(assets.length));
  });
  expect(
    chunk.map((r) => r.status()),
    `assets/backup-worker-*.js under ${assets}`,
  ).toContain(200);
}

/** Opens the Library from a fresh start. */
async function openLibrary(page: Page) {
  await page.goto('./#/library');
  await expect(heading(page)).toBeVisible();
}

/**
 * The round trip: seed, back up, restore into a fresh context, compare, restore again; both
 * contexts clean and loading the backup worker under `baseURL`.
 */
export async function backupRestoreRoundTrip(page: Page, browser: Browser, baseURL: string) {
  const hygiene = await watchHygiene(page, baseURL);
  await openLibrary(page);
  await restoreSeed(page, seedZip(), { name: 'seed.zip', takes: 2 });
  await expect(row(page, WITH_TAB)).toBeVisible();
  await expect(row(page, TAB_LESS)).toBeVisible();
  await expect(row(page, TAB_LESS)).toContainText('Audio deleted');

  const original = await snapshot(page);
  expect(Object.keys(original.audio)).toEqual([`audio/${WITH_TAB}.wav`]);
  // By take id: the tab-less take first.
  expect(JSON.parse(original.tabs)).toEqual([null, expect.objectContaining({ takeId: WITH_TAB })]);

  // Back up starts its own backup worker: recorded from just before the click.
  const seen = responsesFromNow(page);
  const [download] = await Promise.all([page.waitForEvent('download'), backupButton(page).click()]);
  const zip = await readFile((await download.path())!);
  const name = download.suggestedFilename();
  expect(name).toMatch(/\.zip$/);
  expectBackupWorker(seen, baseURL);
  hygiene.expectClean();

  // A fresh profile: an empty library.
  // The project's device settings (Desktop Chrome, as every browser project uses), on the same
  // base URL.
  const fresh = await browser.newContext({ ...devices['Desktop Chrome'], baseURL });
  try {
    const other = await fresh.newPage();
    const otherHygiene = await watchHygiene(other, baseURL);
    await openLibrary(other);
    await expect(other.getByRole('heading', { name: 'No takes yet' })).toBeVisible();

    // Restore reads the picked file in its own backup worker and imports on Confirm: recorded
    // from just before the pick (restoreSeed picks the file, then confirms).
    const otherSeen = responsesFromNow(other);
    await restoreSeed(other, zip, { name, takes: 2 });
    await expect(row(other, WITH_TAB)).toBeVisible();
    await expect(row(other, TAB_LESS)).toContainText('Audio deleted');
    expect(await snapshot(other)).toEqual(original);

    // The same file again: nothing new, so no dialog; nothing imported, nothing changed.
    const [chooser] = await Promise.all([
      other.waitForEvent('filechooser'),
      restoreButton(other).click(),
    ]);
    await chooser.setFiles({ name, mimeType: 'application/zip', buffer: zip });
    await expect(other.getByTestId('toast')).toContainText(strings['library.restored'](0, 2), {
      timeout: 15_000,
    });
    await expect(other.getByRole('alertdialog')).toHaveCount(0);
    await expect(restoreButton(other)).toHaveText('Restore from backup');
    expect(await snapshot(other)).toEqual(original);

    expectBackupWorker(otherSeen, baseURL);
    otherHygiene.expectClean();
  } finally {
    await fresh.close();
  }
}
