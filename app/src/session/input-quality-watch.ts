// The input quality warning (story 2.8), derived from the live track's sample rate and the
// active input's label (the listed device's, else the track's). False unless live; kept through
// a device switch until the new input opens. Dismiss hides it for the rest of the page session
// (memory only, never prefs).

import { activeDevice, type MicDevice } from '../audio/mic';
import { isPoorInput } from '../model/input-quality';
import type { InputDerivation, OpenedInput, Patch } from './input-derivation';

export interface InputQualityFields {
  /**
   * The live input is likely a Bluetooth headset in call mode or runs below 44.1 kHz. False
   * unless `live`; kept through a device switch until the new input opens.
   */
  inputQualityPoor: boolean;
  /** The quality warning was dismissed; in memory only, for the rest of the page session. */
  inputQualityDismissed: boolean;
}

export interface InputQualityWatch extends InputDerivation<InputQualityFields> {
  devicesChanged(t: {
    input: OpenedInput | null;
    devices: readonly MicDevice[];
  }): Pick<InputQualityFields, 'inputQualityPoor'>;
  /** Hides the warning until the page reloads, whatever input is chosen. */
  dismiss(): void;
}

/** The quality rule on `opened`'s rate and label: the listed device's, else the track's. */
const poorInput = (opened: OpenedInput, devices: readonly MicDevice[]) =>
  isPoorInput({
    sampleRate: opened.sampleRate,
    label: activeDevice(opened, devices)?.label || opened.label,
  });

export function createInputQualityWatch(patch: Patch<InputQualityFields>): InputQualityWatch {
  let poor = false;
  let dismissed = false;

  return {
    transition({ live, input, devices }) {
      // While a switch runs there is no input: keep the last answer until the new one opens.
      poor = !live ? false : input ? poorInput(input, devices) : poor;
      return { inputQualityPoor: poor, inputQualityDismissed: dismissed };
    },

    devicesChanged({ input, devices }) {
      if (input) poor = poorInput(input, devices);
      return { inputQualityPoor: poor };
    },

    dismiss() {
      if (dismissed) return;
      dismissed = true;
      patch({ inputQualityDismissed: true });
    },
  };
}
