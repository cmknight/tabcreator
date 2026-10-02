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
  'record.title': 'Record',
  'record.micSetupTitle': 'TabCreator needs your microphone',
  'record.micSetupText': 'Audio is analysed on this computer and never uploaded.',
  'record.allowMic': 'Allow microphone',
  'record.inputLevel': 'Input level',
  'record.tryAgain': 'Try again',
  'record.micError.mic-denied.title': 'Microphone access is blocked',
  'record.micError.mic-denied.body':
    'Chrome is blocking the microphone for this site. To allow it:',
  'record.micError.mic-denied.step1':
    'Click the site settings icon at the left end of the address bar.',
  'record.micError.mic-denied.step2': 'Turn on Microphone.',
  'record.micError.mic-denied.step3': 'Come back here and choose Try again.',
  'record.micError.mic-no-device.title': 'No microphone found',
  'record.micError.mic-no-device.body': "Chrome can't find a microphone. To fix it:",
  'record.micError.mic-no-device.step1':
    'Plug in a microphone or headset, or turn on your built-in mic.',
  'record.micError.mic-no-device.step2':
    'If your computer has a mic mute switch or key, turn it off.',
  'record.micError.mic-no-device.step3': 'Come back here and choose Try again.',
  'record.micError.mic-in-use.title': 'Your microphone is busy',
  'record.micError.mic-in-use.body': 'Another app or tab is using the microphone. To free it:',
  'record.micError.mic-in-use.step1': 'Close apps that use the mic, such as video calls.',
  'record.micError.mic-in-use.step2': 'Close other browser tabs that are using the microphone.',
  'record.micError.mic-in-use.step3': 'Come back here and choose Try again.',
  'record.micError.mic-failed.title': "The microphone didn't start",
  'record.micError.mic-failed.body': 'Something went wrong opening the microphone. To fix it:',
  'record.micError.mic-failed.step1': 'Unplug the microphone and plug it back in.',
  'record.micError.mic-failed.step2': "Check it works in your computer's sound settings.",
  'record.micError.mic-failed.step3': 'Come back here and choose Try again.',
  'record.micError.mic-lost.title': 'Microphone access was lost',
  'record.micError.mic-lost.body':
    'The microphone stopped or access was turned off. To get it back:',
  'record.micError.mic-lost.step1': 'Check the microphone is still plugged in.',
  'record.micError.mic-lost.step2':
    'Check Microphone is still allowed in the site settings icon at the left end of the address bar.',
  'record.micError.mic-lost.step3': 'Choose Try again.',
  'tab.title': 'Tab',
  'library.title': 'Library',
  'tuner.title': 'Tuner',
  'settings.title': 'Settings',
  'settings.about': 'About',
  'settings.engineVersion': (version: string) => `Engine v${version}`,
  'settings.engineVersionUnavailable': 'Engine version unavailable',
} as const;

export type StringKey = keyof typeof strings;
