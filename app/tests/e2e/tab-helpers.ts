import { expect, type Locator, type Page } from '@playwright/test';
import type { Note, StringNo, Take } from '../../src/model/types';

// Helpers for the Tab screen specs (story "Tab screen, reflow and selection"): seed an analysed
// take with a tab straight into storage through the dev server's storage module (the same
// module instance the app uses, as instance.dev.spec.ts does), then open its Tab screen.
// Story "Flags, warnings and bar lines on screen" adds flagged notes and the take fields the
// flags, warnings and bar lines read (`SeedTake`).

const OPEN_MIDI: Record<StringNo, number> = { 1: 64, 2: 59, 3: 55, 4: 50, 5: 45, 6: 40 };

/**
 * `count` notes 250 ms apart from 1.5 s, over every string, so the tab wraps at desktop widths.
 * The 12th note (index 11) is string 2, fret 3 (D4), at 4.25 s: "Note 12: B string, fret 3, D4,
 * at 4.25 seconds". The notes at the indexes in `flagged` are low-confidence.
 */
export function makeNotes(count = 40, flagged: readonly number[] = []): Note[] {
  return Array.from({ length: count }, (_, i) => {
    const string = i === 11 ? 2 : ((((i * 5) % 6) + 1) as StringNo);
    const fret = i === 11 ? 3 : (i * 7) % 15;
    const startMs = 1500 + i * 250;
    return {
      id: `note-${String(i).padStart(2, '0')}`,
      startMs,
      endMs: startMs + 200,
      midi: OPEN_MIDI[string] + fret,
      confidence: flagged.includes(i) ? 0.2 : 0.9,
      string,
      fret,
      locked: false,
      lowConfidence: flagged.includes(i),
    };
  });
}

/**
 * Take fields a seeded take may carry: as recorded (count-in, clipping, audio type, trim) and as
 * analysed. A seeded take has no audio (`audioMime` null) unless the test writes a file and sets
 * `audioMime` (story "Playback with a following cursor").
 */
export type SeedTake = Partial<
  Pick<
    Take,
    'countInBpm' | 'clipped' | 'stopReason' | 'warnings' | 'audioMime' | 'trimStartMs' | 'trimEndMs'
  >
>;

/**
 * Creates a `recorded` take and commits an analysis with `notes` (as `take-session`), so the
 * take is `analyzed` with its tab. `extra`'s recording fields go on the created take, its
 * `warnings` on the commit. The page must be running the app (it holds the instance lock).
 * Returns the take id.
 */
export function seedTab(
  page: Page,
  notes: Note[] = makeNotes(),
  title = 'Seeded take',
  extra: SeedTake = {},
): Promise<string> {
  return page.evaluate(
    async ({ notes, title, extra }) => {
      const { warnings, ...recorded } = extra;
      const path = '/src/storage/db.ts';
      const { db } = (await import(
        /* @vite-ignore */ path
      )) as typeof import('../../src/storage/db');
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await db.createTake({
        id,
        title,
        createdAt: now,
        status: 'recorded',
        durationMs: 13_000,
        sampleRate: 48_000,
        tuning: 'EADGBE',
        micLabel: 'Seeded mic',
        audioMime: null,
        trimStartMs: 0,
        trimEndMs: null,
        settings: { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 },
        analysisVersion: null,
        updatedAt: now,
        ...recorded,
      });
      await db.commitAnalysis(
        id,
        { takeId: id, notes, updatedAt: now, deletedStartMs: [] },
        { status: 'analyzed', analysisVersion: 'seeded', ...(warnings ? { warnings } : {}) },
      );
      return id;
    },
    { notes, title, extra },
  );
}

/** Opens the app, seeds an analysed take and opens its Tab screen; returns the take id. */
export async function openSeededTab(
  page: Page,
  notes?: Note[],
  title?: string,
  extra?: SeedTake,
): Promise<string> {
  await page.goto('./#/library');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  const id = await seedTab(page, notes, title, extra);
  await page.goto(`./#/tab/${encodeURIComponent(id)}`);
  await expect(tabArea(page)).toBeVisible();
  await expect(noteButtons(page).first()).toBeVisible();
  return id;
}

/** The tab area (`role="application"`). */
export const tabArea = (page: Page): Locator => page.getByRole('application', { name: 'Tab' });

/** Every note button in the tab area, in document order. */
export const noteButtons = (page: Page): Locator => tabArea(page).locator('[data-note-id]');

/** The note button for a note id. */
export const noteButton = (page: Page, id: string): Locator =>
  tabArea(page).locator(`[data-note-id="${id}"]`);

/** The tab area's current characters per line. */
export async function widthChars(page: Page): Promise<number> {
  return Number(await tabArea(page).getAttribute('data-width-chars'));
}

/** The longest line of every system. */
export function longestLine(page: Page): Promise<number> {
  return tabArea(page)
    .locator('pre')
    .evaluateAll((pres) =>
      Math.max(...pres.flatMap((p) => (p.textContent ?? '').split('\n').map((l) => l.length))),
    );
}

/** The selected note's id (the note button with `aria-pressed="true"`), or null. */
export function selectedNote(page: Page): Promise<string | null> {
  return tabArea(page)
    .locator('[aria-pressed="true"]')
    .evaluateAll((els) => (els.length === 1 ? els[0]!.getAttribute('data-note-id') : null));
}

/** The focused element's note id, or null when focus is not on a note button. */
export function focusedNote(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute('data-note-id') ?? null);
}

/** Reads the take record from IndexedDB with a connection of the test's own. */
export function readTake(page: Page, id: string): Promise<{ title: string; updatedAt: string }> {
  return page.evaluate(
    (takeId) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('tabcreator');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const get = db.transaction('takes').objectStore('takes').get(takeId);
          get.onsuccess = () => {
            resolve(get.result);
            db.close();
          };
          get.onerror = () => reject(get.error);
        };
      }),
    id,
  );
}
