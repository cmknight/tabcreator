// The library backup (story "Back up the library", US-7.3, CAP-19; spine AD-11): one .zip with
// `manifest.json` (every take not still recording, oldest first, and their tabs, as stored) and
// `audio/{takeId}.{ext}`, each compressed audio file byte-identical. Raw files are working data
// and are never included. The zip is built by `backup-worker.ts`, which alone imports fflate and
// reads the audio straight from OPFS, so no audio bytes cross the main thread until the finished
// Blob comes back. `buildManifest` and `backupFileName` are pure (restore, story 6.6, validates
// against the same shape; its unzip is the same worker's `read` request, see restore.ts).
// Rejects only with AppError.

import { extensionFor, preferredExtensions } from '../model/audio-format';
import { AppError, type AppErrorCode } from '../model/errors';
import type { Tab, Take } from '../model/types';
import { DB_VERSION } from './migrations';

/** The backup format this build writes; a new shape bumps it. */
export const BACKUP_FORMAT = 1;

/** `manifest.json`: the records exactly as stored. */
export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  /**
   * The IndexedDB version (`DB_VERSION`) the records were stored at; restore upgrades them from
   * it (`migrateRecords`). Backups made before it existed lack it and were all at version 3.
   */
  schemaVersion: number;
  /** When the backup was made (ISO 8601). */
  exportedAt: string;
  /** Every take whose status is not `recording`, by `createdAt`. */
  takes: Take[];
  /** The tabs of those takes that have one, in the same order. */
  tabs: Tab[];
}

/**
 * One take's audio to put in the zip: the first of `fileNames` found in OPFS `audio/` (the
 * take's own format first, as `readCompressed` looks), stored at the same path.
 */
export interface BackupFile {
  takeId: string;
  fileNames: string[];
}

/** A backup request: build the zip of `manifest` and `files`. */
export interface BackupRequest {
  type: 'backup';
  manifest: BackupManifest;
  files: BackupFile[];
}

/**
 * A restore request (story 6.6): read `file`'s zip directory and hand back its manifest text and
 * entries (slices of `file`; see backup-worker.ts).
 */
export interface ReadRequest {
  type: 'read';
  file: Blob;
}

/** The request to the backup worker: one per worker (it is terminated after its reply). */
export type ToBackupWorker = BackupRequest | ReadRequest;

/**
 * One zip entry other than the manifest, as read by a `read` request: its data as stored in the
 * zip, a lazy slice of the picked file (nothing is read until restore writes it).
 */
export interface BackupEntry {
  name: string;
  blob: Blob;
  /**
   * Present when the data is raw deflate (method 8): the size it must inflate to (the central
   * directory's). Absent when stored as is.
   */
  inflatedSize?: number;
}

/**
 * The backup worker's messages. A backup: progress (by bytes) as it goes, then one `done` or
 * `error`. A read: one `read` (the manifest's text, null when the zip has none, and every other
 * entry) or `error` `backup-invalid`.
 */
export type FromBackupWorker =
  | { type: 'progress'; progress: number }
  | { type: 'done'; blob: Blob; missing: string[] }
  | { type: 'read'; manifest: string | null; entries: BackupEntry[] }
  | {
      type: 'error';
      code: Extract<AppErrorCode, 'storage-failed' | 'backup-invalid'>;
      message: string;
    };

/** The part of `Worker` `createBackup` uses, so tests can pass a fake. */
export interface BackupWorker {
  postMessage(message: ToBackupWorker): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<FromBackupWorker>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}

export interface BackupDeps {
  listTakes(): Promise<Take[]>;
  listTabs(): Promise<Tab[]>;
  /** Defaults to a new module worker running `backup-worker.ts`. */
  createWorker?: () => BackupWorker;
  /** Defaults to the current time. */
  now?: () => Date;
}

export interface BackupResult {
  blob: Blob;
  fileName: string;
  /** How many takes the manifest lists. */
  takes: number;
  /** How many takes with an audio type had no audio file to back up. */
  missingAudio: number;
  /** How many takes have an audio type not in `AUDIO_FORMATS`; their audio is left out. */
  unsupportedAudio: number;
  /** How many takes were left out because they are still recording (unfinished). */
  skippedUnfinished: number;
}

/** The zip entry name of the manifest. */
export const MANIFEST_NAME = 'manifest.json';

const byCreatedAt = (a: Take, b: Take) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;

/**
 * The manifest: every take whose status is not `recording` (in progress or unrecovered), sorted
 * by `createdAt`, and the tab of each one that has one, records as given.
 */
export function buildManifest(
  takes: readonly Take[],
  tabs: readonly Tab[],
  exportedAt: string,
): BackupManifest {
  const included = takes.filter((t) => t.status !== 'recording').sort(byCreatedAt);
  const tabById = new Map(tabs.map((t) => [t.takeId, t]));
  const includedTabs: Tab[] = [];
  for (const take of included) {
    const tab = tabById.get(take.id);
    if (tab) includedTabs.push(tab);
  }
  return {
    format: BACKUP_FORMAT,
    schemaVersion: DB_VERSION,
    exportedAt,
    takes: included,
    tabs: includedTabs,
  };
}

/** File names an OS or archiver adds to a folder (compared lower-cased). */
const JUNK_FILES = new Set(['thumbs.db', 'desktop.ini']);

/** A zip entry an OS re-zip adds: a directory, a dot-segment, `__MACOSX/`, `Thumbs.db`, `desktop.ini`. */
function isJunkEntry(name: string): boolean {
  if (name.endsWith('/')) return true;
  const segments = name.split('/');
  if (segments[0] === '__MACOSX') return true;
  return segments.some((s) => s.startsWith('.') || JUNK_FILES.has(s.toLowerCase()));
}

/**
 * The entry-name policy of a backup zip, so a backup that was unzipped and re-zipped restores
 * (story "Restore validation and missing audio"; the streaming unzip reuses it). Pure. Returns
 * each kept entry's name mapped to the name restore reads it under:
 * - directory entries and what an OS adds are dropped: any path with a segment starting with a
 *   dot (`.DS_Store`, `._a.webm`), `Thumbs.db`, `desktop.ini`, anything under `__MACOSX/`;
 * - when the root has no `manifest.json` but exactly one top-level folder does, that folder's
 *   prefix is stripped from every entry under it (entries elsewhere keep their names, and
 *   restore rejects them as unexpected).
 */
export function backupEntryNames(names: Iterable<string>): Map<string, string> {
  const kept = [...names].filter((name) => !isJunkEntry(name));
  const result = new Map(kept.map((name) => [name, name]));
  if (kept.includes(MANIFEST_NAME)) return result;
  const folders = kept.flatMap((name) => {
    const parts = name.split('/');
    return parts.length === 2 && parts[1] === MANIFEST_NAME ? [`${parts[0]}/`] : [];
  });
  if (folders.length !== 1) return result;
  const prefix = folders[0]!;
  for (const name of kept) {
    if (name.startsWith(prefix)) result.set(name, name.slice(prefix.length));
  }
  return result;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `tabcreator-backup-YYYYMMDD.zip`, with the local date. */
export function backupFileName(date: Date): string {
  return `tabcreator-backup-${pad(date.getFullYear(), 4)}${pad(date.getMonth() + 1)}${pad(date.getDate())}.zip`;
}

/**
 * The audio files to back up: for each manifest take with an audio type, `{id}.{ext}` with the
 * extensions from `model/audio-format.ts` (`preferredExtensions`: the type's own first). A take
 * whose type is not in the table is listed in `unsupported` instead (backed up without audio).
 */
export function backupFiles(manifest: BackupManifest): {
  files: BackupFile[];
  unsupported: string[];
} {
  const files: BackupFile[] = [];
  const unsupported: string[] = [];
  for (const take of manifest.takes) {
    if (take.audioMime === null) continue;
    try {
      extensionFor(take.audioMime);
    } catch {
      unsupported.push(take.id);
      continue;
    }
    const fileNames = preferredExtensions(take.audioMime).map((ext) => `${take.id}.${ext}`);
    files.push({ takeId: take.id, fileNames });
  }
  return { files, unsupported };
}

/** A new module worker running `backup-worker.ts` (backup and restore each start their own). */
export function defaultBackupWorker(): BackupWorker {
  return new Worker(new URL('./backup-worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as BackupWorker;
}

/**
 * Runs one request on a fresh backup worker (backup and restore share it): starts the worker
 * (`createWorker`, else `defaultBackupWorker`), posts `request` and settles on its reply.
 * `onReply` handles the request's own replies, calling `resolve` for the final one, and returns
 * false for any other; an `error` reply then rejects with its code and message, anything else with
 * `storage-failed`. A worker that fails to start, errors, sends an unreadable reply or cannot be
 * posted to rejects with `storage-failed`, the messages prefixed `{label} worker`. The worker is
 * terminated once it has replied or failed. Internal to storage/.
 */
export async function runBackupWorker<T>(
  createWorker: (() => BackupWorker) | undefined,
  label: 'Backup' | 'Restore',
  request: ToBackupWorker,
  onReply: (data: FromBackupWorker, resolve: (value: T) => void) => boolean,
): Promise<T> {
  let worker: BackupWorker;
  try {
    worker = (createWorker ?? defaultBackupWorker)();
  } catch (err) {
    throw new AppError('storage-failed', `${label} worker failed to start`, { cause: err });
  }
  return new Promise<T>((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (onReply(data, resolve)) return;
      if (data.type === 'error') reject(new AppError(data.code, data.message));
      else reject(new AppError('storage-failed', `${label} worker: unexpected reply ${data.type}`));
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      reject(
        new AppError(
          'storage-failed',
          `${label} worker failed: ${event.message || 'unknown error'}`,
        ),
      );
    };
    worker.onmessageerror = () => {
      reject(new AppError('storage-failed', `${label} worker: a reply could not be read`));
    };
    try {
      worker.postMessage(request);
    } catch (err) {
      reject(new AppError('storage-failed', `${label} worker: posting failed`, { cause: err }));
    }
  }).finally(() => worker.terminate());
}

/**
 * Backs up the library: reads every take and tab, then has a fresh backup worker build the zip
 * from OPFS. `onProgress` gets 0 at the start and then the worker's fraction of bytes zipped
 * (monotone, ending at 1). Reading the takes or the worker failing rejects with `storage-failed`. The worker is terminated once it has replied or failed.
 */
export async function createBackup(
  deps: BackupDeps,
  onProgress: (progress: number) => void,
): Promise<BackupResult> {
  const now = (deps.now ?? (() => new Date()))();
  let takes: Take[];
  let tabs: Tab[];
  try {
    [takes, tabs] = await Promise.all([deps.listTakes(), deps.listTabs()]);
  } catch (err) {
    throw new AppError('storage-failed', 'Backup: reading the takes failed', { cause: err });
  }
  const manifest = buildManifest(takes, tabs, now.toISOString());
  const { files, unsupported } = backupFiles(manifest);
  onProgress(0);

  let last = 0;
  const { blob, missing } = await runBackupWorker<{ blob: Blob; missing: string[] }>(
    deps.createWorker,
    'Backup',
    { type: 'backup', manifest, files },
    (data, resolve) => {
      if (data.type === 'progress') {
        // Monotone: a stray lower value never moves the bar back.
        const p = Math.min(1, Math.max(last, data.progress));
        if (p !== last) {
          last = p;
          onProgress(p);
        }
      } else if (data.type === 'done') {
        resolve({ blob: data.blob, missing: data.missing });
      } else {
        return false;
      }
      return true;
    },
  );
  if (last < 1) onProgress(1);

  return {
    blob,
    fileName: backupFileName(now),
    takes: manifest.takes.length,
    missingAudio: missing.length,
    unsupportedAudio: unsupported.length,
    skippedUnfinished: takes.filter((t) => t.status === 'recording').length,
  };
}
