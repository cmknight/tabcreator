// The theme pref on the page (spine AD-12; DESIGN.md Colors, Settings → Appearance): `light` and
// `dark` set `data-theme` on <html>, which `theme.css` keys its token values on; `system` removes
// it, so the `prefers-color-scheme` block decides. In production builds `build/theme-boot.ts`'s
// classic script has already set it from the stored pref before the stylesheet loads; `main.tsx`
// applies it again before the first render (the dev server has no boot script) and then has
// `followTheme` keep it in step with settings-session, whichever screen is showing.

import type { ThemePref } from '../model/types';
import type { SettingsSession } from '../session/settings-session';

export function applyTheme(pref: ThemePref, root: HTMLElement = document.documentElement): void {
  if (pref === 'light' || pref === 'dark') root.dataset.theme = pref;
  else delete root.dataset.theme;
}

/**
 * Applies the store's theme each time it changes (not at the call: the caller has applied the
 * stored pref already). Returns the unsubscribe.
 */
export function followTheme(
  session: Pick<SettingsSession, 'subscribePrefs' | 'getSnapshot'>,
  root: HTMLElement = document.documentElement,
): () => void {
  let applied = session.getSnapshot().prefs.theme;
  return session.subscribePrefs(() => {
    const { theme } = session.getSnapshot().prefs;
    if (theme === applied) return;
    applied = theme;
    applyTheme(theme, root);
  });
}
