// The input level warning (Too loud / Too quiet), derived from the live input's frames. The
// warning advances only while a meter reads it (`read`, inside the UI's animation frame), and
// starts afresh on every mic transition and after a gap in reads.

import { levelsDbfs, type LevelsDbfs } from '../audio/level-meter';
import {
  INITIAL_LEVEL_WARNING_STATE,
  nextWarning,
  type LevelWarning,
} from '../model/level-warnings';
import {
  READ_GAP_MS,
  type InputDerivation,
  type OpenedInput,
  type Patch,
} from './input-derivation';

export interface LevelFields {
  /** The input level warning; only ever set while `live`. */
  levelWarning: LevelWarning | null;
}

export interface LevelWatch extends InputDerivation<LevelFields> {
  /**
   * Peak and RMS in dBFS of `input`'s current frame (silence when null, i.e. not live), and
   * advances the warning to `now`, publishing it through `patch`.
   */
  read(input: Pick<OpenedInput, 'readFrame'> | null, now: number): LevelsDbfs;
}

const SILENCE: LevelsDbfs = { peakDb: -Infinity, rmsDb: -Infinity };

export function createLevelWatch(patch: Patch<LevelFields>): LevelWatch {
  let state = INITIAL_LEVEL_WARNING_STATE;
  /** When `read` last ran; null since the last mic transition. */
  let lastReadAt: number | null = null;

  return {
    transition() {
      state = INITIAL_LEVEL_WARNING_STATE;
      lastReadAt = null;
      return { levelWarning: null };
    },

    read(input, now) {
      if (!input) return SILENCE;
      // The warning advances only while a meter reads it: after a gap (meter unmounted, tab
      // hidden) the old timings say nothing about the input, so start afresh.
      if (lastReadAt !== null && now - lastReadAt > READ_GAP_MS) {
        state = INITIAL_LEVEL_WARNING_STATE;
      }
      lastReadAt = now;
      const levels = levelsDbfs(input.readFrame());
      state = nextWarning(state, { ...levels, now });
      patch({ levelWarning: state.warning });
      return levels;
    },
  };
}
