// Dev-only recovery hook (story "Refactor sweep", retro A5): while `window.__encodePcmFailHook`
// is true, recovery's re-encode (`encodePcm`) rejects, so Open falls back to the WAV encoder in a
// real browser. session/recording-session.ts wraps `encodePcm` with it only inside
// `import.meta.env.DEV`, so production builds tree-shake this module.

import { AppError } from '../../model/errors';

interface EncodeFailHook {
  __encodePcmFailHook?: boolean;
}

/** `encodePcm` with the dev failure hook applied, read at each call. */
export function devEncodePcm(
  encodePcm: (samples: Float32Array, sampleRate: number) => Promise<Blob>,
): (samples: Float32Array, sampleRate: number) => Promise<Blob> {
  return (samples, sampleRate) =>
    (globalThis as EncodeFailHook).__encodePcmFailHook
      ? Promise.reject(new AppError('storage-failed', 'The encode failed (dev hook)'))
      : encodePcm(samples, sampleRate);
}
