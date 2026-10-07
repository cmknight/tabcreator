// The app-wide flush (spine AD-16; story "Update available prompt"): every store with writes that
// can be pending registers how to finish them, and an app reload (`session/app-reload.ts`) awaits
// `flushAll()` before it reloads, so a debounced Tab save or a Library rename in flight is never
// cut short. A leaf module: stores register here without reading each other (AD-3).
//
// Registered by take-session (while its Tab screen is open: the edit queue's tail, then its save)
// and library-session (its rename and delete writes in flight). settings-session registers
// nothing: its prefs writes are synchronous `localStorage` writes, never in flight.

import { devWarn } from '../model/log';

type Flush = () => Promise<unknown> | void;

/** One entry per registration, so the same function registered twice is flushed twice. */
const flushers = new Set<{ run: Flush }>();

/** Registers `flush`; returns its removal (calling it again does nothing). */
export function registerFlush(flush: Flush): () => void {
  const entry = { run: flush };
  flushers.add(entry);
  return () => {
    flushers.delete(entry);
  };
}

/**
 * Runs every registered flush at once and resolves when all have settled. Never rejects: a failed
 * flush is logged (its store keeps the write for its own Retry).
 */
export async function flushAll(): Promise<void> {
  const results = await Promise.allSettled(
    [...flushers].map(async (entry) => {
      await entry.run();
    }),
  );
  for (const result of results) {
    if (result.status === 'rejected') devWarn('a flush failed', result.reason);
  }
}

/** Tests only: the number of registered flushes. */
export function registeredFlushCount(): number {
  return flushers.size;
}
