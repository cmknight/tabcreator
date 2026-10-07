// Restore from a backup (story "Restore from a backup", 6.6; US-7.3, Flow 4; spine AD-11, AD-17):
// the main-thread side of reading a backup zip. The zip is read by the backup worker's `read`
// request (`backup-worker.ts`, the only importer of fflate), which hands back the manifest and
// each audio entry as a lazy slice of the picked file (story "Streaming restore and restore
// races": no audio byte is read until restore writes it). `validateBackup`, which is pure, checks
// what comes back before anything is written: the manifest in full (format 1, its
// `schemaVersion` — 3 when absent — at most `DB_VERSION`, its records upgraded from it by
// `migrateRecords`; every take and tab well formed in type and value, no duplicate ids, no take
// still recording, every tab's take present) and every audio entry's name (`audio/{takeId}.{ext}`
// with a known extension, for a take of the manifest that has an audio type, at most one per
// take). The audio bytes themselves are checked (inflate, size) as they stream into OPFS at
// Confirm (audio-store.ts `restoreCompressed`), where a bad entry is `backup-invalid`. A backup
// with deflated audio is rejected up front when the browser cannot inflate it
// (`DecompressionStream('deflate-raw')`).
// Story "Restore validation and missing audio" (epic 7) adds the value checks, the schema version,
// and two corrections at the end: a take whose entry's extension differs from its `audioMime`
// takes the entry's MIME, and a take with an audio type but no entry (the backup reported its
// file missing or unsupported) is restored with `audioMime: null`, shown as "Audio deleted"
// (`withoutMissingAudio`). Records are otherwise kept as parsed, unknown fields included. Rejects
// only with AppError: `backup-invalid` for any unreadable or invalid file, `storage-failed` when
// the worker itself fails.

import { MAX_FRET_MAX } from '../model/analysis-settings';
import { extensionFor, mimeForExtension } from '../model/audio-format';
import { AppError } from '../model/errors';
import { TITLE_MAX } from '../model/title';
import type { StopReason, Tab, Take, TakeStatus } from '../model/types';
import { BACKUP_FORMAT, runBackupWorker, type BackupEntry, type BackupWorker } from './backup';
import { DB_VERSION, migrateRecords, type RecordSet } from './migrations';
import { AUDIO_DIR } from './paths';

/** A backup checked in full: ready to import. */
export interface ValidBackup {
  /**
   * The manifest's takes, in its order, as stored, but for `audioMime`: corrected to the entry's
   * MIME when the extensions differ, null when the take has no entry.
   */
  takes: Take[];
  /** The manifest's tabs, as stored. */
  tabs: Tab[];
  /**
   * Each take's audio, by take id, typed `mimeForExtension` of its entry's extension: the entry's
   * data as stored in the zip (a lazy slice of the picked file, re-typed without a copy), raw
   * deflate for the ids in `deflated`.
   */
  audio: Map<string, Blob>;
  /**
   * The take ids whose `audio` is raw deflate, inflated as it is written, each with the size it
   * must inflate to.
   */
  deflated: Map<string, number>;
}

export interface RestoreDeps {
  /** Defaults to a new module worker running `backup-worker.ts`. */
  createWorker?: () => BackupWorker;
}

const invalid = (why: string) => new AppError('backup-invalid', `Not a TabCreator backup: ${why}`);

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNonNeg = (v: unknown) => isNum(v) && v >= 0;
const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrOrNull = (v: unknown) => v === null || isStr(v);

/**
 * The statuses a backed-up take may have (every `TakeStatus` but `recording`) and every
 * `StopReason`. `satisfies Record<…>` makes each list exhaustive: a member added to the model
 * type and not here (or a key here not in it) fails typecheck.
 */
const TAKE_STATUSES = { recorded: true, analyzed: true } as const satisfies Record<
  Exclude<TakeStatus, 'recording'>,
  true
>;
const STOP_REASONS = {
  user: true,
  'max-length': true,
  'mic-lost': true,
  'storage-full': true,
  'instance-lost': true,
  recovered: true,
} as const satisfies Record<StopReason, true>;

/** Whether `v` is a key of `set` (its own, so `constructor` and the like never match). */
const isMember = (set: object, v: unknown): boolean => isStr(v) && Object.hasOwn(set, v);

/** The schema version of a backup whose manifest has none: every such backup was made at 3. */
export const LEGACY_SCHEMA_VERSION = 3;

/** A canonical ISO 8601 UTC string, as `Date.prototype.toISOString` writes it. */
function isIsoDate(v: unknown): boolean {
  if (!isStr(v)) return false;
  const date = new Date(v);
  return !Number.isNaN(date.getTime()) && date.toISOString() === v;
}

/**
 * A take id usable as an OPFS file name stem: no path separator, not starting with a dot (`.`,
 * `..`, and names `backupEntryNames` drops as OS files).
 */
const isTakeId = (v: unknown): v is string =>
  isStr(v) && v.length > 0 && !/[/\\]/.test(v) && !v.startsWith('.');

function checkSettings(v: unknown): boolean {
  return isObj(v) && isNum(v.sensitivity) && isNum(v.minNoteMs) && isNum(v.maxFret);
}

/** Why `v` is not a well-formed stored take that may be restored; null when it is. */
function takeProblem(v: unknown): string | null {
  if (!isObj(v)) return 'not an object';
  if (!isTakeId(v.id)) return 'id';
  if (!isStr(v.title) || Array.from(v.title).length > TITLE_MAX) return 'title';
  if (!isIsoDate(v.createdAt)) return 'createdAt';
  if (v.status === 'recording') return 'still recording';
  if (!isMember(TAKE_STATUSES, v.status)) return 'status';
  if (!isNonNeg(v.durationMs)) return 'durationMs';
  if (!isNum(v.sampleRate) || v.sampleRate <= 0) return 'sampleRate';
  if (v.tuning !== 'EADGBE') return 'tuning';
  if (!isStr(v.micLabel)) return 'micLabel';
  if (!isStrOrNull(v.audioMime)) return 'audioMime';
  if (!isNonNeg(v.trimStartMs)) return 'trimStartMs';
  if (v.trimEndMs !== null && !isNonNeg(v.trimEndMs)) return 'trimEndMs';
  // 0 ≤ trimStartMs ≤ (trimEndMs ?? durationMs) ≤ durationMs.
  const duration = v.durationMs as number;
  const trimEnd = (v.trimEndMs as number | null) ?? duration;
  if ((v.trimStartMs as number) > trimEnd || trimEnd > duration) return 'trim range';
  if (!checkSettings(v.settings)) return 'settings';
  if (!isStrOrNull(v.analysisVersion)) return 'analysisVersion';
  if (!isStr(v.updatedAt)) return 'updatedAt';
  if (
    v.warnings !== undefined &&
    !(isObj(v.warnings) && isNum(v.warnings.tuningOffsetCents) && isNum(v.warnings.belowRangeNotes))
  ) {
    return 'warnings';
  }
  if (v.countInBpm !== undefined && !isNum(v.countInBpm)) return 'countInBpm';
  if (v.clipped !== undefined && typeof v.clipped !== 'boolean') return 'clipped';
  if (v.stopReason !== undefined && !isMember(STOP_REASONS, v.stopReason)) return 'stopReason';
  return null;
}

function isNote(v: unknown): boolean {
  return (
    isObj(v) &&
    isStr(v.id) &&
    isNum(v.startMs) &&
    v.startMs >= 0 &&
    isNum(v.endMs) &&
    v.endMs >= v.startMs &&
    isNum(v.midi) &&
    isNum(v.confidence) &&
    Number.isInteger(v.string) &&
    (v.string as number) >= 1 &&
    (v.string as number) <= 6 &&
    Number.isInteger(v.fret) &&
    (v.fret as number) >= 0 &&
    // Any fret the engine can map to, not the take's current maxFret: that can change without
    // re-analysis.
    (v.fret as number) <= MAX_FRET_MAX &&
    typeof v.locked === 'boolean' &&
    typeof v.lowConfidence === 'boolean' &&
    (v.inserted === undefined || v.inserted === true)
  );
}

/** Why `v` is not a well-formed stored tab; null when it is. */
function tabProblem(v: unknown): string | null {
  if (!isObj(v)) return 'not an object';
  if (!isTakeId(v.takeId)) return 'takeId';
  if (!Array.isArray(v.notes) || !v.notes.every(isNote)) return 'notes';
  if (!isStr(v.updatedAt)) return 'updatedAt';
  // Older tabs lack it; storage defaults it on read.
  if (v.deletedStartMs !== undefined) {
    if (!Array.isArray(v.deletedStartMs) || !v.deletedStartMs.every(isNum)) {
      return 'deletedStartMs';
    }
  }
  return null;
}

/** `audio/{takeId}.{ext}`, split; null when the name is not of that shape. */
function audioEntryName(name: string): { takeId: string; ext: string } | null {
  const prefix = `${AUDIO_DIR}/`;
  if (!name.startsWith(prefix)) return null;
  const file = name.slice(prefix.length);
  const dot = file.lastIndexOf('.');
  if (dot <= 0 || dot === file.length - 1) return null;
  const takeId = file.slice(0, dot);
  if (!isTakeId(takeId)) return null;
  return { takeId, ext: file.slice(dot + 1) };
}

/**
 * Checks a backup's manifest text and its other zip entries in full (see the header); returns
 * the takes, tabs and audio to import, or throws `backup-invalid`.
 */
export function validateBackup(
  manifestText: string | null,
  entries: readonly BackupEntry[],
): ValidBackup {
  if (manifestText === null) throw invalid('no manifest');
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw invalid('the manifest is not JSON');
  }
  if (!isObj(manifest)) throw invalid('the manifest is not an object');
  if (manifest.format !== BACKUP_FORMAT) throw invalid(`format ${String(manifest.format)}`);
  const schemaVersion =
    manifest.schemaVersion === undefined ? LEGACY_SCHEMA_VERSION : manifest.schemaVersion;
  if (
    !Number.isInteger(schemaVersion) ||
    (schemaVersion as number) < 1 ||
    (schemaVersion as number) > DB_VERSION
  ) {
    throw invalid(`schemaVersion ${String(schemaVersion)}`);
  }
  if (!isStr(manifest.exportedAt)) throw invalid('exportedAt');
  if (!Array.isArray(manifest.takes) || !Array.isArray(manifest.tabs)) {
    throw invalid('takes or tabs missing');
  }
  // The records as this build stores them, before their shapes are checked.
  let records: RecordSet;
  try {
    records = migrateRecords(
      { takes: manifest.takes as unknown[], tabs: manifest.tabs as unknown[] },
      schemaVersion as number,
    );
  } catch {
    throw invalid('records cannot be upgraded');
  }

  const takes = new Map<string, Take>();
  for (const [i, take] of records.takes.entries()) {
    const problem = takeProblem(take);
    if (problem) throw invalid(`take ${i}: ${problem}`);
    const t = take as Take;
    if (takes.has(t.id)) throw invalid(`take ${t.id} listed twice`);
    takes.set(t.id, t);
  }
  const tabIds = new Set<string>();
  for (const [i, tab] of records.tabs.entries()) {
    const problem = tabProblem(tab);
    if (problem) throw invalid(`tab ${i}: ${problem}`);
    const takeId = (tab as Tab).takeId;
    if (!takes.has(takeId)) throw invalid(`tab ${i}: no take ${takeId}`);
    if (tabIds.has(takeId)) throw invalid(`tab of ${takeId} listed twice`);
    tabIds.add(takeId);
  }

  const audio = new Map<string, Blob>();
  const deflated = new Map<string, number>();
  for (const { name, blob, inflatedSize } of entries) {
    const parsed = audioEntryName(name);
    if (!parsed) throw invalid(`unexpected entry ${name}`);
    const mime = mimeForExtension(parsed.ext);
    if (!mime) throw invalid(`unknown audio extension ${name}`);
    const take = takes.get(parsed.takeId);
    if (!take) throw invalid(`${name}: no such take`);
    if (take.audioMime === null) throw invalid(`${name}: the take has no audio`);
    if (audio.has(take.id)) throw invalid(`${name}: a second file for the take`);
    // The bytes as they are, typed by the entry's own extension (the write names the file); a
    // slice re-types it without a copy.
    audio.set(take.id, blob.slice(0, blob.size, mime));
    if (inflatedSize !== undefined) deflated.set(take.id, inflatedSize);
    // The app's own backup may hold a file found under another format than the take's type
    // (backupFiles looks for every extension): the take takes the file's type.
    if (extensionOf(take.audioMime) !== parsed.ext)
      takes.set(take.id, { ...take, audioMime: mime });
  }

  return {
    takes: withoutMissingAudio([...takes.values()], audio),
    tabs: records.tabs as Tab[],
    audio,
    deflated,
  };
}

/** The file extension of `mime`; null when it is not in the audio-format table. */
function extensionOf(mime: string): string | null {
  try {
    return extensionFor(mime);
  } catch {
    return null;
  }
}

/**
 * The missing-audio rule (pure; the last step of validation, so the Confirm plan and the import
 * both see it, and reusable by a streaming restore): each take with an audio type but no entry in
 * `audio` comes back with `audioMime: null`, so its record never points at audio that is not
 * there and the Library shows "Audio deleted". Other takes come back as they are.
 */
export function withoutMissingAudio(
  takes: readonly Take[],
  audio: ReadonlyMap<string, unknown>,
): Take[] {
  return takes.map((take) =>
    take.audioMime !== null && !audio.has(take.id) ? { ...take, audioMime: null } : take,
  );
}

/**
 * Reads and checks a backup file: a fresh backup worker reads its zip directory (`read`), then
 * `validateBackup` checks the result, and a backup with deflated audio needs
 * `DecompressionStream('deflate-raw')`. Nothing is written. Rejects with `backup-invalid` for a
 * file that is not a valid backup, `storage-failed` when the worker fails; the worker is
 * terminated once it has replied or failed.
 */
export async function readBackup(file: Blob, deps: RestoreDeps = {}): Promise<ValidBackup> {
  const { manifest, entries } = await runBackupWorker<{
    manifest: string | null;
    entries: BackupEntry[];
  }>(deps.createWorker, 'Restore', { type: 'read', file }, (data, resolve) => {
    if (data.type !== 'read') return false;
    resolve({ manifest: data.manifest, entries: data.entries });
    return true;
  });
  const backup = validateBackup(manifest, entries);
  // Checked before the Confirm dialog: a deflated entry could not be written mid-restore.
  if (backup.deflated.size > 0 && !canInflateRaw()) {
    throw invalid('deflated audio, and this browser cannot inflate it');
  }
  return backup;
}

/** Whether this browser has `DecompressionStream('deflate-raw')`. */
function canInflateRaw(): boolean {
  if (typeof DecompressionStream !== 'function') return false;
  try {
    new DecompressionStream('deflate-raw');
    return true;
  } catch {
    return false;
  }
}
