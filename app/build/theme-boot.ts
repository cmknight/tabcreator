/**
 * The theme boot script (story "Theme toggle", spine AD-12, AD-13): a tiny classic script,
 * `theme-boot.js`, loaded from <head> before the stylesheet in production builds, that sets
 * `data-theme` on <html> from the stored prefs before the first paint. `main.tsx` is a deferred
 * module, so without it a dark pref on a light OS would paint light first. External, not inline,
 * so the CSP needs no inline script; emitted into dist/, so the service worker precaches it.
 *
 * It reads prefs as `storage/prefs.ts`'s `parsePrefs` does for `theme` (a JSON object whose
 * `version` is a number ≥ 1, with `theme` `light` or `dark`; anything else is system), and sets
 * the attribute as `ui/theme-apply.ts`'s `applyTheme` does. tests/unit/theme-boot.test.ts runs
 * it against both over the same stored values.
 */
import type { Plugin } from 'vite';

/** The emitted file, at the root of dist/ next to index.html. */
export const THEME_BOOT_FILE = 'theme-boot.js';

/** `storage/prefs.ts`'s `PREFS_KEY` (asserted equal in the unit test). */
const PREFS_KEY = 'tabcreator.prefs.v1';

/** The boot script's source: plain ES5, never throws. */
export function themeBootSource(): string {
  return `(function () {
  try {
    var prefs = JSON.parse(localStorage.getItem(${JSON.stringify(PREFS_KEY)}));
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return;
    if (typeof prefs.version !== 'number' || !(prefs.version >= 1)) return;
    if (prefs.theme === 'light' || prefs.theme === 'dark') {
      document.documentElement.setAttribute('data-theme', prefs.theme);
    }
  } catch (e) {
    // No stored prefs, or unreadable: the system theme, as main.tsx would apply.
  }
})();
`;
}

/** Emits `theme-boot.js` and loads it from <head>, after the CSP meta and before any stylesheet. */
export function themeBoot(): Plugin {
  const viewport = /<meta name="viewport"[^>]*\/>/;
  return {
    name: 'tabcreator-theme-boot',
    apply: 'build',
    transformIndexHtml(html) {
      if (!viewport.test(html))
        throw new Error('index.html: no viewport meta to anchor theme-boot');
      return html.replace(
        viewport,
        (m) => `${m}\n    <script src="./${THEME_BOOT_FILE}"></script>`,
      );
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: THEME_BOOT_FILE, source: themeBootSource() });
    },
  };
}
