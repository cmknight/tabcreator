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
  'tab.title': 'Tab',
  'library.title': 'Library',
  'tuner.title': 'Tuner',
  'settings.title': 'Settings',
  'settings.about': 'About',
  'settings.engineVersion': (version: string) => `Engine v${version}`,
  'settings.engineVersionUnavailable': 'Engine version unavailable',
} as const;

export type StringKey = keyof typeof strings;
