import { afterEach, expect, it } from 'vitest';
import { themeBootSource } from '../../build/theme-boot';
import { parsePrefs, PREFS_KEY } from '../../src/storage/prefs';
import { applyTheme } from '../../src/ui/theme-apply';

// Story "Theme toggle": the production boot script (build/theme-boot.ts) sets the same
// `data-theme` as main.tsx's `applyTheme(loadPrefs().theme)`, for every kind of stored value.

const root = document.documentElement;

afterEach(() => {
  localStorage.clear();
  delete root.dataset.theme;
});

const STORED: (string | null)[] = [
  null,
  'not json',
  'null',
  '[]',
  '"dark"',
  '{}',
  ...[
    { version: 1, theme: 'dark' },
    { version: 1, theme: 'light' },
    { version: 1, theme: 'system' },
    { version: 1, theme: 'purple' },
    { version: 1, theme: ['dark'] },
    { theme: 'dark' },
    { version: 0, theme: 'dark' },
    { version: '1', theme: 'dark' },
    { version: 2, theme: 'light' },
    { version: 1, theme: 'dark', barLines: 'bad', countIn: null },
  ].map((v) => JSON.stringify(v)),
];

/** `data-theme` after running the boot script over `stored`. */
function boot(stored: string | null): string | null {
  delete root.dataset.theme;
  localStorage.clear();
  if (stored !== null) localStorage.setItem(PREFS_KEY, stored);
  new Function(themeBootSource())();
  return root.getAttribute('data-theme');
}

/** `data-theme` after the app's own path: parse the prefs, apply the theme. */
function app(stored: string | null): string | null {
  delete root.dataset.theme;
  applyTheme(parsePrefs(stored).theme);
  return root.getAttribute('data-theme');
}

it.each(STORED)('agrees with the app for stored %s', (stored) => {
  expect(boot(stored)).toBe(app(stored));
});

it('reads the prefs key and sets dark and light', () => {
  expect(themeBootSource()).toContain(JSON.stringify(PREFS_KEY));
  expect(boot(JSON.stringify({ version: 1, theme: 'dark' }))).toBe('dark');
  expect(boot(JSON.stringify({ version: 1, theme: 'light' }))).toBe('light');
});

it('never throws when localStorage is unreadable', () => {
  const desc = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() {
      throw new DOMException('denied', 'SecurityError');
    },
  });
  try {
    expect(() => new Function(themeBootSource())()).not.toThrow();
    expect(root.hasAttribute('data-theme')).toBe(false);
  } finally {
    Object.defineProperty(window, 'localStorage', desc);
  }
});
