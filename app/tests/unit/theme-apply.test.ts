import { afterEach, expect, it } from 'vitest';
import { createSettingsSession } from '../../src/session/settings-session';
import { applyTheme, followTheme } from '../../src/ui/theme-apply';

// Story "Theme toggle": the theme pref as `data-theme` on <html> (spine AD-12).

afterEach(() => {
  delete document.documentElement.dataset.theme;
});

it('light and dark set data-theme; system removes it', () => {
  const root = document.documentElement;
  applyTheme('dark');
  expect(root.dataset.theme).toBe('dark');
  applyTheme('light');
  expect(root.dataset.theme).toBe('light');
  applyTheme('system');
  expect(root.hasAttribute('data-theme')).toBe(false);
});

it('applies to the element it is given', () => {
  const el = document.createElement('div');
  applyTheme('dark', el);
  expect(el.getAttribute('data-theme')).toBe('dark');
  expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
});

it('followTheme applies each store change with no screen mounted, and stops on unsubscribe', () => {
  localStorage.clear();
  const session = createSettingsSession({ version: () => new Promise<string>(() => {}) });
  const stop = followTheme(session);
  const root = document.documentElement;
  expect(root.hasAttribute('data-theme')).toBe(false); // not at the call
  session.setTheme('dark');
  expect(root.dataset.theme).toBe('dark');
  session.setTheme('light');
  expect(root.dataset.theme).toBe('light');
  session.setTheme('system');
  expect(root.hasAttribute('data-theme')).toBe(false);
  stop();
  session.setTheme('dark');
  expect(root.hasAttribute('data-theme')).toBe(false);
  localStorage.clear();
});
