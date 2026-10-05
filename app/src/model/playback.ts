// Playback helpers for the Tab screen's following cursor and seeking (story "Playback with a
// following cursor", US-6.5; EXPERIENCE.md Playback). Pure.

/** How far before a note a seek lands, ms (EXPERIENCE.md Playback). */
export const SEEK_LEAD_MS = 100;

/**
 * The index of the note sounding at `ms`: the last whose start is at or before `ms`, or −1
 * before the first note. `sortedStarts` is the notes' `startMs` in played order (ascending;
 * ties allowed: the last of equal starts wins). A binary search.
 */
export function currentNoteIndex(sortedStarts: readonly number[], ms: number): number {
  let lo = 0;
  let hi = sortedStarts.length;
  // Invariant: every index < lo starts at or before ms; every index ≥ hi starts after it.
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedStarts[mid]! <= ms) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Where a seek to a note starting at `startMs` lands: 100 ms before it, never before the trim start. */
export function seekTargetMs(startMs: number, trimStartMs: number): number {
  return Math.max(trimStartMs, startMs - SEEK_LEAD_MS);
}

/** Whether a note starting at `startMs` lies in the trim range `[trimStartMs, trimEndMs)` (null: to the end). */
export function inTrim(startMs: number, trimStartMs: number, trimEndMs: number | null): boolean {
  return startMs >= trimStartMs && (trimEndMs === null || startMs < trimEndMs);
}
