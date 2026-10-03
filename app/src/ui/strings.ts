import type { StringNo } from '../model/types';
import { formatSigned } from './format';

/** The tuner's spoken string names, `StringNo` 1 = high e … 6 = low E. */
const STRING_NAMES: Readonly<Record<StringNo, string>> = {
  1: 'High E',
  2: 'B',
  3: 'G',
  4: 'D',
  5: 'A',
  6: 'Low E',
};

/** Signed, rounded cents with U+2212 for minus: "+12", "−1", "0". */
function signedCents(cents: number): string {
  return formatSigned(Math.round(cents));
}

/**
 * Every user-visible string (spine AD-12). One flat object; keys are
 * `<screen|global>.<camelCase>`. Parameterised strings are typed functions.
 */
export const strings = {
  'global.appName': 'TabCreator',
  'global.navLabel': 'Main',
  'global.navRecord': 'Record',
  'global.navLibrary': 'Library',
  'global.navTuner': 'Tuner',
  'global.navSettings': 'Settings',
  'global.engineFailed': 'The analysis engine failed to load',
  'global.reload': 'Reload',
  'global.microphone': 'Microphone',
  /** The option text for an input the browser gives no label. */
  'global.microphoneUnnamed': (n: number) => `Microphone ${n}`,
  /** The Microphone select's reason while a take runs (EXPERIENCE.md Microphone select). */
  'global.microphoneBusy': "Can't change the microphone while recording",
  /** Toast when the active input is unplugged and another one takes over (EXPERIENCE.md). */
  'global.micSwitched': (label: string) => `Microphone disconnected — switched to ${label}`,
  /** Toast when the input a take was recording is unplugged; the take is saved (EXPERIENCE.md). */
  'global.micStoppedSaved': 'Microphone disconnected — recording stopped and saved',
  'global.inputLevel': 'Input level',
  'global.levelUnit': 'dBFS',
  'global.levelTooLoud': 'Too loud — move back or lower the input',
  'global.levelTooQuiet': 'Too quiet — move closer to the guitar',
  /** The meter's `aria-valuetext`: "−20 dBFS", "−6 dBFS, too loud", "−50 dBFS, too quiet". */
  'global.levelValueText': (db: number, warning: 'loud' | 'quiet' | null) =>
    `${formatSigned(db)} dBFS${
      warning === 'loud' ? ', too loud' : warning === 'quiet' ? ', too quiet' : ''
    }`,
  /** The input quality warning banner (EXPERIENCE.md Bluetooth / low-rate input). */
  'global.inputQualityWarning':
    'This microphone may be a Bluetooth headset in call mode — accuracy will be poor. Use the built-in or a wired mic.',
  'global.dismiss': 'Dismiss',
  'global.inputQualityDismissLabel': 'Dismiss Bluetooth warning for this session',
  /** The full-screen notice while another tab runs the app (EXPERIENCE.md Open in another tab). */
  'global.instanceOtherTab': 'TabCreator is open in another tab',
  /** Its button: moves the app to this tab. */
  'global.instanceUseHere': 'Use here',
  /** The notice's status line while Use here moves the app to this tab. */
  'global.instanceMovingHere': 'Moving TabCreator here…',
  /** The full-screen notice while a database upgrade waits (EXPERIENCE.md Update blocked). */
  'global.instanceUpgradeBlocked': 'Close other TabCreator tabs to finish updating',
  /** The full-screen notice without the browser APIs the app needs (EXPERIENCE.md). */
  'global.unsupported': 'TabCreator needs a recent desktop Chrome',
  // The mic setup / error card (MicGate), shared by Record and Tuner.
  'global.micSetupTitle': 'TabCreator needs your microphone',
  'global.micSetupText': 'Audio is analysed on this computer and never uploaded.',
  'global.allowMic': 'Allow microphone',
  'global.tryAgain': 'Try again',
  'global.micError.mic-denied.title': 'Microphone access is blocked',
  'global.micError.mic-denied.body':
    'Chrome is blocking the microphone for this site. To allow it:',
  'global.micError.mic-denied.step1':
    'Click the site settings icon at the left end of the address bar.',
  'global.micError.mic-denied.step2': 'Turn on Microphone.',
  'global.micError.mic-denied.step3': 'Come back here and choose Try again.',
  'global.micError.mic-no-device.title': 'No microphone found',
  'global.micError.mic-no-device.body': "Chrome can't find a microphone. To fix it:",
  'global.micError.mic-no-device.step1':
    'Plug in a microphone or headset, or turn on your built-in mic.',
  'global.micError.mic-no-device.step2':
    'If your computer has a mic mute switch or key, turn it off.',
  'global.micError.mic-no-device.step3': 'Come back here and choose Try again.',
  'global.micError.mic-in-use.title': 'Your microphone is busy',
  'global.micError.mic-in-use.body': 'Another app or tab is using the microphone. To free it:',
  'global.micError.mic-in-use.step1': 'Close apps that use the mic, such as video calls.',
  'global.micError.mic-in-use.step2': 'Close other browser tabs that are using the microphone.',
  'global.micError.mic-in-use.step3': 'Come back here and choose Try again.',
  'global.micError.mic-failed.title': "The microphone didn't start",
  'global.micError.mic-failed.body': 'Something went wrong opening the microphone. To fix it:',
  'global.micError.mic-failed.step1': 'Unplug the microphone and plug it back in.',
  'global.micError.mic-failed.step2': "Check it works in your computer's sound settings.",
  'global.micError.mic-failed.step3': 'Come back here and choose Try again.',
  'global.micError.mic-lost.title': 'Microphone access was lost',
  'global.micError.mic-lost.body':
    'The microphone stopped or access was turned off. To get it back:',
  'global.micError.mic-lost.step1': 'Check the microphone is still plugged in.',
  'global.micError.mic-lost.step2':
    'Check Microphone is still allowed in the site settings icon at the left end of the address bar.',
  'global.micError.mic-lost.step3': 'Choose Try again.',
  'record.title': 'Record',
  'record.tuneFirst': 'Tune first',
  'record.record': 'Record',
  'record.stop': 'Stop',
  /** The indicator above the timer while a take records. */
  'record.recording': 'Recording',
  /** Under the timer from 4:30, and announced once (EXPERIENCE.md Recording near limit). */
  'record.nearLimit': '30 seconds left',
  /** The toast after a take under 0.5 s is discarded (EXPERIENCE.md Take too short). */
  'record.tooShort': 'Too short — nothing recorded',
  /** Announced when a take starts capturing. */
  'record.started': 'Recording started',
  /** Announced when a take is saved. */
  'record.stopped': 'Recording stopped',
  /** The error banner after a take is stopped because storage is full (story 3.9). */
  'record.storageFull': 'Storage is full — recording stopped and saved',
  /** The storage-full banner's link to the Library. */
  'record.storageFullLibrary': 'Go to Library',
  /** The recovered-take banner (EXPERIENCE.md Recovered take): the take's start time and length. */
  'record.recovered': (time: string, length: string) =>
    `An unfinished take from ${time} was recovered (${length})`,
  /** The banner's text while Open rebuilds the take. */
  'record.recovering': 'Recovering…',
  'record.recoveredOpen': 'Open',
  'record.recoveredDiscard': 'Discard',
  /** The recording timer's accessible name: "Elapsed time 0:42". */
  'record.elapsed': (time: string) => `Elapsed time ${time}`,
  /** The Space shortcut's description in the keyboard shortcuts dialog (EXPERIENCE.md). */
  'record.shortcutRecordStop': 'Record / stop',
  /** The count-in toggle (EXPERIENCE.md Count-in controls). */
  'record.countIn': 'Count-in',
  /** The count-in tempo field's label and unit. */
  'record.tempo': 'Tempo',
  'record.bpm': 'BPM',
  /** The Record button's label during a count-in. */
  'record.cancel': 'Cancel',
  /** The Record button's accessible name during a count-in. */
  'record.cancelCountIn': 'Cancel count-in',
  /** The indicator above the beat number during a count-in: "Count-in · 90 BPM". */
  'record.countInState': (bpm: number) => `Count-in · ${bpm} BPM`,
  /** A count-in beat, as shown and announced (4, 3, 2, 1). */
  'record.countInBeat': (beat: number) => `${beat}`,
  /** The Esc shortcut's description in the keyboard shortcuts dialog (EXPERIENCE.md). */
  'global.shortcutCancelCountIn': 'Cancel count-in',
  'tab.title': 'Tab',
  'library.title': 'Library',
  'tuner.title': 'Tuner',
  /** The string name in display type; both E strings show "E". */
  'tuner.stringLetter': (string: StringNo) =>
    string === 1 || string === 6 ? 'E' : STRING_NAMES[string],
  'tuner.noPitch': '—',
  'tuner.noPitchHint': 'Play a single open string',
  /** The cents readout: "+12 cents", "−1 cents", "0 cents". */
  'tuner.cents': (cents: number) => `${signedCents(cents)} cents`,
  'tuner.sharp': '♯ Sharp — tune down',
  'tuner.flat': '♭ Flat — tune up',
  'tuner.inTune': 'In tune',
  /** The needle's accessible name; `cents` null is no pitch. */
  'tuner.needleLabel': (cents: number | null) =>
    `Tuning needle, −50 to +50 cents: ${cents === null ? 'No pitch detected' : `${signedCents(cents)} cents`}`,
  'tuner.chipsLabel': 'Strings tuned this session',
  /** A chip's accessible name: "Low E string, in tune", "A string, not yet tuned". */
  'tuner.chipLabel': (string: StringNo, ticked: boolean) =>
    `${STRING_NAMES[string]} string, ${ticked ? 'in tune' : 'not yet tuned'}`,
  /** Announced when a string enters In tune: "Low E string in tune". */
  'tuner.stringInTune': (string: StringNo) => `${STRING_NAMES[string]} string in tune`,
  'tuner.allInTune': 'All six strings in tune',
  'tuner.done': 'Done — go to Record',
  'settings.title': 'Settings',
  'settings.about': 'About',
  'settings.engineVersion': (version: string) => `Engine v${version}`,
  'settings.engineVersionUnavailable': 'Engine version unavailable',
} as const;

export type StringKey = keyof typeof strings;
