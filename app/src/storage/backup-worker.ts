// The backup module worker (story "Back up the library", US-7.3; spine AD-11, AD-17): the only
// code that imports fflate. It gets the manifest and the audio file list from `backup.ts`, reads
// each file from OPFS `audio/` itself (the async API, read only; sync access handles stay in
// opfs-worker.ts) and streams the zip: `manifest.json` deflated, each audio file stored
// byte-identical as `audio/{name}` (the first of the take's candidate names found). Output chunks
// are kept as Blob parts, never one concatenated buffer. fflate writes no ZIP64, so a backup that
// would pass 4 GiB or 65,535 entries fails up front instead of producing a corrupt zip. It posts
// progress by bytes zipped, then one `done` (the Blob and the takes whose file was missing) or
// `error`, and closes. The handler is an exported factory so tests can drive it with fake
// directories and no OPFS.
//
// Restore (story 6.6) is its second request type, `read`: it unzips the picked file in memory
// (`unzipSync`; a file that is not a zip, or is cut short, fails) and replies with the manifest's
// text (strict UTF-8) and every other entry as a Blob (directory and `__MACOSX/` entries dropped),
// or `error` `backup-invalid` (`storage-failed` when it runs out of memory). It writes
// nothing; restore.ts validates what comes back.

import { strToU8, unzipSync, Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { MANIFEST_NAME } from './backup';
import { AUDIO_DIR } from './paths';
import type {
  BackupEntry,
  BackupRequest,
  FromBackupWorker,
  BackupFile,
  ToBackupWorker,
} from './backup';

/** Audio is read and zipped in slices of this many bytes. */
const SLICE_BYTES = 4 * 1024 * 1024;
/** The plain zip format's limits (no ZIP64): sizes and offsets in 32 bits, 16-bit entry count. */
const ZIP_MAX_BYTES = 0xffff_ffff;
const ZIP_MAX_ENTRIES = 0xffff;
/**
 * Bytes an entry adds besides its data and its name (twice): local header (30), data descriptor
 * (16), central directory header (46), with room to spare.
 */
const ENTRY_OVERHEAD = 128;
/** The end of central directory record. */
const END_RECORD = 22;

/** The part of an OPFS directory handle used here; structural so tests can pass a fake. */
export interface BackupDirectory {
  getFileHandle(name: string): Promise<{ getFile(): Promise<Blob> }>;
}

export interface BackupRoot {
  getDirectoryHandle(name: string): Promise<BackupDirectory>;
}

export type PostBackup = (message: FromBackupWorker) => void;

export interface BackupHandlerOptions {
  /** Audio is read this many bytes at a time (default 4 MB). */
  sliceBytes?: number;
  /** The largest zip allowed, in bytes (default 4 GiB − 1, the limit without ZIP64). */
  maxBytes?: number;
  /** The most entries allowed (default 65,535). */
  maxEntries?: number;
}

const errorName = (err: unknown): string =>
  err instanceof Error || err instanceof DOMException
    ? err.name
    : typeof err === 'object' && err !== null && 'name' in err
      ? String((err as { name: unknown }).name)
      : '';

const errorMessage = (err: unknown): string =>
  err instanceof Error || err instanceof DOMException ? err.message : String(err);

/** A file or directory that is not there (or is the wrong kind). */
const isGone = (err: unknown) => ['NotFoundError', 'TypeMismatchError'].includes(errorName(err));

/** An error with the code it is reported with. */
class Failure extends Error {
  constructor(
    readonly code: 'storage-failed' | 'audio-missing',
    message: string,
  ) {
    super(message);
  }
}

const tooLarge = () =>
  new Failure('storage-failed', 'The library is too large for one backup file');

/** The first of the take's files found, or null when none is (or there is no audio directory). */
async function openAudio(
  dir: BackupDirectory | null,
  file: BackupFile,
): Promise<{ name: string; blob: Blob } | null> {
  if (!dir) return null;
  for (const name of file.fileNames) {
    try {
      return { name, blob: await (await dir.getFileHandle(name)).getFile() };
    } catch (err) {
      if (isGone(err)) continue;
      throw new Failure('storage-failed', `Read ${name}: ${errorMessage(err)}`);
    }
  }
  return null;
}

/**
 * Builds the handler for one backup request: it finds every audio file first, checks the zip
 * stays within the plain zip limits, then zips, posting `{ type: 'progress' }` (bytes zipped /
 * total) after the manifest and after each slice of audio, then `done` or `error`. The returned
 * promise settles once the last message is posted.
 */
export function createBackupHandler(
  getRoot: () => Promise<BackupRoot>,
  post: PostBackup,
  {
    sliceBytes = SLICE_BYTES,
    maxBytes = ZIP_MAX_BYTES,
    maxEntries = ZIP_MAX_ENTRIES,
  }: BackupHandlerOptions = {},
): (request: BackupRequest) => Promise<void> {
  return async ({ manifest, files }) => {
    const parts: Blob[] = [];
    let zipError: Error | null = null;
    let ended = false;
    let written = 0;
    const zip = new Zip((err, chunk, final) => {
      if (err) {
        zipError = err;
        return;
      }
      written += chunk.byteLength;
      if (written > maxBytes) zipError ??= tooLarge();
      // Each chunk becomes its own Blob part: the browser can keep them outside the JS heap.
      if (chunk.byteLength > 0) parts.push(new Blob([chunk]));
      if (final) ended = true;
    });
    const check = () => {
      if (zipError instanceof Failure) throw zipError;
      if (zipError) throw new Failure('storage-failed', `Zip: ${zipError.message}`);
    };

    try {
      const manifestBytes = strToU8(JSON.stringify(manifest));

      let dir: BackupDirectory | null = null;
      if (files.length > 0) {
        try {
          dir = await (await getRoot()).getDirectoryHandle(AUDIO_DIR);
        } catch (err) {
          if (!isGone(err)) {
            throw new Failure('storage-failed', `Open ${AUDIO_DIR}/: ${errorMessage(err)}`);
          }
        }
      }
      const missing: string[] = [];
      const found: { path: string; blob: Blob }[] = [];
      for (const file of files) {
        const audio = await openAudio(dir, file);
        if (audio) found.push({ path: `${AUDIO_DIR}/${audio.name}`, blob: audio.blob });
        else missing.push(file.takeId);
      }

      // The plain zip limits, checked before anything is written (the manifest is counted
      // undeflated, an upper bound).
      if (found.length + 1 > maxEntries) throw tooLarge();
      let projected = END_RECORD + ENTRY_OVERHEAD + 2 * MANIFEST_NAME.length + manifestBytes.length;
      for (const { path, blob } of found) projected += ENTRY_OVERHEAD + 2 * path.length + blob.size;
      if (projected > maxBytes) throw tooLarge();

      const total = manifestBytes.length + found.reduce((n, f) => n + f.blob.size, 0);
      let done = 0;

      const entry = new ZipDeflate(MANIFEST_NAME, { level: 6 });
      zip.add(entry);
      entry.push(manifestBytes, true);
      check();
      done += manifestBytes.length;
      post({ type: 'progress', progress: done / total });

      for (const { path, blob } of found) {
        // Stored, not deflated: compressed audio does not shrink, and the bytes stay as they are.
        const audio = new ZipPassThrough(path);
        zip.add(audio);
        let offset = 0;
        do {
          const end = Math.min(blob.size, offset + sliceBytes);
          let bytes: Uint8Array<ArrayBuffer>;
          try {
            bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
          } catch (err) {
            // Its entry is already begun, so the file cannot be left out any more.
            throw new Failure(
              isGone(err) || errorName(err) === 'NotReadableError'
                ? 'audio-missing'
                : 'storage-failed',
              `Read ${path}: ${errorMessage(err)}`,
            );
          }
          audio.push(bytes, end >= blob.size);
          check();
          done += end - offset;
          offset = end;
          post({ type: 'progress', progress: done / total });
        } while (offset < blob.size);
      }

      zip.end();
      check();
      if (!ended) throw new Failure('storage-failed', 'Zip: the archive did not finish');
      post({ type: 'done', blob: new Blob(parts, { type: 'application/zip' }), missing });
    } catch (err) {
      zip.terminate();
      const failure =
        err instanceof Failure ? err : new Failure('storage-failed', errorMessage(err));
      post({ type: 'error', code: failure.code, message: failure.message });
    }
  };
}

/**
 * Reads a backup zip (restore's `read` request): posts `read` with the manifest's text (null when
 * there is no `manifest.json`) and every other entry but directory and `__MACOSX/` ones, or
 * `error` `backup-invalid` when the file cannot be read, is not a zip (or is truncated), or its
 * manifest is not UTF-8 text; `storage-failed` when it is too large to unzip in memory
 * (RangeError).
 */
export async function readBackupZip(file: Blob, post: PostBackup): Promise<void> {
  try {
    const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
    let manifest: string | null = null;
    const entries: BackupEntry[] = [];
    for (const [name, bytes] of Object.entries(files)) {
      // What an OS re-zip adds: directory entries and macOS resource forks.
      if (name.endsWith('/') || name.startsWith('__MACOSX/')) continue;
      if (name === MANIFEST_NAME) {
        manifest = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } else {
        entries.push({ name, blob: new Blob([bytes]) });
      }
    }
    post({ type: 'read', manifest, entries });
  } catch (err) {
    // Out of memory (a file too large to unzip here) is not the file being invalid.
    const code = errorName(err) === 'RangeError' ? 'storage-failed' : 'backup-invalid';
    post({ type: 'error', code, message: `Read backup: ${errorMessage(err)}` });
  }
}

/** Handles one request of either type. */
export function createRequestHandler(
  getRoot: () => Promise<BackupRoot>,
  post: PostBackup,
): (request: ToBackupWorker) => Promise<void> {
  const backup = createBackupHandler(getRoot, post);
  return (request) =>
    request.type === 'read' ? readBackupZip(request.file, post) : backup(request);
}

/** The subset of `DedicatedWorkerGlobalScope` used here. */
interface WorkerScope {
  postMessage(message: FromBackupWorker): void;
  close(): void;
  onmessage: ((event: MessageEvent<ToBackupWorker>) => void) | null;
}

const isWorkerScope =
  typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined';

if (isWorkerScope) {
  const scope = globalThis as unknown as WorkerScope;
  const handle = createRequestHandler(
    () => navigator.storage.getDirectory() as unknown as Promise<BackupRoot>,
    (m) => scope.postMessage(m),
  );
  // One request per worker: it closes once it has replied.
  scope.onmessage = (event) => {
    scope.onmessage = null;
    void handle(event.data).finally(() => scope.close());
  };
}
