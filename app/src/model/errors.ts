// Typed errors with a closed code set (spine AD-10). Adding a code is an edit to this list.

export const APP_ERROR_CODES = [
  'mic-denied',
  'mic-no-device',
  'mic-in-use',
  'mic-failed',
  'mic-lost',
  'storage-full',
  'storage-failed',
  'take-not-found',
  'audio-missing',
  'engine-unavailable',
  'analysis-failed',
  'analysis-cancelled',
  'backup-invalid',
  'unsupported-browser',
  'instance-taken',
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

/**
 * The only error shell modules reject with. `message` is for logs only and is
 * never shown; the UI maps `code` to `ui/strings.ts`.
 */
export class AppError extends Error {
  readonly code: AppErrorCode;

  constructor(code: AppErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
