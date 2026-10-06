// The library backup (story "Back up the library", US-7.3, CAP-19; spine AD-11): one .zip with
// `manifest.json` (every take not still recording, oldest first, and their tabs, as stored) and
// `audio/{takeId}.{ext}`, each compressed audio file byte-identical. Raw files are working data
// and are never included. The zip is built by `backup-worker.ts`, which alone imports fflate and
// reads the audio straight from OPFS, so no audio bytes cross the main thread until the finished
// Blob comes back. `buildManifest` and `backupFileName` are pure (restore, story 6.6, validates
// against the same shape). Rejects only with AppError.

import { extensionFor, preferredExtensions } from '../model/audio-format';
import { AppError, type AppErrorCode } from '../model/errors';
import type { Tab, Take } from '../model/types';

/** The backup format this build writes; a new shape bumps it. */
export const BACKUP_FORMAT = 1;

/** `manifest.json`: the records exactly as stored. */
export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
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

/** The request to the backup worker: one per worker (it is terminated after its reply). */
export interface ToBackupWorker {
  manifest: BackupManifest;
  files: BackupFile[];
}

/** The backup worker's messages: progress (by bytes) as it goes, then one `done` or `error`. */
export type FromBackupWorker =
  | { type: 'progress'; progress: number }
  | { type: 'done'; blob: Blob; missing: string[] }
  | {
      type: 'error';
      code: Extract<AppErrorCode, 'storage-failed' | 'audio-missing'>;
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
}

/** The zip entry name of the manifest. */
export const MANIFEST_NAME = 'manifest.json';
/** The zip's (and OPFS's) directory of compressed audio. */
export const AUDIO_DIR = 'audio';

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
  return { format: BACKUP_FORMAT, exportedAt, takes: included, tabs: includedTabs };
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

function defaultWorker(): BackupWorker {
  return new Worker(new URL('./backup-worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as BackupWorker;
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

  let worker: BackupWorker;
  try {
    worker = (deps.createWorker ?? defaultWorker)();
  } catch (err) {
    throw new AppError('storage-failed', 'Backup worker failed to start', { cause: err });
  }
  let last = 0;
  const { blob, missing } = await new Promise<{ blob: Blob; missing: string[] }>(
    (resolve, reject) => {
      worker.onmessage = ({ data }) => {
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
          reject(new AppError(data.code, data.message));
        }
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        reject(
          new AppError(
            'storage-failed',
            `Backup worker failed: ${event.message || 'unknown error'}`,
          ),
        );
      };
      worker.onmessageerror = () => {
        reject(new AppError('storage-failed', 'Backup worker: a reply could not be read'));
      };
      try {
        worker.postMessage({ manifest, files });
      } catch (err) {
        reject(new AppError('storage-failed', 'Backup worker: posting failed', { cause: err }));
      }
    },
  ).finally(() => worker.terminate());
  if (last < 1) onProgress(1);

  return {
    blob,
    fileName: backupFileName(now),
    takes: manifest.takes.length,
    missingAudio: missing.length,
    unsupportedAudio: unsupported.length,
  };
}
