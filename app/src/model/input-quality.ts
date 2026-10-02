// The input quality warning (story 2.8, CAP-26, FR-23, US-1.2): a Bluetooth headset in call
// mode or an input below 44.1 kHz ruins pitch accuracy. Pure (spine AD-1).

/** A track rate below this triggers the warning. */
export const MIN_GOOD_SAMPLE_RATE = 44_100;

/** Labels of Bluetooth / headset inputs, which often run in low-rate call mode. */
export const POOR_INPUT_LABEL = /airpods|bluetooth|hands-free|headset|buds/i;

export interface InputQualityFacts {
  /** The live track's `getSettings().sampleRate`; null when the browser reports none. */
  readonly sampleRate: number | null;
  /** The active input's label ("" when the browser gives none). */
  readonly label: string;
}

/**
 * Whether the input is likely to ruin pitch accuracy: a known rate below 44 100 Hz, or a label
 * matching the headset pattern. An unknown rate alone never triggers it.
 */
export function isPoorInput({ sampleRate, label }: InputQualityFacts): boolean {
  if (sampleRate !== null && sampleRate < MIN_GOOD_SAMPLE_RATE) return true;
  return POOR_INPUT_LABEL.test(label);
}
