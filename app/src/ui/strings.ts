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
  'record.title': 'Record',
  'tab.title': 'Tab',
  'library.title': 'Library',
  'tuner.title': 'Tuner',
  'settings.title': 'Settings',
} as const;

export type StringKey = keyof typeof strings;
