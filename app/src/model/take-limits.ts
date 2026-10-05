// A take's length limits (CAP-5): the constants, and the shape the recording store takes them in
// (the dev override in dev/hooks/recording.ts reads them too).

/** The longest take, ms (CAP-5): it stops itself here. */
export const MAX_TAKE_MS = 300_000;
/** How long before the cap the "30 seconds left" warning shows, ms. */
export const WARN_LEAD_MS = 30_000;

/** A take's length limits, ms: the cap and the warning's lead before it. */
export interface TakeLimits {
  /** The cap (`MAX_TAKE_MS`). */
  capMs: number;
  /** The warning's lead before the cap (`WARN_LEAD_MS`). */
  leadMs: number;
}
