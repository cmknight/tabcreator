import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { Tab, Take } from '../../src/model/types';
import { collectErrors, recordButton, stopButton, timer } from './helpers';
import { backupButton, heading, nav, restoreButton, row } from './library-helpers';
import { goLive } from './mic-helpers';
import { opfsFileBase64, opfsFiles, readTab, readTakes } from './storage-helpers';

// Story "Restore from a backup" (6.6, US-7.3, Flow 4): a backup of three takes (one with its
// audio deleted) restored into a fresh browser profile brings back every record, tab and audio
// file byte-for-byte; restoring it again imports nothing; a truncated zip or a manifest of
// another format shows the error banner and changes nothing. Restore from backup is enabled in
// the empty library while Back up library is not. Story "Restore validation and missing audio"
// (epic 7): a take whose audio is missing from the zip restores as "Audio deleted" (no playback),
// and a backup that was unzipped and re-zipped (a top-level folder, OS files) restores in full.

const toast = (page: Page) => page.getByTestId('toast');
const errorBanner = (page: Page) => page.getByTestId('restore-error');

/** Errors other than the dev-only warnings the app logs on purpose. */
const unexpected = (errors: string[]) => errors.filter((e) => !e.includes('[tabcreator]'));

/** Records about 2 s from Record and waits for its analysis to finish; returns the id. */
async function recordAndAnalyse(page: Page): Promise<string> {
  await nav(page, 'Record').click();
  await expect(recordButton(page)).toBeEnabled();
  await recordButton(page).click();
  await expect(stopButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(timer(page)).toHaveText('0:02', { timeout: 5_000 });
  await stopButton(page).click();
  await expect(page).toHaveURL(/#\/tab\/[^/]+$/, { timeout: 15_000 });
  await expect(
    page.getByTestId('tab-status-line').or(page.getByRole('heading', { name: 'No notes found' })),
  ).toBeVisible({ timeout: 30_000 });
  return decodeURIComponent(new URL(page.url()).hash.slice('#/tab/'.length));
}

async function openLibrary(page: Page): Promise<void> {
  await nav(page, 'Library').click();
  await expect(page).toHaveURL(/#\/library$/);
  await expect(heading(page)).toBeVisible();
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

/** Picks `buffer` as `name` through Restore from backup's file picker. */
async function restoreFile(page: Page, name: string, buffer: Buffer): Promise<void> {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    restoreButton(page).click(),
  ]);
  await chooser.setFiles({ name, mimeType: 'application/zip', buffer });
}

/** Confirms the Restore dialog and waits for the summary toast. */
async function confirmRestore(page: Page, n: number, name: string, summary: string) {
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText(`Restore ${n} ${n === 1 ? 'take' : 'takes'} from ${name}?`);
  await dialog.getByRole('button', { name: 'Restore' }).click();
  await expect(toast(page)).toContainText(summary, { timeout: 15_000 });
  await expect(restoreButton(page)).toHaveText('Restore from backup');
}

test('a backup restored into a fresh profile is byte-identical; again imports nothing; a truncated or format-2 file changes nothing', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const errors = await goLive(page);
  const ids = [
    await recordAndAnalyse(page),
    await recordAndAnalyse(page),
    await recordAndAnalyse(page),
  ];
  await openLibrary(page);

  // Delete the audio of the middle take (story 6.2): it is backed up, and restored, without it.
  const gone = ids[1]!;
  await row(page, gone)
    .getByRole('button', { name: /^More actions for / })
    .click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Delete audio only' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete audio' }).click();
  await expect(row(page, gone)).toContainText('Audio deleted');
  await expect
    .poll(async () => (await opfsFiles(page)).filter((f) => f.includes(gone)))
    .toEqual([]);

  const [download] = await Promise.all([page.waitForEvent('download'), backupButton(page).click()]);
  const zip = await readFile((await download.path())!);
  const name = download.suggestedFilename();
  const original = await snapshot(page);
  expect(Object.keys(original.audio)).toHaveLength(2);
  expect(unexpected(errors)).toEqual([]);

  // A fresh profile: an empty library.
  const fresh = await browser.newContext({ baseURL });
  const other = await fresh.newPage();
  const otherErrors = collectErrors(other);
  await other.goto('./#/library');
  await expect(heading(other)).toBeVisible();
  await expect(other.getByRole('heading', { name: 'No takes yet' })).toBeVisible();
  await expect(restoreButton(other)).toBeEnabled();
  await expect(restoreButton(other)).not.toHaveAttribute('aria-disabled', 'true');
  await expect(backupButton(other)).toBeDisabled();

  await restoreFile(other, name, zip);
  await confirmRestore(other, 3, name, 'Imported 3 takes');
  await expect(toast(other)).not.toContainText('skipped');
  for (const id of ids) await expect(row(other, id)).toBeVisible();
  await expect(row(other, gone)).toContainText('Audio deleted');
  expect(await snapshot(other)).toEqual(original);

  // The same file again: nothing new, so no dialog; nothing imported, nothing changed.
  await restoreFile(other, name, zip);
  await expect(toast(other)).toContainText('Imported 0 takes, skipped 3 already in your library', {
    timeout: 15_000,
  });
  await expect(other.getByRole('alertdialog')).toHaveCount(0);
  await expect(restoreButton(other)).toHaveText('Restore from backup');
  expect(await snapshot(other)).toEqual(original);

  // A truncated copy: the error banner, no dialog, nothing changed.
  await restoreFile(other, name, zip.subarray(0, zip.length - 200));
  await expect(errorBanner(other)).toHaveText(
    "That file isn't a TabCreator backup — nothing was changed.",
  );
  await expect(other.getByRole('alertdialog')).toHaveCount(0);
  expect(await snapshot(other)).toEqual(original);

  // A manifest of format 2: the same.
  const entries = unzipSync(new Uint8Array(zip));
  const manifest = JSON.parse(strFromU8(entries['manifest.json']!)) as { format: number };
  entries['manifest.json'] = strToU8(JSON.stringify({ ...manifest, format: 2 }));
  const format2 = Buffer.from(zipSync(entries, { level: 0 }));
  await restoreFile(other, 'format-2.zip', format2);
  await expect(errorBanner(other)).toHaveText(
    "That file isn't a TabCreator backup — nothing was changed.",
  );
  await expect(other.getByRole('alertdialog')).toHaveCount(0);
  expect(await snapshot(other)).toEqual(original);

  expect(unexpected(otherErrors)).toEqual([]);
  await fresh.close();
});

test('cancelling the Confirm dialog changes nothing', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('./#/library');
  await expect(heading(page)).toBeVisible();
  // One take with no audio and no tab, so there is something new to confirm (analysed: a
  // recorded take always has audio).
  const take: Take = {
    id: 'cancel-1',
    title: 'Take to cancel',
    createdAt: '2026-10-01T10:00:00.000Z',
    status: 'analyzed',
    durationMs: 2000,
    sampleRate: 48_000,
    tuning: 'EADGBE',
    micLabel: 'Mic',
    audioMime: null,
    trimStartMs: 0,
    trimEndMs: null,
    settings: { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 },
    analysisVersion: '1',
    updatedAt: '2026-10-01T10:00:00.000Z',
  };
  const zip = Buffer.from(
    zipSync({
      'manifest.json': strToU8(
        JSON.stringify({
          format: 1,
          exportedAt: new Date().toISOString(),
          takes: [take],
          tabs: [],
        }),
      ),
    }),
  );
  await restoreFile(page, 'one.zip', zip);
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Restore 1 take from one.zip?');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(restoreButton(page)).toBeFocused();
  await expect(toast(page)).toHaveCount(0);
  await expect(errorBanner(page)).toHaveCount(0);
  expect(await readTakes(page)).toEqual([]);
  expect(unexpected(errors)).toEqual([]);
});

/** A stored analysed take for a hand-built backup, with an audio type. */
function backupTake(id: string, createdAt: string): Take {
  return {
    id,
    title: `Take ${id}`,
    createdAt,
    status: 'analyzed',
    durationMs: 2000,
    sampleRate: 48_000,
    tuning: 'EADGBE',
    micLabel: 'Mic',
    audioMime: 'audio/webm;codecs=opus',
    trimStartMs: 0,
    trimEndMs: null,
    settings: { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 },
    analysisVersion: '1',
    updatedAt: createdAt,
  };
}

function backupTab(takeId: string): Tab {
  return {
    takeId,
    notes: [
      {
        id: `${takeId}-n1`,
        startMs: 100,
        endMs: 400,
        midi: 40,
        confidence: 0.9,
        string: 6,
        fret: 0,
        locked: false,
        lowConfidence: false,
      },
    ],
    updatedAt: '2026-10-01T10:00:00.000Z',
    deletedStartMs: [],
  };
}

test('a re-zipped backup restores every take; a take whose audio is missing shows "Audio deleted" with no playback', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('./#/library');
  await expect(heading(page)).toBeVisible();
  const kept = backupTake('kept-1', '2026-10-01T10:00:00.000Z');
  const missing = backupTake('missing-1', '2026-10-02T10:00:00.000Z');
  const audio = new Uint8Array([1, 2, 3, 4, 5]);
  // As an OS writes a backup it unzipped and zipped again: one top-level folder, its own files.
  const folder = 'tabcreator-backup-20261007';
  const zip = Buffer.from(
    zipSync({
      [`${folder}/manifest.json`]: strToU8(
        JSON.stringify({
          format: 1,
          schemaVersion: 3,
          exportedAt: '2026-10-07T10:00:00.000Z',
          takes: [kept, missing],
          tabs: [backupTab('kept-1'), backupTab('missing-1')],
        }),
      ),
      [`${folder}/audio/kept-1.webm`]: audio,
      [`${folder}/.DS_Store`]: new Uint8Array([0]),
      [`${folder}/audio/Thumbs.db`]: new Uint8Array([0]),
      [`__MACOSX/${folder}/._manifest.json`]: new Uint8Array([0]),
    }),
  );
  await restoreFile(page, 'rezipped.zip', zip);
  await confirmRestore(page, 2, 'rezipped.zip', 'Imported 2 takes');
  await expect(row(page, 'kept-1')).toBeVisible();
  await expect(row(page, 'kept-1')).not.toContainText('Audio deleted');
  await expect(row(page, 'missing-1')).toContainText('Audio deleted');
  const takes = await readTakes<Take>(page);
  expect(Object.fromEntries(takes.map((t) => [t.id, t.audioMime]))).toEqual({
    'kept-1': 'audio/webm;codecs=opus',
    'missing-1': null,
  });
  expect((await opfsFiles(page)).filter((f) => f.startsWith('audio/'))).toEqual([
    'audio/kept-1.webm',
  ]);

  // Its Tab offers no playback.
  await row(page, 'missing-1').getByRole('link').click();
  const play = page
    .getByRole('group', { name: 'Playback' })
    .getByRole('button', { name: /^(Play|Pause)$/ });
  await expect(play).toBeDisabled();
  await expect(play).toHaveAccessibleDescription('Audio deleted');
  expect(unexpected(errors)).toEqual([]);
});

// Story "Streaming restore and restore races" (epic 7): the central-directory reader restores
// zips an OS or another tool makes: the manifest as the last entry, audio stored or deflated.
test('a zip with its manifest last and deflated audio restores byte-identical', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('./#/library');
  await expect(heading(page)).toBeVisible();
  const stored = backupTake('stored-1', '2026-10-01T10:00:00.000Z');
  const deflated = backupTake('deflated-1', '2026-10-02T10:00:00.000Z');
  // Audio-like bytes that deflate well, so the deflated entry is truly compressed.
  const storedAudio = new Uint8Array(300_000).map((_, i) => (i * 31) % 253);
  const deflatedAudio = new Uint8Array(400_000).map((_, i) => (i >> 4) % 7);
  const zip = Buffer.from(
    zipSync({
      'audio/stored-1.webm': [storedAudio, { level: 0 }],
      'audio/deflated-1.webm': [deflatedAudio, { level: 6 }],
      'manifest.json': [
        strToU8(
          JSON.stringify({
            format: 1,
            schemaVersion: 3,
            exportedAt: '2026-10-07T10:00:00.000Z',
            takes: [stored, deflated],
            tabs: [backupTab('stored-1'), backupTab('deflated-1')],
          }),
        ),
        { level: 6 },
      ],
    }),
  );
  // The fixture really is manifest-last with a deflated audio entry.
  expect(zip.indexOf('manifest.json')).toBeGreaterThan(zip.indexOf('audio/deflated-1.webm'));
  expect(zip.length).toBeLessThan(storedAudio.length + deflatedAudio.length / 2);

  await restoreFile(page, 'other-tool.zip', zip);
  await confirmRestore(page, 2, 'other-tool.zip', 'Imported 2 takes');
  await expect(row(page, 'stored-1')).not.toContainText('Audio deleted');
  await expect(row(page, 'deflated-1')).not.toContainText('Audio deleted');
  expect(await opfsFileBase64(page, 'audio/stored-1.webm')).toBe(
    Buffer.from(storedAudio).toString('base64'),
  );
  expect(await opfsFileBase64(page, 'audio/deflated-1.webm')).toBe(
    Buffer.from(deflatedAudio).toString('base64'),
  );
  expect(unexpected(errors)).toEqual([]);
});
