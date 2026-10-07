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
// Restore (story 6.6) is its second request type, `read`. Story "Streaming restore and restore
// races" (epic 7) replaced its in-memory unzip with a central-directory reader, so a backup of
// any size the writer can make is restorable: it reads the end of central directory record and
// the central directory from the end of the picked file (`file.slice`, never the whole file),
// names the entries by `backupEntryNames` (what an OS re-zip adds dropped, a single top-level
// folder stripped), inflates only the manifest (strict UTF-8), and hands back every other entry
// as a lazy slice of the picked file (its data, found from its 30-byte local header), with the
// size it must inflate to when deflated; no audio byte is read until restore writes it, and the
// audio is checked (inflate, size) as it streams into OPFS at Confirm (audio-store.ts). Entry order and data descriptors do
// not matter. fflate's streaming `Unzip` is not used: without sizes in the local header it finds
// an entry's end by scanning for a signature, which stored audio can contain. It replies
// `error` `backup-invalid` for a file that is not a plain zip (ZIP64, multi-disk, encrypted, a
// method other than stored or deflate, a local header disagreeing with the central directory,
// anything cut short), `storage-failed` when it runs out of memory. It writes nothing; restore.ts
// validates what comes back.

import { inflateSync, strToU8, Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { backupEntryNames, MANIFEST_NAME } from './backup';
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

/** Zip record signatures and fixed sizes. */
const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_LOCATOR = 20;
const CENTRAL_SIG = 0x02014b50;
const CENTRAL_HEADER = 46;
const LOCAL_SIG = 0x04034b50;
const LOCAL_HEADER = 30;
/** The largest end record: its fixed part and a comment of up to 65,535 bytes. */
const EOCD_MAX = END_RECORD + 0xffff;
/** The largest manifest restore reads (its uncompressed size in the central directory). */
export const MANIFEST_MAX_BYTES = 64 * 1024 * 1024;
/** Compression methods restore reads. */
const STORED = 0;
const DEFLATE = 8;

/** The file is not a plain zip restore can read. */
class InvalidZip extends Error {}

const notZip = (why: string) => new InvalidZip(why);

/** Bytes `start`..`end` of `file` (bounded reads only). */
async function bytesAt(file: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/** One central directory entry. */
interface CentralEntry {
  name: string;
  /** The name's bytes as stored, to compare with the local header's. */
  rawName: Uint8Array;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const decodeName = (bytes: Uint8Array, utf8: boolean): string =>
  utf8
    ? new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    : // Not flagged UTF-8: read byte for byte (the app's own names are ASCII).
      String.fromCharCode(...bytes);

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** The end of central directory record: where the directory is and how many entries it has. */
async function readEnd(file: Blob): Promise<{ count: number; offset: number; size: number }> {
  if (file.size < END_RECORD) throw notZip('too short for a zip');
  const tailStart = Math.max(0, file.size - EOCD_MAX);
  const tail = await bytesAt(file, tailStart, file.size);
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  // The last record whose comment runs exactly to the end of the file.
  let at = -1;
  for (let i = tail.length - END_RECORD; i >= 0; i--) {
    if (
      view.getUint32(i, true) === EOCD_SIG &&
      i + END_RECORD + view.getUint16(i + 20, true) === tail.length
    ) {
      at = i;
      break;
    }
  }
  if (at < 0) throw notZip('no end of central directory record');
  const disk = view.getUint16(at + 4, true);
  const cdDisk = view.getUint16(at + 6, true);
  const diskCount = view.getUint16(at + 8, true);
  const count = view.getUint16(at + 10, true);
  const size = view.getUint32(at + 12, true);
  const offset = view.getUint32(at + 16, true);
  if (
    (at >= ZIP64_LOCATOR && view.getUint32(at - ZIP64_LOCATOR, true) === ZIP64_LOCATOR_SIG) ||
    count === 0xffff ||
    size === 0xffff_ffff ||
    offset === 0xffff_ffff
  ) {
    throw notZip('ZIP64');
  }
  if (disk !== 0 || cdDisk !== 0 || diskCount !== count) throw notZip('multi-disk');
  if (offset + size > tailStart + at) throw notZip('central directory out of range');
  return { count, offset, size };
}

/** Every central directory entry, in directory order, and where the directory starts. */
async function readCentral(file: Blob): Promise<{ entries: CentralEntry[]; offset: number }> {
  const end = await readEnd(file);
  const dir = await bytesAt(file, end.offset, end.offset + end.size);
  const view = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const entries: CentralEntry[] = [];
  let p = 0;
  for (let i = 0; i < end.count; i++) {
    if (p + CENTRAL_HEADER > dir.length || view.getUint32(p, true) !== CENTRAL_SIG) {
      throw notZip('bad central directory');
    }
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const diskStart = view.getUint16(p + 34, true);
    const localOffset = view.getUint32(p + 42, true);
    const next = p + CENTRAL_HEADER + nameLength + extraLength + commentLength;
    if (next > dir.length) throw notZip('bad central directory');
    if ([compressedSize, size, localOffset].includes(0xffff_ffff)) throw notZip('ZIP64');
    if (diskStart !== 0) throw notZip('multi-disk');
    if (flags & 1) throw notZip('encrypted');
    const rawName = dir.slice(p + CENTRAL_HEADER, p + CENTRAL_HEADER + nameLength);
    let name: string;
    try {
      name = decodeName(rawName, (flags & 0x800) !== 0);
    } catch {
      throw notZip('an entry name is not UTF-8');
    }
    entries.push({ name, rawName, method, compressedSize, size, localOffset });
    p = next;
  }
  // The directory holds exactly its entries: anything after them is not a plain zip.
  if (p !== dir.length) throw notZip('trailing bytes in the central directory');
  return { entries, offset: end.offset };
}

/**
 * Where an entry's data starts, from its local header (read with its name, one bounded read);
 * the local header must agree with the central directory on name and method.
 */
async function dataStart(file: Blob, entry: CentralEntry, limit: number): Promise<number> {
  const headerEnd = entry.localOffset + LOCAL_HEADER + entry.rawName.length;
  if (headerEnd > limit) throw notZip(`${entry.name}: local header out of range`);
  const header = await bytesAt(file, entry.localOffset, headerEnd);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (view.getUint32(0, true) !== LOCAL_SIG) throw notZip(`${entry.name}: no local header`);
  if (view.getUint16(8, true) !== entry.method) throw notZip(`${entry.name}: method mismatch`);
  const nameLength = view.getUint16(26, true);
  if (
    nameLength !== entry.rawName.length ||
    !sameBytes(header.subarray(LOCAL_HEADER), entry.rawName)
  ) {
    throw notZip(`${entry.name}: name mismatch`);
  }
  const start = headerEnd + view.getUint16(28, true);
  if (start + entry.compressedSize > limit) throw notZip(`${entry.name}: data out of range`);
  return start;
}

/**
 * Reads a backup zip (restore's `read` request; see the header): posts `read` with the manifest's
 * text (null when there is no `manifest.json`, at most `MANIFEST_MAX_BYTES`) and every other kept
 * entry as a slice of `file` (`inflatedSize` when its method is deflate), or `error` `backup-invalid` when the file cannot be
 * read, is not a plain zip, or its manifest is not UTF-8 text; `storage-failed` when it runs out
 * of memory (RangeError). Reads only the end record, the central directory, each kept entry's
 * local header and the manifest's bytes.
 */
export async function readBackupZip(file: Blob, post: PostBackup): Promise<void> {
  try {
    const central = await readCentral(file);
    const byName = new Map<string, CentralEntry>();
    for (const entry of central.entries) {
      if (byName.has(entry.name)) throw notZip(`${entry.name} listed twice`);
      byName.set(entry.name, entry);
    }
    // Entry data lies before the central directory.
    const limit = central.offset;
    let manifest: string | null = null;
    const entries: BackupEntry[] = [];
    for (const [original, name] of backupEntryNames(byName.keys())) {
      const entry = byName.get(original)!;
      if (entry.method !== STORED && entry.method !== DEFLATE) {
        throw notZip(`${entry.name}: compression method ${entry.method}`);
      }
      if (entry.method === STORED && entry.compressedSize !== entry.size) {
        throw notZip(`${entry.name}: stored sizes differ`);
      }
      const start = await dataStart(file, entry, limit);
      const data = file.slice(start, start + entry.compressedSize);
      if (name === MANIFEST_NAME) {
        if (entry.size > MANIFEST_MAX_BYTES) throw notZip('manifest too large');
        const raw = new Uint8Array(await data.arrayBuffer());
        // Inflated into a buffer one byte longer than the directory's size: fflate never grows a
        // given buffer, so a manifest inflating to more fills it (and is rejected) and memory
        // stays bounded.
        const bytes =
          entry.method === DEFLATE
            ? inflateSync(raw, { out: new Uint8Array(entry.size + 1) })
            : raw;
        if (bytes.length !== entry.size) throw notZip('manifest size mismatch');
        manifest = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } else {
        entries.push(
          entry.method === DEFLATE
            ? { name, blob: data, inflatedSize: entry.size }
            : { name, blob: data },
        );
      }
    }
    post({ type: 'read', manifest, entries });
  } catch (err) {
    // Out of memory (a central directory or manifest too large to hold) is not the file being
    // invalid.
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
