// Dev diagnostics (spine: errors & logging). The one place app code logs; production builds
// replace `import.meta.env.DEV` with `false`, so the call does nothing and the console stays quiet.

/** Logs a warning in dev and test builds; nothing in production. */
export function devWarn(message: string, details?: unknown): void {
  if (import.meta.env.DEV) {
    console.warn(`[tabcreator] ${message}`, ...(details === undefined ? [] : [details]));
  }
}
