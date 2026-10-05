// Starting a suspended AudioContext without hanging on it: `resume()` can stay pending forever
// without user activation, so it is never awaited alone. Shared by the recorder, the encoder and
// the dev fake mic.

/** Resolves true when `promise` settles (either way) within `ms`, else false after `ms`. */
export function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms))),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Asks `ctx` to resume when it is not running and waits at most `ms` for it; never rejects.
 * Resolves with whether the context is running afterwards.
 */
export async function resumeWithin(ctx: AudioContext, ms: number): Promise<boolean> {
  if (ctx.state !== 'running') await within(ctx.resume(), ms);
  return (ctx.state as AudioContextState) === 'running';
}
