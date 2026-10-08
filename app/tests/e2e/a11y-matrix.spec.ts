import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { axeIn, seedTheme, THEMES, type Theme } from './a11y-helpers';
import { collectErrors } from './helpers';
import { watchHygiene } from './hygiene';
import { heading as libraryHeading, list, restoreButton, row } from './library-helpers';
import {
  loopPcm,
  readFixtureWav,
  restoreSeed,
  seedAnalysedTake,
  seedBackup,
  seedTake,
  wavFile,
  type SeedEntry,
} from './seed-helpers';
import { makeNotes, noteButton, selectedNote, tabArea } from './tab-helpers';
import { startUpdateServer } from './update-server';

// Story "Accessibility sweep: axe in both themes and keyboard-only flow" (CAP-21, US-8.2, the
// EXPERIENCE Accessibility Floor): every screen and state the production build can show without
// a microphone, checked by axe in Light and in Dark. Every group runs once per theme, the theme
// seeded as the stored pref before the first load, so the app applies it and each state is
// reached and rendered in it. One group also runs with the pref `system` on a dark OS (the
// `prefers-color-scheme` block of theme.css). States are reached through the UI, seeded takes
// (Restore from backup) and standard-API init scripts only; the live-mic states are in
// a11y-matrix.prod.spec.ts and the dev-hook-only ones in a11y-matrix.dev.spec.ts.

const FIXTURE_WAV = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'testdata',
  'synth',
  'c_major_scale_pos1.wav',
);

/** A WAV of the fixture looped to `ms`. */
function fixtureWav(ms: number): Buffer {
  const { samples, sampleRate } = readFixtureWav(FIXTURE_WAV);
  return wavFile(loopPcm(samples, Math.round((sampleRate * ms) / 1000)), sampleRate);
}

const IDS = {
  notes: 'a11y-notes',
  noNotes: 'a11y-no-notes',
  broken: 'a11y-broken',
  long: 'a11y-long',
} as const;

const NOTES = makeNotes(40, [3, 9]);
const created = (s: number) => new Date(Date.now() - 60_000 + s * 1000).toISOString();

/** An analysed take with its tab and a WAV of the fixture as its audio (so Trim and Re-analyse work). */
function notesEntry(): SeedEntry {
  const seeded = seedAnalysedTake({
    id: IDS.notes,
    title: 'Scale with notes',
    notes: NOTES,
    createdAt: created(3),
  });
  const take = { ...seeded.take, audioMime: 'audio/wav' as const };
  return { ...seeded, take, audio: fixtureWav(take.durationMs) };
}

/** An analysed take whose tab has no notes. */
const noNotesEntry = (): SeedEntry =>
  seedAnalysedTake({ id: IDS.noNotes, title: 'Silence', notes: [], createdAt: created(2) });

/** A recorded take whose audio is not a WAV at all: its analysis fails. */
const brokenEntry = (): SeedEntry => ({
  take: seedTake({
    id: IDS.broken,
    title: 'Broken audio',
    durationMs: 3000,
    sampleRate: 48_000,
    createdAt: created(1),
  }),
  audio: new Uint8Array(4096).fill(7),
});

/** Opens the Library and restores `entries` into it. */
async function seed(page: Page, entries: SeedEntry[]): Promise<void> {
  await page.goto('./#/library');
  await expect(libraryHeading(page)).toBeVisible();
  await restoreSeed(page, seedBackup(entries), { takes: entries.length });
}

/** Opens a take's Tab screen by its deep link. */
async function openTab(page: Page, id: string): Promise<void> {
  await page.goto(`./#/tab/${encodeURIComponent(id)}`);
}

const dialog = (page: Page) => page.getByRole('alertdialog');
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Tab tools' });
const tool = (page: Page, name: string) => toolbar(page).getByRole('button', { name, exact: true });

/** `getUserMedia` rejects with the DOMException named in `window.__gumError`, read per call. */
async function stubGetUserMedia(page: Page, name: string): Promise<void> {
  await page.addInitScript((initial: string) => {
    const w = window as unknown as { __gumError: string };
    w.__gumError = initial;
    MediaDevices.prototype.getUserMedia = () =>
      Promise.reject(new DOMException('stubbed', w.__gumError));
  }, name);
}

const setGumError = (page: Page, name: string) =>
  page.evaluate((n) => {
    (window as unknown as { __gumError: string }).__gumError = n;
  }, name);

/** Storage not persisted: Settings' at-risk status and the Library's one-time notice. */
async function stubNotPersisted(page: Page): Promise<void> {
  await page.addInitScript(() => {
    StorageManager.prototype.persisted = () => Promise.resolve(false);
    StorageManager.prototype.persist = () => Promise.resolve(false);
  });
}

/** A second page of the context, its theme seeded, with its errors and hygiene watched. */
async function extraPage(page: Page, theme: Theme, baseURL: string) {
  const other = await page.context().newPage();
  const otherHygiene = await watchHygiene(other, baseURL);
  const otherErrors = collectErrors(other);
  await seedTheme(other, theme);
  return { other, otherHygiene, otherErrors };
}

const UNSUPPORTED = 'TabCreator needs a recent desktop Chrome';

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    let hygiene: Awaited<ReturnType<typeof watchHygiene>>;
    let errors: string[];
    test.beforeEach(async ({ page, baseURL }) => {
      hygiene = await watchHygiene(page, baseURL!);
      errors = collectErrors(page);
      await seedTheme(page, theme);
    });
    const axe = (page: Page, state: string) => axeIn(page, theme, state);

    test('Record: the mic setup card and every mic error card', async ({ page }) => {
      await stubGetUserMedia(page, 'NotAllowedError');
      await page.goto('./#/record');
      const setup = page.getByRole('region', { name: 'TabCreator needs your microphone' });
      await expect(setup).toBeVisible();
      await axe(page, 'Record setup card');

      // `UnknownError` has no code of its own: mic-failed (AbortError would be mic-in-use).
      const cards = [
        ['NotAllowedError', 'Microphone access is blocked'],
        ['NotFoundError', 'No microphone found'],
        ['NotReadableError', 'Your microphone is busy'],
        ['UnknownError', "The microphone didn't start"],
      ] as const;
      let first = true;
      for (const [name, title] of cards) {
        await setGumError(page, name);
        await page
          .getByRole('button', { name: first ? 'Allow microphone' : 'Try again', exact: true })
          .click();
        first = false;
        await expect(page.getByRole('region', { name: title })).toBeVisible();
        await axe(page, `Record ${title}`);
      }
      expect(errors).toEqual([]);
      hygiene.expectClean();
    });

    test('Tuner: the mic setup card and the mic-denied card', async ({ page }) => {
      await stubGetUserMedia(page, 'NotAllowedError');
      await page.goto('./#/tuner');
      await expect(
        page.getByRole('region', { name: 'TabCreator needs your microphone' }),
      ).toBeVisible();
      await axe(page, 'Tuner setup card');
      await page.getByRole('button', { name: 'Allow microphone', exact: true }).click();
      await expect(
        page.getByRole('region', { name: 'Microphone access is blocked' }),
      ).toBeVisible();
      await axe(page, 'Tuner mic-denied card');
      expect(errors).toEqual([]);
      hygiene.expectClean();
    });

    test('Tab: analysed, selected, note list, popover, settings, Re-analyse, Trim, toast', async ({
      page,
      context,
    }) => {
      test.setTimeout(120_000);
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await seed(page, [notesEntry()]);
      await openTab(page, IDS.notes);
      await expect(tabArea(page)).toBeVisible();
      await expect(noteButton(page, NOTES[0]!.id)).toBeVisible();
      await axe(page, 'Tab analysed');

      // A note selected (and locked by a fret edit, so Re-analyse and Trim ask first).
      const note = NOTES[1]!;
      await noteButton(page, note.id).click();
      await expect.poll(() => selectedNote(page)).toBe(note.id);
      await page.keyboard.press(note.fret === 5 ? '6' : '5');
      await expect(noteButton(page, note.id)).toHaveAttribute('aria-label', /, fret [56], /);
      await axe(page, 'Tab note selected');

      // The note list view.
      const listToggle = page.getByRole('button', { name: 'Note list view' });
      await listToggle.click();
      await expect(page.getByTestId('tab-note-list')).toBeVisible();
      await axe(page, 'Tab note list view');
      await listToggle.click();
      await expect(page.getByTestId('tab-note-list')).toHaveCount(0);

      // The edit popover.
      await noteButton(page, NOTES[2]!.id).dblclick();
      const popover = page.getByRole('dialog', { name: 'Edit note' });
      await expect(popover).toBeVisible();
      await axe(page, 'Tab edit popover');
      await page.keyboard.press('Escape');
      await expect(popover).toHaveCount(0);

      // The analysis settings panel and the Re-analyse confirm.
      await tool(page, 'Analysis settings').click();
      const panel = page.getByTestId('analysis-settings');
      await expect(panel).toBeVisible();
      await axe(page, 'Tab analysis settings');
      await panel.getByRole('button', { name: 'Re-analyse' }).click();
      await expect(dialog(page)).toBeVisible();
      await axe(page, 'Tab Re-analyse confirm');
      await dialog(page).getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog(page)).toHaveCount(0);
      await tool(page, 'Analysis settings').click();
      await expect(panel).toHaveCount(0);

      // The Trim strip (its waveform drawn in this theme) and its confirm.
      await tool(page, 'Trim').click();
      const strip = page.getByRole('region', { name: 'Trim' });
      await expect(strip.getByTestId('trim-waveform')).toBeVisible({ timeout: 10_000 });
      await axe(page, 'Tab Trim strip');
      await strip.getByRole('slider', { name: 'Trim start' }).focus();
      await page.keyboard.press('Shift+ArrowRight');
      await strip.getByRole('button', { name: 'Save' }).click();
      await expect(dialog(page)).toBeVisible();
      await axe(page, 'Tab Trim confirm');
      await dialog(page).getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog(page)).toHaveCount(0);
      await tool(page, 'Trim').click();
      await expect(strip).toHaveCount(0);

      // The "Tab copied" toast, kept up by hovering it.
      await tool(page, 'Copy').click();
      const toast = page.getByTestId('toast');
      await expect(toast).toHaveText('Tab copied');
      await toast.hover();
      await axe(page, 'Toast Tab copied');

      expect(errors).toEqual([]);
      hygiene.expectClean();
    });

    test('Tab: no notes, analysis failed, not found', async ({ page }) => {
      await seed(page, [noNotesEntry(), brokenEntry()]);

      await openTab(page, IDS.noNotes);
      await expect(page.getByRole('heading', { name: 'No notes found' })).toBeVisible();
      await axe(page, 'Tab no notes');

      await openTab(page, IDS.broken);
      await expect(page.getByTestId('tab-analysis-failed')).toBeVisible({ timeout: 20_000 });
      await axe(page, 'Tab analysis failed');

      await openTab(page, 'a11y-no-such-take');
      await expect(page.getByRole('main').getByText('Take not found')).toBeVisible();
      await axe(page, 'Tab not found');

      // The production build logs nothing for the failed analysis: no message is filtered.
      expect(errors).toEqual([]);
      hygiene.expectClean();
    });

    test('Tab: analysing in progress', async ({ page }) => {
      test.setTimeout(120_000);
      const durationMs = 240_000;
      const take = seedTake({
        id: IDS.long,
        title: 'Long take',
        durationMs,
        sampleRate: 48_000,
        createdAt: created(0),
      });
      await seed(page, [{ take, audio: fixtureWav(durationMs) }]);
      await openTab(page, IDS.long);
      const progress = page.getByRole('progressbar', { name: 'Analysing…' });
      await expect(progress).toBeVisible();
      await axe(page, 'Tab analysing');
      // Still analysing after the check: the state checked was the one meant.
      await expect(progress).toBeVisible();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      expect(errors).toEqual([]);
      hygiene.expectClean();
    });

    test('Library: empty, with takes, row menu, rename, confirms, restore error, no results', async ({
      page,
    }) => {
      test.setTimeout(90_000);
      await stubNotPersisted(page);
      await page.goto('./#/library');
      await expect(page.getByRole('heading', { name: 'No takes yet' })).toBeVisible();
      await axe(page, 'Library empty');

      await restoreSeed(page, seedBackup([notesEntry(), noNotesEntry()]), { takes: 2 });
      await expect(row(page, IDS.notes)).toBeVisible();
      await expect(page.getByTestId('persist-notice')).toBeVisible();
      await axe(page, 'Library with takes and the storage notice');

      const more = row(page, IDS.notes).getByRole('button', { name: /^More actions for / });
      const menu = page.getByRole('menu');
      await more.click();
      await expect(menu).toBeVisible();
      await axe(page, 'Library row menu');

      await menu.getByRole('menuitem', { name: 'Rename' }).click();
      const field = row(page, IDS.notes).getByRole('textbox', { name: 'Take title' });
      await expect(field).toBeFocused();
      await axe(page, 'Library rename field');
      await page.keyboard.press('Escape');
      await expect(field).toHaveCount(0);

      await more.click();
      await menu.getByRole('menuitem', { name: 'Delete take' }).click();
      await expect(dialog(page)).toBeVisible();
      await axe(page, 'Library Delete take confirm');
      await dialog(page).getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog(page)).toHaveCount(0);

      await more.click();
      await menu.getByRole('menuitem', { name: 'Delete audio only' }).click();
      await expect(dialog(page)).toBeVisible();
      await axe(page, 'Library Delete audio confirm');
      await dialog(page).getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog(page)).toHaveCount(0);

      // The Restore confirm, then the restore error banner (a file that is not a backup).
      const pick = async (name: string, buffer: Buffer) => {
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser'),
          restoreButton(page).click(),
        ]);
        await chooser.setFiles({ name, mimeType: 'application/zip', buffer });
      };
      await pick(
        'more.zip',
        seedBackup([
          seedAnalysedTake({ id: 'a11y-more', title: 'More', notes: NOTES, createdAt: created(5) }),
        ]),
      );
      await expect(dialog(page)).toBeVisible();
      await axe(page, 'Library Restore confirm');
      await dialog(page).getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog(page)).toHaveCount(0);
      await pick('not-a-backup.zip', Buffer.from('not a zip'));
      await expect(page.getByTestId('restore-error')).toBeVisible();
      await axe(page, 'Library restore error');

      const search = page.getByRole('searchbox', { name: 'Search takes' });
      await search.fill('zzz');
      await expect(page.getByRole('heading', { name: 'No takes match "zzz"' })).toBeVisible();
      await expect(list(page)).toHaveCount(0);
      await axe(page, 'Library no results');

      expect(errors).toEqual([]);
      hygiene.expectClean();
    });

    test('Settings, the at-risk storage notice, and the shortcuts dialog', async ({ page }) => {
      await stubNotPersisted(page);
      await page.goto('./#/settings');
      await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
      await expect(page.getByText('Storage: may be cleared by the browser')).toBeVisible();
      await axe(page, 'Settings');

      // The Theme control itself: the other theme, then this one again (the stored pref).
      const control = page.getByRole('group', { name: 'Theme' });
      const other: Theme = theme === 'light' ? 'dark' : 'light';
      const label = (t: Theme) => (t === 'light' ? 'Light' : 'Dark');
      await control.getByRole('button', { name: label(other) }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', other);
      await control.getByRole('button', { name: label(theme) }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

      await page.getByRole('button', { name: /^Keyboard shortcuts/ }).click();
      await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
      await axe(page, 'Shortcuts dialog');

      expect(errors).toEqual([]);
      hygiene.expectClean();
    });

    test('Instance: another tab, lost after Use here', async ({ page, baseURL }) => {
      await page.goto('./#/record');
      await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

      const { other: second, otherHygiene, otherErrors } = await extraPage(page, theme, baseURL!);
      await second.goto('./#/record');
      const otherTab = (p: Page) =>
        p.getByRole('heading', { name: 'TabCreator is open in another tab' });
      await expect(otherTab(second)).toBeVisible();
      await axe(second, 'Instance other tab');

      await second.getByRole('button', { name: 'Use here' }).click();
      await expect(second.getByRole('navigation', { name: 'Main' })).toBeVisible({
        timeout: 5_000,
      });
      await expect(otherTab(page)).toBeVisible();
      await axe(page, 'Instance lost');

      expect(errors).toEqual([]);
      expect(otherErrors).toEqual([]);
      hygiene.expectClean();
      otherHygiene.expectClean();
    });

    test('Instance: no Web Locks', async ({ page }) => {
      await page.addInitScript(() => {
        delete (Navigator.prototype as { locks?: unknown }).locks;
      });
      await page.goto('./#/record');
      const heading = page.getByRole('heading', { name: UNSUPPORTED });
      await expect(heading).toBeVisible();
      await expect(heading).toBeFocused();
      expect(await page.evaluate(() => (navigator as { locks?: unknown }).locks)).toBeUndefined();
      await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Use here' })).toHaveCount(0);
      await axe(page, 'Instance no Web Locks');
      expect(errors).toEqual([]);
      hygiene.expectClean();
    });

    test('Unsupported screen (no WebAssembly)', async ({ page }) => {
      await page.addInitScript(() => {
        delete (window as unknown as Record<string, unknown>).WebAssembly;
      });
      await page.goto('./#/record');
      const heading = page.getByRole('heading', { name: UNSUPPORTED });
      await expect(heading).toBeVisible();
      expect(await page.evaluate(() => 'WebAssembly' in window)).toBe(false);
      await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
      await axe(page, 'Unsupported screen');
      expect(errors).toEqual([]);
      hygiene.expectClean();
    });

    // The update toast, from update.prod.spec.ts's server: build A installed, build B deployed.
    test('Update available toast', async ({ browser }) => {
      test.setTimeout(60_000);
      const server = await startUpdateServer();
      // Its own context: the fixture page's hygiene watches the preview server's origin.
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        const updateHygiene = await watchHygiene(page, server.url);
        const updateErrors = collectErrors(page);
        await seedTheme(page, theme);
        await page.goto(`${server.url}#/record`);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText('Record');
        await expect
          .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), {
            timeout: 15_000,
          })
          .toBe(true);
        server.serveUpdate();
        await page.evaluate(async () => {
          await (await navigator.serviceWorker.getRegistration())?.update();
        });
        const toast = page.getByTestId('toast').filter({ hasText: 'Update available' });
        await expect(toast).toBeVisible({ timeout: 15_000 });
        await axe(page, 'Update available toast');
        expect(updateErrors).toEqual([]);
        updateHygiene.expectClean();
      } finally {
        await context.close();
        await server.close();
      }
    });
  });
}

// The pref `system` on a dark OS: no `data-theme`, so theme.css's `prefers-color-scheme` block
// supplies the dark tokens (the other groups cover the `[data-theme='dark']` block).
test('system dark: the Library with takes and the analysed Tab', async ({ page, baseURL }) => {
  test.setTimeout(60_000);
  const hygiene = await watchHygiene(page, baseURL!);
  const errors = collectErrors(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await seedTheme(page, 'system');
  await seed(page, [notesEntry(), noNotesEntry()]);
  await expect(row(page, IDS.notes)).toBeVisible();
  await axeIn(page, 'dark', 'Library with takes', { system: true });
  await openTab(page, IDS.notes);
  await expect(noteButton(page, NOTES[0]!.id)).toBeVisible();
  await axeIn(page, 'dark', 'Tab analysed', { system: true });
  expect(errors).toEqual([]);
  hygiene.expectClean();
});
