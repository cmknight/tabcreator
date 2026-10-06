// Restore from a backup (story "Restore from a backup", 6.6; US-7.3, Flow 4; spine AD-11, AD-17):
// the main-thread side of reading a backup zip. The unzip is the backup worker's `read` request
// (`backup-worker.ts`, the only importer of fflate); what comes back is checked in full by
// `validateBackup`, which is pure, before anything is written: the manifest (format 1, every take
// and tab well formed, no duplicate ids, no take still recording, every tab's take present) and
// every audio entry (`audio/{takeId}.{ext}` with a known extension, for a take of the manifest
// that has an audio type, at most one per take). A take with an audio type may have no entry (the
// backup reported its file missing or unsupported); it is restored without audio. Records are
// kept as parsed, unknown fields included. Rejects only with AppError: `backup-invalid` for any
// unreadable or invalid file, `storage-failed` when the worker itself fails.

import { mimeForExtension } from '../model/audio-format';
import { AppError } from '../model/errors';
import type { Tab, Take } from '../model/types';
import {
  AUDIO_DIR,
  BACKUP_FORMAT,
  defaultBackupWorker,
  type BackupEntry,
  type BackupWorker,
} from './backup';

/** A backup checked in full: ready to import. */
export interface ValidBackup {
  /** The manifest's takes, in its order, as stored. */
  takes: Take[];
  /** The manifest's tabs, as stored. */
  tabs: Tab[];
  /** Each take's audio, by take id, typed `mimeForExtension` of its entry's extension. */
  audio: Map<string, Blob>;
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

const TAKE_STATUSES: readonly unknown[] = ['recorded', 'analyzed'];
const STOP_REASONS: readonly unknown[] = [
  'user',
  'max-length',
  'mic-lost',
  'storage-full',
  'instance-lost',
  'recovered',
];

/** A take id usable as an OPFS file name stem: no path separator, not `.` or `..`. */
const isTakeId = (v: unknown): v is string =>
  isStr(v) && v.length > 0 && !/[/\\]/.test(v) && v !== '.' && v !== '..';

function checkSettings(v: unknown): boolean {
  return isObj(v) && isNum(v.sensitivity) && isNum(v.minNoteMs) && isNum(v.maxFret);
}

/** Why `v` is not a well-formed stored take that may be restored; null when it is. */
function takeProblem(v: unknown): string | null {
  if (!isObj(v)) return 'not an object';
  if (!isTakeId(v.id)) return 'id';
  if (!isStr(v.title)) return 'title';
  if (!isStr(v.createdAt)) return 'createdAt';
  if (v.status === 'recording') return 'still recording';
  if (!TAKE_STATUSES.includes(v.status)) return 'status';
  if (!isNonNeg(v.durationMs)) return 'durationMs';
  if (!isNum(v.sampleRate) || v.sampleRate <= 0) return 'sampleRate';
  if (v.tuning !== 'EADGBE') return 'tuning';
  if (!isStr(v.micLabel)) return 'micLabel';
  if (!isStrOrNull(v.audioMime)) return 'audioMime';
  if (!isNonNeg(v.trimStartMs)) return 'trimStartMs';
  if (v.trimEndMs !== null && !isNonNeg(v.trimEndMs)) return 'trimEndMs';
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
  if (v.stopReason !== undefined && !STOP_REASONS.includes(v.stopReason)) return 'stopReason';
  return null;
}

function isNote(v: unknown): boolean {
  return (
    isObj(v) &&
    isStr(v.id) &&
    isNum(v.startMs) &&
    isNum(v.endMs) &&
    isNum(v.midi) &&
    isNum(v.confidence) &&
    Number.isInteger(v.string) &&
    (v.string as number) >= 1 &&
    (v.string as number) <= 6 &&
    Number.isInteger(v.fret) &&
    (v.fret as number) >= 0 &&
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
  if (!isStr(manifest.exportedAt)) throw invalid('exportedAt');
  if (!Array.isArray(manifest.takes) || !Array.isArray(manifest.tabs)) {
    throw invalid('takes or tabs missing');
  }

  const takes = new Map<string, Take>();
  for (const [i, take] of (manifest.takes as unknown[]).entries()) {
    const problem = takeProblem(take);
    if (problem) throw invalid(`take ${i}: ${problem}`);
    const t = take as Take;
    if (takes.has(t.id)) throw invalid(`take ${t.id} listed twice`);
    takes.set(t.id, t);
  }
  const tabIds = new Set<string>();
  for (const [i, tab] of (manifest.tabs as unknown[]).entries()) {
    const problem = tabProblem(tab);
    if (problem) throw invalid(`tab ${i}: ${problem}`);
    const takeId = (tab as Tab).takeId;
    if (!takes.has(takeId)) throw invalid(`tab ${i}: no take ${takeId}`);
    if (tabIds.has(takeId)) throw invalid(`tab of ${takeId} listed twice`);
    tabIds.add(takeId);
  }

  const audio = new Map<string, Blob>();
  for (const { name, blob } of entries) {
    const parsed = audioEntryName(name);
    if (!parsed) throw invalid(`unexpected entry ${name}`);
    const mime = mimeForExtension(parsed.ext);
    if (!mime) throw invalid(`unknown audio extension ${name}`);
    const take = takes.get(parsed.takeId);
    if (!take) throw invalid(`${name}: no such take`);
    if (take.audioMime === null) throw invalid(`${name}: the take has no audio`);
    if (audio.has(take.id)) throw invalid(`${name}: a second file for the take`);
    // The bytes as they are, typed by the entry's own extension (writeCompressed names the file).
    audio.set(take.id, new Blob([blob], { type: mime }));
  }

  return {
    takes: [...takes.values()],
    tabs: manifest.tabs as Tab[],
    audio,
  };
}

/**
 * Reads and checks a backup file: a fresh backup worker unzips it (`read`), then
 * `validateBackup` checks the result. Nothing is written. Rejects with `backup-invalid` for a
 * file that is not a valid backup, `storage-failed` when the worker fails; the worker is
 * terminated once it has replied or failed.
 */
export async function readBackup(file: Blob, deps: RestoreDeps = {}): Promise<ValidBackup> {
  let worker: BackupWorker;
  try {
    worker = (deps.createWorker ?? defaultBackupWorker)();
  } catch (err) {
    throw new AppError('storage-failed', 'Restore worker failed to start', { cause: err });
  }
  const { manifest, entries } = await new Promise<{
    manifest: string | null;
    entries: BackupEntry[];
  }>((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.type === 'read') resolve({ manifest: data.manifest, entries: data.entries });
      else if (data.type === 'error') reject(new AppError(data.code, data.message));
      else reject(new AppError('storage-failed', `Restore worker: unexpected reply ${data.type}`));
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      reject(
        new AppError(
          'storage-failed',
          `Restore worker failed: ${event.message || 'unknown error'}`,
        ),
      );
    };
    worker.onmessageerror = () => {
      reject(new AppError('storage-failed', 'Restore worker: a reply could not be read'));
    };
    try {
      worker.postMessage({ type: 'read', file });
    } catch (err) {
      reject(new AppError('storage-failed', 'Restore worker: posting failed', { cause: err }));
    }
  }).finally(() => worker.terminate());
  return validateBackup(manifest, entries);
}
