// The contract between the recording store and the input derivations it composes (level
// warnings, input quality, the tuner). Each derivation owns its own state and is told of every
// mic transition through `transition`, which returns its snapshot fields for the store's one
// notify. Reads between transitions publish through the `patch` the store passes in, which
// notifies only when the given fields actually change.
//
// Each derivation owns its fields: its own state is the authoritative copy, and the snapshot
// only mirrors it. The store never writes those fields except by spreading what the derivation
// returns (`transition`, `devicesChanged`) or what it publishes through `patch`.

import type { MicDevice, MicInput } from '../audio/mic';

/**
 * The live input as the store holds it (and as `RecordingDeps.openInput` returns it). `capture`
 * is the store's only way to the recorder, and `clock` and `clicks` its only way to the audio
 * clock and the count-in metronome (spine AD-2).
 */
export type OpenedInput = Pick<
  MicInput,
  | 'analyser'
  | 'readFrame'
  | 'capture'
  | 'clock'
  | 'clicks'
  | 'close'
  | 'deviceId'
  | 'groupId'
  | 'label'
  | 'sampleRate'
>;

/** A mic transition as the derivations see it. */
export interface InputTransition {
  live: boolean;
  /** The open input; null when not live, or while a switch has none yet. */
  input: OpenedInput | null;
  /** The devices the snapshot will list (empty when not live). */
  devices: readonly MicDevice[];
}

export interface InputDerivation<F> {
  /** Fields for the snapshot on a mic transition; called inside the store's set(), before its one notify. */
  transition(t: InputTransition): F;
  /** Fields after a `devicechange` refresh while live; `input` is null while a switch runs. */
  devicesChanged?(t: { input: OpenedInput | null; devices: readonly MicDevice[] }): Partial<F>;
}

/** Publishes `fields` into the snapshot; notifies only when one of them changes. */
export type Patch<F> = (fields: Partial<F>) => void;

/** A longer pause between reads resets a read-driven machine (level warning, tuner). */
export const READ_GAP_MS = 500;
