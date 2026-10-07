// The recording store's snapshot types, shared by `recording-session.ts` and `take-lifecycle.ts`
// without either importing the other for them (recording-session.ts re-exports them).

import type { MicDevice } from '../audio/mic';
import type { AppErrorCode } from '../model/errors';
import type { InputQualityFields } from './input-quality-watch';
import type { LevelFields } from './level-watch';
import type { RecoveredTake } from './recording-recovery';
import type { TunerFields } from './tuner-watch';

/**
 * Where a take is: none, counting in (no take yet), being created, capturing, or being saved.
 */
export type RecordingState = 'idle' | 'count-in' | 'starting' | 'recording' | 'stopping';

export type MicState = 'setup' | 'requesting' | 'live' | 'error';

/** The count-in pref: on or off, and its tempo. */
export interface CountInPrefs {
  on: boolean;
  bpm: number;
}

/** A one-off fact for the shell to show; `seq` grows with each new notice. */
export type MicNotice =
  | {
      /** The active input was unplugged and the default one is now in use. */
      kind: 'switched';
      /** The label of the input now in use; "" when the browser gives none. */
      label: string;
      seq: number;
    }
  | {
      /** A take stopped under `MIN_TAKE_MS` was deleted. */
      kind: 'too-short';
      seq: number;
    }
  | {
      /**
       * The input a take was recording was unplugged: the take was saved (`mic-lost`) and the
       * default input is now in use. Recording does not continue on it.
       */
      kind: 'stopped-saved';
      seq: number;
    }
  | {
      /**
       * A stopped take could not be saved: it stays unfinished and is offered for recovery (the
       * recovered-take banner).
       */
      kind: 'save-failed';
      seq: number;
    };

/** The mic fields, plus the fields each input derivation owns (see input-derivation.ts). */
export interface RecordingSnapshot extends LevelFields, InputQualityFields, TunerFields {
  mic: MicState;
  /** Set in `error`; kept while a Try again is `requesting`, so the error card stays in place. */
  errorCode?: AppErrorCode;
  /** The selectable audio inputs; only filled while `live`. */
  devices: readonly MicDevice[];
  /** The listed device the live input runs on (or is switching to); null when not live. */
  activeDeviceId: string | null;
  /** The latest notice; kept until the next one replaces it. */
  notice?: MicNotice;
  /** The take's state; carried through mic transitions. */
  recording: RecordingState;
  /** The id of the take being recorded (or created, or saved); null while `idle` or counting in. */
  activeTakeId: string | null;
  /** The count-in pref, as the Record screen's controls show it. */
  countIn: CountInPrefs;
  /** The take in progress has reached its warning time (`maxTakeMs − warnLeadMs`). */
  nearLimit: boolean;
  /** How many takes this store has saved (`recorded`); grows by one with each. */
  savedSeq: number;
  /**
   * Storage is full (the Record screen's error banner): mirrors storage/persistence.ts's one
   * storage-full status, which only freed space clears. A new take does not clear it.
   */
  storageFull: boolean;
  /**
   * With `storageFull`: true when the take a storage-full stop stopped was saved. Absent or false
   * when nothing was saved (the save failed, the take was too short, or it could not be created)
   * or no take was stopped (the status came from elsewhere), so the banner never says "saved"
   * then. Absent until a storage-full stop sets it, and again once the status clears.
   */
  storageFullSaved?: boolean;
  /** Unfinished takes offered for recovery, oldest first (the Record screen's banners). */
  recovered: readonly RecoveredTake[];
  /**
   * What the handover's save did with the take that was recording (story 5.3), for the lost
   * tab's notice: `saved`, or `failed` (left `recording` for the other tab's recovery; a save cut
   * off by the deadline or the write fence counts once it settles). Null before a handover, when
   * no take was recording, and while the save runs.
   */
  handoverTake: HandoverTake;
}

/** See `RecordingSnapshot.handoverTake`. */
export type HandoverTake = 'saved' | 'failed' | null;
