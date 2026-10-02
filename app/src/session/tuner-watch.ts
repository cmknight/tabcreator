// The Tuner's reading, derived from the live input's frames: `read` runs the pitch detector on
// the current frame and advances the pure tuner machine (audio/tuner.ts). The machine starts
// afresh on every mic transition and after a gap in reads. Strings that reach In tune are kept
// for the page session (memory only) and published only when that set grows.

import {
  INITIAL_TUNER_STATE,
  detectPitch,
  nextTuner,
  type TunerReading,
  type TunerState,
} from '../audio/tuner';
import type { StringNo } from '../model/types';
import {
  READ_GAP_MS,
  type InputDerivation,
  type OpenedInput,
  type Patch,
} from './input-derivation';

/** What the Tuner shows for one poll: the reading (null = no pitch) and whether it is In tune. */
export interface TunerDisplay {
  reading: TunerReading | null;
  /** `reading` is kept from an earlier frame (the latest had no pitch): no direction, no In tune. */
  held: boolean;
  inTune: boolean;
}

export interface TunerFields {
  /** Strings that reached In tune on the Tuner, in tick order; memory only, page session. */
  tunedStrings: readonly StringNo[];
}

export interface TunerWatch extends InputDerivation<TunerFields> {
  /** The reading for `input`'s current frame at `now`; null when `input` is null (not live). */
  read(input: Pick<OpenedInput, 'readFrame' | 'analyser'> | null, now: number): TunerDisplay | null;
}

export function createTunerWatch(patch: Patch<TunerFields>): TunerWatch {
  let state: TunerState = INITIAL_TUNER_STATE;
  /** When `read` last ran; null since the last mic transition. */
  let lastReadAt: number | null = null;
  let ticked: readonly StringNo[] = [];

  return {
    transition() {
      state = INITIAL_TUNER_STATE;
      lastReadAt = null;
      return { tunedStrings: ticked };
    },

    read(input, now) {
      if (!input) return null;
      // As with the levels: after a gap (Tuner unmounted, tab hidden) the timings are stale.
      if (lastReadAt !== null && now - lastReadAt > READ_GAP_MS) {
        state = INITIAL_TUNER_STATE;
      }
      lastReadAt = now;
      // `readFrame` reuses its buffer: detect at once, before anything else reads it.
      const hz = detectPitch(input.readFrame(), input.analyser.context.sampleRate);
      state = nextTuner(state, hz, now);
      const string = state.inTune ? state.reading!.string : null; // In tune implies a reading
      if (string !== null && !ticked.includes(string)) {
        ticked = [...ticked, string];
        patch({ tunedStrings: ticked });
      }
      return { reading: state.reading, held: state.held, inTune: state.inTune };
    },
  };
}
