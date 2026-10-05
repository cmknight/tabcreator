import type { AppErrorCode } from '../model/errors';

/** The codes the mic error card has copy for (`global.micError<Code><Part>`). */
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

/** Each card's part of its copy keys: `mic-no-device` → `global.micErrorMicNoDevice…`. */
const KEY_CODES = {
  'mic-denied': 'MicDenied',
  'mic-no-device': 'MicNoDevice',
  'mic-in-use': 'MicInUse',
  'mic-failed': 'MicFailed',
  'mic-lost': 'MicLost',
} as const satisfies Record<MicErrorCode, string>;

/** A part of the mic error card's copy. */
export type MicErrorPart = 'Title' | 'Body' | 'Step1' | 'Step2' | 'Step3';

/** The `strings` key of `part` of `code`'s card, e.g. `global.micErrorMicLostTitle`. */
export function micErrorKey<P extends MicErrorPart>(code: MicErrorCode, part: P) {
  return `global.micError${KEY_CODES[code]}${part}` as const;
}
