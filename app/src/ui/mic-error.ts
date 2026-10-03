import type { AppErrorCode } from '../model/errors';

/** The codes the mic error card has copy for (`global.micError.<code>.*`). */
const MIC_ERROR_CODES = [
  'mic-denied',
  'mic-no-device',
  'mic-in-use',
  'mic-failed',
  'mic-lost',
] as const;
export type MicErrorCode = (typeof MIC_ERROR_CODES)[number];

/** The card for an error code: its own, or `mic-failed` for a code with no card; null for none. */
export function micErrorCode(code: AppErrorCode | undefined): MicErrorCode | null {
  if (code === undefined) return null;
  return (MIC_ERROR_CODES as readonly AppErrorCode[]).includes(code)
    ? (code as MicErrorCode)
    : 'mic-failed';
}
