/**
 * Seeding a known take into a real build (story "60 s analysis benchmark gate"; reused by the
 * latency stories that need a take in the production app). No dev hook is involved: the take
 * goes in through the Library's own Restore from backup, as a user would restore it.
 *
 * - `readFixtureWav` / `loopPcm` / `wavFile`: a 16-bit mono PCM fixture from testdata/, looped
 *   to an exact length and written back as a WAV.
 * - `seedTake` / `seedBackup`: a format-1 backup zip (fflate, in Node) at this build's
 *   `schemaVersion`: one `recorded` take with `audioMime: 'audio/wav'`, no tab, and its
 *   `audio/{id}.wav` (`seedBackup(take, wav)`), or several takes, each with optional audio (named
 *   by its `audioMime`) and an optional tab (`seedBackup([{ take, audio, tab }, ...])`). A
 *   `recorded` take is analysed when its Tab screen opens.
 * - `seedAnalysedTake` / `tab500Seed` / `library500Seed` (story "Latency gates and backup on the
 *   production build"): `analyzed` takes with no audio and their tabs, as the latency perf specs
 *   seed them: the 500-note tab (phrased, or one phrase) and the 500-take library with a small
 *   tab each, from the deterministic generators `tab500Notes` and `library500Title(s)` /
 *   `library500Notes`.
 * - `restoreSeed`: picks the zip through Restore from backup, confirms, and waits for the
 *   summary toast; any failure throws a `SeedError` naming what went wrong.
 *
 * Imports carry their `.ts` extensions; the benchmark (`build/benchmark-cli.ts`) loads this file
 * with Node's type stripping and a resolve hook for the app modules' extensionless imports.
 */
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import { LIBRARY500_COUNT, library500Notes, library500Title } from '../../src/dev/library500.ts';
import { extensionFor } from '../../src/model/audio-format.ts';
import type { Note, Tab, Take } from '../../src/model/types.ts';
import { DB_VERSION } from '../../src/storage/migrations.ts';
import { DEFAULT_PREFS } from '../../src/storage/prefs.ts';
import { restoreButton } from './library-helpers.ts';
import { tab500Notes } from './tab500.ts';

/** A seeding problem: the run fails with this message. */
export class SeedError extends Error {
  override name = 'SeedError';
}

/** A 16-bit mono PCM WAV's samples and rate. */
export interface Pcm16 {
  samples: Int16Array;
  sampleRate: number;
}

/** The samples (16-bit mono PCM) and sample rate of a WAV fixture. */
export function readFixtureWav(path: string): Pcm16 {
  let b: Buffer;
  try {
    b = readFileSync(path);
  } catch (e) {
    throw new SeedError(`cannot read ${path}: ${(e as Error).message}`);
  }
  if (
    b.length < 12 ||
    b.toString('ascii', 0, 4) !== 'RIFF' ||
    b.toString('ascii', 8, 12) !== 'WAVE'
  )
    throw new SeedError(`${path}: not a RIFF/WAVE file`);
  let sampleRate = 0;
  for (let at = 12; at + 8 <= b.length;) {
    const id = b.toString('ascii', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      if (size < 16 || at + 24 > b.length) throw new SeedError(`${path}: short fmt chunk`);
      if (b.readUInt16LE(at + 8) !== 1 || b.readUInt16LE(at + 10) !== 1)
        throw new SeedError(`${path}: not PCM mono`);
      if (b.readUInt16LE(at + 22) !== 16) throw new SeedError(`${path}: not 16-bit`);
      sampleRate = b.readUInt32LE(at + 12);
    } else if (id === 'data') {
      if (!sampleRate) throw new SeedError(`${path}: no fmt chunk before data`);
      const data = b.subarray(at + 8, Math.min(b.length, at + 8 + size));
      // A copy, so the samples are aligned whatever the chunk's offset.
      const samples = new Int16Array(data.length >> 1);
      for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2);
      return { samples, sampleRate };
    }
    at += 8 + size + (size & 1);
  }
  throw new SeedError(`${path}: no data chunk`);
}

/** `samples` repeated end to end and cut to exactly `length` samples. */
export function loopPcm(samples: Int16Array, length: number): Int16Array {
  if (samples.length === 0) throw new SeedError('cannot loop an empty fixture');
  if (!Number.isSafeInteger(length) || length < 0)
    throw new SeedError(`loop length ${length}: not a non-negative integer`);
  const out = new Int16Array(length);
  for (let at = 0; at < length; at += samples.length)
    out.set(samples.subarray(0, Math.min(samples.length, length - at)), at);
  return out;
}

/** A 16-bit mono PCM WAV file of `samples`. */
export function wavFile(samples: Int16Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const b = Buffer.alloc(44 + dataBytes);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(samples[i]!, 44 + i * 2);
  return b;
}

export interface SeedOptions {
  /** The take id (also its audio file stem). */
  id: string;
  title?: string;
  durationMs: number;
  sampleRate: number;
  /** ISO 8601; defaults to now. */
  createdAt?: string;
}

/** A stored `recorded` take with WAV audio and the default analysis settings, not yet analysed. */
export function seedTake(options: SeedOptions): Take {
  const createdAt = options.createdAt ?? new Date().toISOString();
  return {
    id: options.id,
    title: options.title ?? `Seeded ${options.id}`,
    createdAt,
    status: 'recorded',
    durationMs: options.durationMs,
    sampleRate: options.sampleRate,
    tuning: 'EADGBE',
    micLabel: 'Seeded',
    audioMime: 'audio/wav',
    trimStartMs: 0,
    trimEndMs: null,
    settings: { ...DEFAULT_PREFS.analysisDefaults },
    analysisVersion: null,
    updatedAt: createdAt,
  };
}

/** The `manifest.json` of a backup holding `takes` and `tabs`, at this build's schema version. */
export function seedManifest(
  takes: Take[],
  tabs: Tab[] = [],
  exportedAt = new Date().toISOString(),
) {
  return { format: 1, schemaVersion: DB_VERSION, exportedAt, takes, tabs };
}

/** One take of a seeded backup: its audio file's bytes (if any) and its tab (if any). */
export interface SeedEntry {
  take: Take;
  /** Stored as `audio/{id}.{ext}`, the extension from `take.audioMime`. */
  audio?: Uint8Array;
  tab?: Tab;
}

/**
 * A backup zip of one `recorded` take with `wav` as its `audio/{id}.wav`, or of several takes
 * (manifest order as given), each with its optional audio and tab. Audio is stored, not deflated,
 * so restore needs no inflate. Throws a `SeedError` for audio on a take with no audio type, a tab
 * of another take, or a take id listed twice.
 */
export function seedBackup(take: Take, wav: Uint8Array): Buffer;
export function seedBackup(entries: readonly SeedEntry[]): Buffer;
export function seedBackup(first: Take | readonly SeedEntry[], wav?: Uint8Array): Buffer {
  const entries: readonly SeedEntry[] = Array.isArray(first)
    ? first
    : [{ take: first as Take, ...(wav ? { audio: wav } : {}) }];
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};
  const ids = new Set<string>();
  for (const { take, audio, tab } of entries) {
    if (ids.has(take.id)) throw new SeedError(`take ${take.id} listed twice`);
    ids.add(take.id);
    if (tab && tab.takeId !== take.id)
      throw new SeedError(`the tab of ${tab.takeId} is given with take ${take.id}`);
    if (!audio) continue;
    if (take.audioMime === null) throw new SeedError(`take ${take.id} has audio but no audioMime`);
    files[`audio/${take.id}.${extensionFor(take.audioMime)}`] = [audio, { level: 0 }];
  }
  const takes = entries.map((e) => e.take);
  const tabs = entries.flatMap((e) => (e.tab ? [e.tab] : []));
  files['manifest.json'] = strToU8(JSON.stringify(seedManifest(takes, tabs)));
  return Buffer.from(zipSync(files));
}

/** The analysis version every seeded analysed take carries (never a real engine version). */
export const SEEDED_ANALYSIS_VERSION = 'seeded';

export interface AnalysedSeedOptions {
  /** The take id. */
  id: string;
  title: string;
  /** The tab's notes; the take lasts until 1 s after the last one ends. */
  notes: Note[];
  /** ISO 8601. */
  createdAt: string;
}

/**
 * An `analyzed` take with no audio (`audioMime: null`) and its tab of `notes`: analysis version
 * `seeded`, the app default analysis settings, at 48 kHz.
 */
export function seedAnalysedTake({ id, title, notes, createdAt }: AnalysedSeedOptions): SeedEntry {
  const last = notes.at(-1);
  const take: Take = {
    ...seedTake({
      id,
      title,
      durationMs: (last?.endMs ?? 0) + 1000,
      sampleRate: 48_000,
      createdAt,
    }),
    status: 'analyzed',
    audioMime: null,
    analysisVersion: SEEDED_ANALYSIS_VERSION,
  };
  return { take, tab: { takeId: id, notes, updatedAt: createdAt, deletedStartMs: [] } };
}

/** The take ids `tab500Seed` uses: the phrased shape (gated) and one phrase (reported). */
export const TAB500_IDS = { phrased: 'tab500-phrased', onePhrase: 'tab500-one-phrase' } as const;

/**
 * The 500-note tab twice, as two analysed takes: the phrased shape (`TAB500_IDS.phrased`, created
 * at `baseMs` + 1 s) and the one-phrase shape (`TAB500_IDS.onePhrase`, at `baseMs` + 2 s).
 */
export function tab500Seed(baseMs = Date.now() - 3000): SeedEntry[] {
  return [
    seedAnalysedTake({
      id: TAB500_IDS.phrased,
      title: '500 notes',
      notes: tab500Notes(),
      createdAt: new Date(baseMs + 1000).toISOString(),
    }),
    seedAnalysedTake({
      id: TAB500_IDS.onePhrase,
      title: '500 notes, one phrase',
      notes: tab500Notes({ onePhrase: true }),
      createdAt: new Date(baseMs + 2000).toISOString(),
    }),
  ];
}

/**
 * The 500-take library: take `i` (1–500) is `library500-{iii}`, titled `library500Title(i)`, with
 * the small tab `library500Notes(i)`, created at `baseMs` + `i` s (take 1 the oldest; by
 * default all before now).
 */
export function library500Seed(baseMs = Date.now() - (LIBRARY500_COUNT + 1) * 1000): SeedEntry[] {
  return Array.from({ length: LIBRARY500_COUNT }, (_, k) => {
    const i = k + 1;
    return seedAnalysedTake({
      id: `library500-${String(i).padStart(3, '0')}`,
      title: library500Title(i),
      notes: library500Notes(i),
      createdAt: new Date(baseMs + i * 1000).toISOString(),
    });
  });
}

/**
 * Restores `zip` (named `name`, holding `takes` takes, none already in the library) through the
 * Library's Restore from backup and Confirm, from the Library screen. Throws a `SeedError` when
 * any step fails or the summary toast does not say every take was imported.
 */
export async function restoreSeed(
  page: Page,
  zip: Buffer,
  options: { name?: string; takes?: number; timeoutMs?: number } = {},
): Promise<void> {
  const name = options.name ?? 'seed.zip';
  const n = options.takes ?? 1;
  const timeout = options.timeoutMs ?? 30_000;
  const step = async (what: string, action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (e) {
      throw new SeedError(`seeding ${name}: ${what} failed: ${(e as Error).message}`);
    }
  };
  await step('opening the Library', () =>
    restoreButton(page).waitFor({ state: 'visible', timeout }),
  );
  await step('picking the file', async () => {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout }),
      restoreButton(page).click({ timeout }),
    ]);
    await chooser.setFiles({ name, mimeType: 'application/zip', buffer: zip });
  });
  const dialog = page.getByRole('alertdialog');
  const title = `Restore ${n} ${n === 1 ? 'take' : 'takes'} from ${name}?`;
  await step('the Restore dialog', async () => {
    await page.getByText(title).waitFor({ state: 'visible', timeout });
    await dialog.getByRole('button', { name: 'Restore', exact: true }).click({ timeout });
  });
  const summary = `Imported ${n} ${n === 1 ? 'take' : 'takes'}`;
  await step(`waiting for "${summary}"`, async () => {
    const toast = page.getByTestId('toast');
    try {
      await toast.filter({ hasText: summary }).waitFor({ state: 'visible', timeout });
    } catch (e) {
      const banner = page.getByTestId('restore-error');
      const shown = (await banner.count())
        ? await banner.textContent()
        : await toast.allTextContents();
      throw new Error(`${(e as Error).message.split('\n')[0]}; shown: ${JSON.stringify(shown)}`, {
        cause: e,
      });
    }
  });
}
