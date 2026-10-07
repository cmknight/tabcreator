---
title: 'Theme toggle'
type: 'feature'
ticket: '6'
created: '2026-10-07'
status: done
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '7c535210897b0b7b992047e54242ca7f7e76b7eb'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** The dark tokens exist, and so does a stored `theme` pref (system, light or dark). But nothing applies the pref, and Settings has no Appearance control, so dark mode only follows the system (AD-12, DESIGN.md :181, :271; CAP-21).

**Approach:**
- `main.tsx` sets `data-theme` on the root element from the stored pref, synchronously, before the first render.
- Settings gains an Appearance panel with a Theme segmented control (System, Light, Dark), handled by settings-session. A change applies at once and is saved.

## Boundaries & Constraints

**Always:**
- **Before first render:** `main.tsx` reads the stored pref with the existing synchronous `loadPrefs()` and applies it before `createRoot().render`, and before the capability gate, so the unsupported screen is themed too.
  - `light` and `dark` set `document.documentElement.dataset.theme`.
  - `system` removes the attribute, so `theme.css`'s `prefers-color-scheme` block applies.
  - This is one small pure helper, e.g. `applyTheme(pref, root = document.documentElement)` in `ui/` (the DOM attribute is UI), used both at startup and on change.
- **settings-session:**
  - handles `theme` (adds it to `SettingsPrefs`);
  - `setTheme(pref)` saves it through `updatePrefs` and updates the snapshot;
  - the Settings screen calls `applyTheme` when the snapshot's theme changes.
- **Settings screen:**
  - an "Appearance" panel between Defaults and Storage (DESIGN.md :271), styled like the other panels, with `aria-labelledby` on its heading;
  - "Theme" is a segmented control of three buttons, "System", "Light" and "Dark", with `aria-pressed` on the selected one, following the speed control in `PlaybackControls.tsx` (the selected segment uses the pressed style);
  - keyboard: Tab to the group, then Enter or Space on each button;
  - strings in `ui/strings.ts`, theme tokens only.
- **No light flash on reload:** the attribute is set before React renders anything.

**Never:**
- No per-screen theme.
- No change to the token values.
- No `theme-color` meta or manifest change.
- No new storage key (the pref already exists).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Choose Dark | Settings → Dark | `data-theme="dark"`, dark tokens applied (e.g. body background is `--color-background` dark); saved | none |
| Reload | pref dark; reload | `data-theme="dark"` present before first paint (asserted from an init-time observation, not after render) | none |
| System | pref system; emulate `prefers-color-scheme: dark` / light | no attribute; tokens follow the emulation | none |
| Light over dark system | pref light; system dark | `data-theme="light"`; light tokens | none |
| Bad stored value | localStorage theme `"purple"` | treated as system (`parsePrefs` already defaults) | none |
| Unsupported screen | a required API missing; pref dark | the unsupported screen renders dark | none |
| axe | Settings in light and dark | no serious or critical violations | none |

</intent-contract>

## Code Map

- **Prefs:** `app/src/model/types.ts:96` (`theme: ThemePref`); `app/src/storage/prefs.ts`: default `'system'` :19, parsing :64, `loadPrefs` :92, `updatePrefs` :119.
- **`app/src/ui/theme.css`:** `@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) … }` :55-56; `:root[data-theme='dark']` :80.
- **`app/src/main.tsx`:** the capability gate (story 7.5), then `startApp(root)`. Apply the theme before the gate.
- **`app/src/session/settings-session.ts`:** `SettingsPrefs = Pick<Prefs, 'barLines' | 'analysisDefaults'>` :35; `updatePrefs` import :17; snapshot :22-29.
- **`app/src/ui/screens/Settings.tsx`:** panels: Defaults :61-70, Storage :71-94, About :95-102 (`settingsStyles.panel` / `panelTitle`).
- **`app/src/ui/components/PlaybackControls.tsx:57`:** the segmented control precedent (`aria-pressed`).
- **DESIGN.md:** :181 (dark mode via the Settings toggle), :271 (Appearance panel; Theme segmented control).
- **Tests:** `tests/unit/settings-session.test.ts`, `settings-screen.test.tsx`, `prefs.test.ts`. e2e: a new `tests/e2e/theme.dev.spec.ts`, using `page.emulateMedia({ colorScheme })` and `expectNoSeriousAxe` (`mic-helpers.ts`).

## Tasks & Acceptance

**Execution:**
- [x] `app/src/ui/theme-apply.ts` (or similar) `applyTheme`, and `app/src/main.tsx`: apply before render and before the gate.
- [x] `app/src/session/settings-session.ts`: the theme in the snapshot and `setTheme`. Unit tests.
- [x] `app/src/ui/screens/Settings.tsx`, its CSS module, `strings.ts`: the Appearance panel and the segmented control. Unit tests for `aria-pressed`, the click calling `setTheme`, and the attribute changing.
- [x] `app/tests/e2e/theme.dev.spec.ts`: the Choose Dark, Reload (attribute present at DOMContentLoaded via an init script that records `documentElement.dataset.theme` on the first `DOMContentLoaded`), System, Light-over-dark and axe rows.

**Acceptance Criteria:**
- Given Settings, when the player picks Dark, then the app turns dark at once and stays dark after a reload, with no light flash.
- Given the full verification, when it runs, then it exits 0.

## Implementation Notes

## Plan Change Log

## Review Triage Log

### 2026-10-07 — Review pass
- verdicts: 19 findings — high 0, medium 1, low 13, false 5, maybe-false 0
- findings:
  - `low` `patch` (edge) the theme is applied in a `useEffect` after paint — applied from one store subscriber in `main.tsx`; the Settings effect removed.
  - `medium` `patch` (edge, claim) a production build can paint light before the deferred module runs — an external classic boot script in `<head>` sets `data-theme` before first paint (no inline script, AD-13).
  - `low` `patch` (edge, claim) the flash test checks DOMContentLoaded on dev only — a production-build first-frame test added.
  - `low` `patch` (intent) "no light flash" is proven by mechanism, not first paint — same fix.
  - `low` `patch` (intent) applying the theme lives in the Settings screen, not the store — one subscriber.
  - `false` `reject` (intent) only one token is checked — `theme.css` swaps every token under the same selectors; one representative computed value proves the selector applies.
  - `low` `patch` (intent) axe never runs on System with a dark OS — added.
  - `false` `reject` (intent) the stored-value mapping is tested indirectly — `parsePrefs` already has its own `prefs.test.ts` coverage.
  - `false` `reject` (intent) no shared theme-seeding helper for stories 10 and 12 — those stories can seed the same pref; nothing in this ticket asks for a helper.
  - `low` `patch` (blind) no light flash is not guaranteed in production — same fix.
  - `low` `patch` (blind) the e2e flash check is weaker than the criterion — same fix.
  - `low` `patch` (blind) `useEffect` after paint — same fix.
  - `low` `patch` (blind) applying depends on Settings being mounted — same fix.
  - `low` `reject` (blind) the segmented-control CSS is copied from the speed control — a sweep item (shared `SegmentedControl`).
  - `false` `reject` (blind) `aria-pressed` vs radiogroup semantics — follows the established speed-control precedent (DESIGN: "selected segment uses the pressed style"); kept consistent.
  - `low` `reject` (blind) a failed theme save is silent — matches `setBarLines`; the theme still applies for the page session.
  - `low` `reject` (blind) the keyboard test gaps (no System, no Tab-in check) — Enter and Space are covered; the axe and unit tests cover the rest.
  - `false` `reject` (blind) every hand-built snapshot fixture had to change — test ergonomics, not a defect.
  - `low` `patch` (blind) the doc line width and the undocumented strings — fixed.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && TABCREATOR_E2E_BUILD=B pnpm --filter app exec vite build && CI=1 pnpm e2e'` (repo root, `~/.cargo/bin` on PATH) — expected: all exit 0.

## Auto Run Result

- **Summary:**
  - **Settings control:** Settings gains an Appearance panel with a Theme segmented control (System, Light, Dark, `aria-pressed`, the speed-control pattern). It is backed by settings-session `setTheme`, which saves the existing `theme` pref.
  - **Applying the theme:** a single subscriber, `followTheme` in `ui/theme-apply.ts`, started in `main.tsx`, sets or removes `data-theme` on `<html>` whenever the pref changes.
  - **No flash on load:**
    - `main.tsx` applies the stored pref before the capability gate and the first render, so the unsupported screen is themed too.
    - In production a tiny external classic script, `theme-boot.js` (emitted by a build-time Vite plugin, injected in `<head>` before the stylesheet, precached, no inline code), sets the attribute before first paint.
    - A unit test keeps it in step with `parsePrefs` and `applyTheme`.
- **Files changed:**
  - **New:** `app/src/ui/theme-apply.ts`, `app/build/theme-boot.ts`.
  - **Source:** `app/src/main.tsx`, `app/vite.config.ts`, `app/src/session/settings-session.ts`, `app/src/ui/screens/Settings.{tsx,module.css}`, `app/src/ui/strings.ts`.
  - **Tests:**
    - unit `theme-apply`, `theme-boot` (new), settings-session, settings-screen, settings-reload, tab-screen;
    - e2e `theme.dev.spec.ts` and `theme-boot.spec.ts` (new; a production first-frame check).
- **Review:** 19 findings (medium 1, low 13, false 5).
  - Patched:
    - the production first-paint flash (boot script and its prod test);
    - applying from the store, not the Settings screen;
    - axe on System with a dark OS;
    - doc and comment fixes.
  - Rejected: the shared segmented-control CSS (a sweep item), radiogroup semantics (kept consistent with the speed control), the silent failed save (matches `setBarLines`).
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 1, low 4 groups.
- **Verification:**
  - The full plan command exited 0: 2003 unit, 252 e2e, no retries.
  - The first-frame test was shown to fail without the boot script.
  - The pre-patch run needed one e2e re-run (the count-in flake).
- **Residual risks:**
  - The boot script hard-codes the prefs key and the allowed values; a unit test guards the drift.
  - The segmented-control CSS is duplicated from PlaybackControls.
