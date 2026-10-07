// Every app-initiated reload goes through here (spine AD-16, AD-19). A reload is refused while
// the recording store is busy (`isBusy`: a take counting in, starting, recording or stopping, a
// failed stop's re-offer, or a recovered take being rebuilt), so it never cuts a take or a save
// short, and while any take is being analysed (story 5.6); `isAppBusy()` is that one answer
// (story 5.7), and while a Tab screen's edit is unsaved (a save pending, in flight or failed;
// story "Change a fret and undo it"). The recording store's `beforeunload`
// guard asks only in the first case: an analysis cut short by a reload starts again when its Tab
// opens. The caller tells the player why (story 5.2). Story "Update available prompt": a running
// library backup or restore is busy too, and every reload first awaits `flushAll()` (pending Tab
// saves, Library writes in flight) and checks busy again after it; the update toast's Reload
// (`reloadToUpdate`) then tells the waiting service worker to take over (`app-update.ts`).
// Unsaved Tab edits are judged only after the flush, which saves (or retries) them: any edit
// still unsaved then, or a storage-full edit held for a later Retry, refuses the reload
// (`isBusyAfterFlush`). A flush that has not settled within `FLUSH_TIMEOUT_MS` refuses it too,
// and only one reload runs at a time (a second call gets the first's promise).
import { analysis, type Analysis } from './analysis';
import { appUpdate, type AppUpdate } from './app-update';
import { flushAll } from './flush';
import { librarySession } from './library-session';
import { recordingSession, type RecordingSession } from './recording-session';
import { hasHeldTabs, hasUnsavedEdits } from './take-session';

/**
 * Calls `reload` unless `session` is busy. Returns whether it reloaded. `reloadApp` is this
 * with the app's stores and `location.reload`.
 */
export function reloadUnlessBusy(
  session: Pick<RecordingSession, 'isBusy'>,
  reload: () => void,
): boolean {
  if (session.isBusy()) return false;
  reload();
  return true;
}

/** Busy for a reload: the recording store is busy, or an analysis is in flight. */
export function appBusy(
  recording: Pick<RecordingSession, 'isBusy'>,
  analyses: Pick<Analysis, 'isAnalysing'>,
): Pick<RecordingSession, 'isBusy'> {
  return { isBusy: () => recording.isBusy() || analyses.isAnalysing() };
}

/**
 * The app's one busy answer before a reload (spine AD-16): the recording store is busy, a take is
 * being analysed, or a library backup or restore is running. Unsaved Tab edits are not counted
 * here: the reload's flush saves them (see `isBusyAfterFlush`). A result only held for Retry
 * after a storage-full commit is not busy. Settings' Reload, the Tab screen's engine banner Reload
 * and the update toast read it.
 */
export function isAppBusy(): boolean {
  return appBusy(recordingSession, analysis).isBusy() || librarySession.isBusy();
}

/**
 * Busy once the flush is done: as `isAppBusy`, or a Tab edit still unsaved (its save failed even
 * when retried, or made meanwhile), or a storage-full edit held for a later Retry.
 */
export function isBusyAfterFlush(): boolean {
  return isAppBusy() || hasUnsavedEdits() || hasHeldTabs();
}

/** How long a reload waits for the flush before refusing as busy. */
export const FLUSH_TIMEOUT_MS = 10_000;

export interface FlushedReloadDeps {
  isBusy(): boolean;
  /** The re-check after the flush (default `isBusy`). */
  isBusyAfterFlush?(): boolean;
  flushAll(): Promise<void>;
  reload(): void | Promise<void>;
  /** The flush's time limit (default `FLUSH_TIMEOUT_MS`). */
  flushTimeoutMs?: number;
}

/** Resolves whether `flush` settled within `ms`. */
async function settlesWithin(flush: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([flush.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Refuses (false) while busy; otherwise awaits `flushAll` (refusing if it has not settled within
 * the time limit), refuses if the app is busy after it, and only then calls `reload` and
 * resolves true.
 */
export async function flushThenReload(deps: FlushedReloadDeps): Promise<boolean> {
  if (deps.isBusy()) return false;
  const flushed = await settlesWithin(deps.flushAll(), deps.flushTimeoutMs ?? FLUSH_TIMEOUT_MS);
  if (!flushed) return false;
  // A flush awaits writes, during which a recording or a backup can start.
  if ((deps.isBusyAfterFlush ?? deps.isBusy)()) return false;
  await deps.reload();
  return true;
}

/** The reload in progress (either kind); a second call meanwhile gets its promise. */
let inFlight: Promise<boolean> | null = null;

function singleFlight(run: () => Promise<boolean>): Promise<boolean> {
  if (inFlight) return inFlight;
  const current = run().finally(() => {
    if (inFlight === current) inFlight = null;
  });
  inFlight = current;
  return current;
}

/** Reloads the app unless it is busy, after flushing; resolves whether it reloaded. */
export function reloadApp(): Promise<boolean> {
  return singleFlight(() =>
    flushThenReload({
      isBusy: isAppBusy,
      isBusyAfterFlush,
      flushAll,
      reload: () => location.reload(),
    }),
  );
}

/**
 * The update toast's Reload: as `reloadApp`, but the reload is the waiting worker taking over
 * (a plain reload when none is waiting, or when it does not take control in time and the app is
 * still idle).
 */
export function reloadToUpdate(update: Pick<AppUpdate, 'activate'> = appUpdate): Promise<boolean> {
  return singleFlight(() =>
    flushThenReload({
      isBusy: isAppBusy,
      isBusyAfterFlush,
      flushAll,
      reload: () => update.activate(() => location.reload(), isBusyAfterFlush),
    }),
  );
}
