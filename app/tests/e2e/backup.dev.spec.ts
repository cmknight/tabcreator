import { readFile } from 'node:fs/promises';
import { expect, test, type Download, type Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { extensionFor } from '../../src/model/audio-format';
import type { Tab, Take } from '../../src/model/types';
import { DB_VERSION } from '../../src/storage/migrations';
import { recordButton, stopButton, timer } from './helpers';
import { backupButton, heading, nav, row } from './library-helpers';
import { goLive } from './mic-helpers';
import { opfsFileBase64, opfsFiles, readTab, readTakes } from './storage-helpers';

// Story "Back up the library" (6.5, US-7.3, CAP-19): Back up library downloads
// `tabcreator-backup-YYYYMMDD.zip` with `manifest.json` (every take not still recording and its
// tab, exactly as stored) and each take's compressed audio, byte-identical (WAV included); a take
// whose audio was deleted has no entry. "Backing up…" and a progress bar show while it runs, with
// the button disabled. Story "Restore validation and missing audio" (epic 7): the manifest carries
// `schemaVersion`, and the toast says when unfinished (still recording) takes were left out. Story
// "Library robustness during backup and restore" (7.17): a refused delete during a held backup, and
// the "Your backup is ready" banner for a backup that finished off-screen.

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

interface Seen {
  label: string | null;
  value: number;
  valueText: string | null;
  buttonDisabled: string | null;
}

interface ProgressWatch {
  seen: Seen[];
  observer: MutationObserver;
}

/**
 * Records, on every DOM change while the backup panel shows, what it and Back up library (found
 * by role and name) show. `stopWatching` disconnects it and returns what it saw.
 */
async function watchProgress(page: Page): Promise<void> {
  const button = await backupButton(page).elementHandle();
  expect(button, 'the Back up library button').not.toBeNull();
  await page.evaluate((btn) => {
    const seen: Seen[] = [];
    const observer = new MutationObserver(() => {
      const panel = document.querySelector('[data-testid="backup-progress"]');
      if (!panel) return;
      const bar = panel.querySelector('progress')!;
      seen.push({
        label: panel.querySelector('label')?.textContent ?? null,
        value: bar.value,
        valueText: bar.getAttribute('aria-valuetext'),
        buttonDisabled: btn.getAttribute('aria-disabled'),
      });
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    (window as unknown as { __backupWatch: ProgressWatch }).__backupWatch = { seen, observer };
  }, button!);
}

function stopWatching(page: Page): Promise<Seen[]> {
  return page.evaluate(() => {
    const watch = (window as unknown as { __backupWatch: ProgressWatch }).__backupWatch;
    watch.observer.disconnect();
    return watch.seen;
  });
}

/** Clicks Back up library and returns the download and the zip's entries. */
async function backUp(page: Page): Promise<{
  download: Download;
  entries: Record<string, Uint8Array>;
}> {
  const [download] = await Promise.all([page.waitForEvent('download'), backupButton(page).click()]);
  const entries = unzipSync(new Uint8Array(await readFile((await download.path())!)));
  return { download, entries };
}

/** The file name the page's local date gives. */
const expectedName = (page: Page) =>
  page.evaluate(() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `tabcreator-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.zip`;
  });

/** Every stored take but recording ones, by createdAt, and their tabs, as stored. */
async function stored(page: Page): Promise<{ takes: Take[]; tabs: Tab[] }> {
  const takes = (await readTakes<Take>(page))
    .filter((t) => t.status !== 'recording')
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const tabs: Tab[] = [];
  for (const t of takes) {
    const tab = await readTab<Tab>(page, t.id);
    if (tab) tabs.push(tab);
  }
  return { takes, tabs };
}

/** Each entry under `audio/` equals the OPFS file at the same path, byte for byte. */
async function expectAudioIdentical(page: Page, entries: Record<string, Uint8Array>) {
  for (const [path, bytes] of Object.entries(entries)) {
    if (!path.startsWith('audio/')) continue;
    const opfs = await opfsFileBase64(page, path);
    expect(opfs, path).not.toBeNull();
    expect(Buffer.from(bytes).toString('base64'), path).toBe(opfs);
  }
}

test('three takes, one with its audio deleted: the zip holds the manifest as stored and byte-identical audio; progress shows meanwhile', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const errors = await goLive(page);
  const ids = [
    await recordAndAnalyse(page),
    await recordAndAnalyse(page),
    await recordAndAnalyse(page),
  ];
  await openLibrary(page);
  await expect(backupButton(page)).toBeEnabled();

  // Delete the audio of the middle take (story 6.2).
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

  await watchProgress(page);
  const { download, entries } = await backUp(page);
  expect(download.suggestedFilename()).toBe(await expectedName(page));

  // The manifest: every take and tab exactly as stored.
  const manifest = JSON.parse(strFromU8(entries['manifest.json']!)) as {
    format: number;
    schemaVersion: number;
    exportedAt: string;
    takes: Take[];
    tabs: Tab[];
  };
  const { takes, tabs } = await stored(page);
  expect(takes.map((t) => t.id).sort()).toEqual([...ids].sort());
  expect(manifest.format).toBe(1);
  expect(manifest.schemaVersion).toBe(DB_VERSION);
  expect(new Date(manifest.exportedAt).toISOString()).toBe(manifest.exportedAt);
  expect(manifest.takes).toEqual(takes);
  expect(manifest.tabs).toEqual(tabs);

  // Audio: one entry per take with audio, none for the deleted one; byte-identical.
  const withAudio = takes.filter((t) => t.audioMime !== null);
  expect(withAudio.map((t) => t.id).sort()).toEqual([ids[0]!, ids[2]!].sort());
  expect(Object.keys(entries).sort()).toEqual(
    [
      'manifest.json',
      ...withAudio.map((t) => `audio/${t.id}.${extensionFor(t.audioMime!)}`),
    ].sort(),
  );
  await expectAudioIdentical(page, entries);

  // While it ran: "Backing up…" and the bar (monotone), the button disabled; then both clear.
  const seen = await stopWatching(page);
  expect(seen.length).toBeGreaterThan(0);
  for (const s of seen) {
    expect(s.label).toBe('Backing up…');
    expect(s.valueText).toMatch(/^\d+%$/);
    expect(s.buttonDisabled).toBe('true');
  }
  const values = seen.map((s) => s.value);
  expect(values).toEqual([...values].sort((a, b) => a - b));
  await expect(page.getByTestId('backup-progress')).toHaveCount(0);
  await expect(backupButton(page)).not.toHaveAttribute('aria-disabled', 'true');
  await expect(backupButton(page)).toBeEnabled();
  expect(unexpected(errors)).toEqual([]);
});

test('with only a recording take, nothing to back up; once rebuilt as WAV (the encodePcm fail hook) its audio/<id>.wav is byte-identical', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await goLive(page);
  // Reload mid-take: the take stays in status recording until recovered.
  await recordButton(page).click();
  await expect(timer(page)).toHaveText('0:02', { timeout: 20_000 });
  page.on('dialog', (dialog) => void dialog.accept());
  await page.reload();
  const banner = page.getByTestId('recovered-take-banner');
  await expect(banner).toHaveCount(1, { timeout: 10_000 });
  const [take] = await readTakes<Take>(page);
  expect(take!.status).toBe('recording');

  // A recording take is in progress or unrecovered: it is never backed up, so with only it
  // there is nothing to back up.
  await openLibrary(page);
  await expect(row(page, take!.id)).toBeVisible();
  await expect(backupButton(page)).toBeDisabled();

  // Open with the re-encode failing: the take is rebuilt as WAV; its Tab analyses it.
  await nav(page, 'Record').click();
  await page.evaluate(() => {
    (window as unknown as { __encodePcmFailHook: boolean }).__encodePcmFailHook = true;
  });
  await banner.first().getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(new RegExp(`#/tab/${take!.id}$`), { timeout: 20_000 });
  await page.evaluate(() => {
    (window as unknown as { __encodePcmFailHook: boolean }).__encodePcmFailHook = false;
  });
  await expect
    .poll(async () => (await readTakes<Take>(page))[0], { timeout: 30_000 })
    .toMatchObject({ id: take!.id, status: 'analyzed', audioMime: 'audio/wav' });
  await expect.poll(() => opfsFiles(page)).toEqual([`audio/${take!.id}.wav`]);

  await openLibrary(page);
  const { entries } = await backUp(page);
  expect(Object.keys(entries).sort()).toEqual([`audio/${take!.id}.wav`, 'manifest.json']);
  await expectAudioIdentical(page, entries);
  const manifest = JSON.parse(strFromU8(entries['manifest.json']!)) as {
    takes: Take[];
    tabs: Tab[];
  };
  const { takes, tabs } = await stored(page);
  expect(manifest.takes).toEqual(takes);
  expect(manifest.tabs).toEqual(tabs);
  expect(unexpected(errors)).toEqual([]);
});

test('an unfinished take is left out of the backup, and the toast says how to recover it', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await goLive(page);
  const done = await recordAndAnalyse(page);
  // Reload mid-take: the second take stays in status recording until recovered.
  await nav(page, 'Record').click();
  await expect(recordButton(page)).toBeEnabled();
  await recordButton(page).click();
  await expect(timer(page)).toHaveText('0:02', { timeout: 20_000 });
  page.on('dialog', (dialog) => void dialog.accept());
  await page.reload();
  await expect(page.getByTestId('recovered-take-banner')).toHaveCount(1, { timeout: 10_000 });
  const unfinished = (await readTakes<Take>(page)).find((t) => t.status === 'recording');
  expect(unfinished).toBeDefined();

  await openLibrary(page);
  await expect(row(page, unfinished!.id)).toBeVisible();
  const { entries } = await backUp(page);
  const manifest = JSON.parse(strFromU8(entries['manifest.json']!)) as { takes: Take[] };
  expect(manifest.takes.map((t) => t.id)).toEqual([done]);
  await expect(page.getByTestId('toast')).toContainText(
    '1 unfinished take not backed up — open it from Record to recover',
  );
  expect(unexpected(errors)).toEqual([]);
});

// Story "Library robustness during backup and restore" (7.17): library-session refuses writes while
// a backup runs, and keeps a backup that finished off-screen for the next visit. The dev hook
// `__holdBackupHook` holds the backup open (`__holdBackupHeld` is true while it does).
interface HoldHooks {
  __holdBackupHook?: boolean;
  __holdBackupHeld?: boolean;
}

const setHold = (page: Page, on: boolean) =>
  page.evaluate((value) => {
    (window as unknown as HoldHooks).__holdBackupHook = value;
  }, on);
const held = (page: Page) =>
  page.evaluate(() => (window as unknown as HoldHooks).__holdBackupHeld === true);

test('a delete during a held backup is refused with its reason and the take survives; the backup, finished off-screen, is offered on return', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await goLive(page);
  const id = await recordAndAnalyse(page);
  await openLibrary(page);
  await setHold(page, true);

  // The Delete take dialog is opened before Back up starts (the menu's items are disabled once it
  // runs), then Back up is clicked behind it (a DOM click: no pointer-down on the scrim).
  await row(page, id)
    .getByRole('button', { name: /^More actions for / })
    .click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Delete take' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await backupButton(page).evaluate((button: HTMLElement) => button.click());
  await expect(page.getByTestId('backup-progress')).toBeVisible();

  await dialog.getByRole('button', { name: 'Delete take' }).click();
  await expect(page.getByTestId('toast')).toContainText('Wait for the backup to finish');
  await expect(row(page, id)).toBeVisible();
  expect((await readTakes<Take>(page)).map((t) => t.id)).toContain(id);

  // Leave the Library while the backup is held: nothing downloads then.
  let downloads = 0;
  page.on('download', () => downloads++);
  await expect.poll(() => held(page)).toBe(true);
  await nav(page, 'Record').click();
  await expect(page).toHaveURL(/#\/record$/);
  await setHold(page, false);
  await expect.poll(() => held(page)).toBe(false);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
  expect(downloads).toBe(0);

  // Back on the Library: the banner offers it; Download saves it and the banner goes.
  await openLibrary(page);
  const ready = page.getByTestId('backup-ready');
  await expect(ready).toContainText('Your backup is ready');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    ready.getByRole('button', { name: 'Download' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(await expectedName(page));
  const entries = unzipSync(new Uint8Array(await readFile((await download.path())!)));
  const manifest = JSON.parse(strFromU8(entries['manifest.json']!)) as { takes: Take[] };
  expect(manifest.takes.map((t) => t.id)).toEqual([id]);
  await expect(ready).toHaveCount(0);
  expect(downloads).toBe(1);
  expect(unexpected(errors)).toEqual([]);
});
