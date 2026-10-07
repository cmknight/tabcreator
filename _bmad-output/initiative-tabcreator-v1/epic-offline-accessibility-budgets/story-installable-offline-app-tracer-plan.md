---
title: 'Installable offline app (tracer)'
type: 'feature'
ticket: '3'
created: '2026-10-07'
status: 'built'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: 'a4f0e515d098b0f3ff31bb7dad745b214ccec2a4'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: ['oversized']
deferred:
  - summary: >-
      No check proves a newly deployed service worker waits for the player (no skipWaiting) instead of taking over open tabs.
    evidence: |-
      Only the vite.config.ts options express it; switching to autoUpdate or adding skipWaiting would pass every current test. Story 4's two-build e2e is the natural place: its tickets.toml verify now says build B's worker stays waiting until Reload.
    location: >-
      app/vite.config.ts (VitePWA registerType 'prompt'); epic 7 entry 4
    severity: low
---

<intent-contract>

## Intent

**Problem:** TabCreator has no web app manifest, no icons and no service worker. It can't be installed, and it doesn't work without a network (CAP-20, US-8.1, AD-19; epic Done when 1).

**Approach:**
- Add `vite-plugin-pwa` with a manifest generated from the theme tokens and icons generated at build time.
- Precache the whole built app, including the wasm and every worker and worklet chunk.
- Prove the whole path in a production-build Playwright run. After one online visit, with the network off, the player records, analyses, edits and exports.

## Boundaries & Constraints

**Always:**
- **Dependency:** add `vite-plugin-pwa` **1.3.0** (the spine pin; its vite peer range includes `^8.0.0`) as an exact-pinned dev dependency, with the updated `pnpm-lock.yaml` committed. Do not use `@vite-pwa/assets-generator`, which pulls in sharp. Note the new dependency in the commit message (spine Dependencies convention: workbox-window ships in a lazy chunk).
- **Plugin settings:**
  - `registerType: 'prompt'` (AD-19);
  - `injectRegister: false`;
  - registration from `main.tsx` through `virtual:pwa-register` `registerSW({ immediate: true })`, after render, guarded by `'serviceWorker' in navigator` (plan decision: bundled, external code, so CSP-safe under AD-13; story 4 adds `onNeedRefresh`/`onNeedReload` to this same call);
  - `workbox.clientsClaim: true`, so the first visit is controlled without a reload;
  - default `cleanupOutdatedCaches` and `navigateFallback`;
  - add `vite-plugin-pwa/client` to `app/tsconfig.json` types.
  - The CSP string in `vite.config.ts` stays unchanged.
- **Precache:** the default `**/*.{js,wasm,css,html}` plus the icons and the manifest, so the shell, every JS chunk (engine, engine-worker, opfs, backup, waveform, recorder-worklet), CSS, `engine_bg-*.wasm` and the icons are all cached. No hashes are listed by hand. There are no web fonts (system stacks), so none are cached.
- **Manifest:**
  - fields: `name` and `short_name` "TabCreator", `display: 'standalone'`, `start_url`, `scope` and `id` all `'./'`;
  - `background_color` and `theme_color` = the light `--color-background` token (plan decision);
  - the colours are read from `app/src/ui/theme.css` at build time (AD-12: generated from tokens, not hand-copied), and a unit test asserts the manifest values equal the parsed tokens.
- **Icons** (user decision: the builder generates them):
  - a simple token-coloured glyph (`--color-primary` mark on `--color-background`) drawn by a small zero-dependency build-time module that writes PNGs with `node:zlib` and CRC32;
  - 192 and 512 `purpose: 'any'`, plus a 512 `purpose: 'maskable'` whose glyph sits inside the safe zone;
  - emitted into `dist` by a Vite plugin and listed in the manifest and the precache;
  - no native dependencies, nothing committed under `public/` that could drift from the tokens.
- **Base path:** a relative base (`'./'`), so scope, `start_url` and the precache work at the root and under `/tabcreator/`. `serve-subpath.ts` gains the `application/manifest+json` MIME type.
- **CI** (`.github/workflows/ci.yml`, after the "CSP and relative assets" step):
  - dist has `manifest.webmanifest`, `sw.js` and the icons;
  - `sw.js` names the wasm and every worker and worklet chunk;
  - index.html links `./manifest.webmanifest` and has no inline `<script>`.

**Never:**
- No update toast or update flow; that is story 4.
- No capability check; that is story 5.
- No CSP change.
- No `skipWaiting`.
- No dev-mode service worker.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Manifest | production build at the root | the manifest validates (CDP `Page.getAppManifest` reports no errors); name, standalone, icons 192/512/maskable; colours equal the tokens | none |
| Installable | the same | CDP `Page.getInstallabilityErrors` is empty | if headless shell lacks it, that spec runs in a project with `channel: 'chromium'` |
| Controlled | first visit | the service worker is registered and `navigator.serviceWorker.controller` is set after `ready` | none |
| Offline flow | prod-mic: one online visit, then `context.setOffline(true)` and reload | the app loads from the service worker (navigation and assets `fromServiceWorker()`); record a take, it analyses, edit one note (stored change), Copy and Download give the tab text | the failed `sw.js` update check while offline is the only tolerated network error |
| Sub-path | the subpath project under `/tabcreator/` | the manifest, scope and controller resolve under the sub-path; installable | none |
| CSP | `csp.spec` | still no violations, no inline script | none |

</intent-contract>

## Code Map

- **`app/vite.config.ts`:** the CSP meta plugin :9-27 (`worker-src 'self' blob:` already covers `sw.js`; `manifest-src` falls back to `default-src 'self'`), `base: './'` :32, `assetsInlineLimit: 0` :35, workers as ES :38-40.
- **`app/src/main.tsx`:** start order: theme, the DEV fake mic, `instanceLock.start()` :31, `recheckStorageFull()` :36, render. Registration goes after render.
- **`app/src/ui/theme.css`:** light `:root` `--color-background #fafaf7` :11, `--color-primary #1f5fad` :16; dark :57-63.
- **`app/tsconfig.json`:** `types`.
- **`vite-plugin-pwa` 1.3.0:**
  - `injectRegister: 'inline'` would break CSP;
  - `false` plus `virtual:pwa-register` lazy-loads workbox-window (about 1.4 KB gz, not initial JS);
  - the dev stub is a no-op;
  - icons are auto-added only from `publicDir`, so set `globPatterns` to include `png`, `svg` and `webmanifest`.
- **Playwright** (`app/playwright.config.ts`):
  - `chromium` :56-60 (port 4173); `prod-mic` :61-79 (`*.prod.spec.ts`, fake device, microphone permission); `subpath` :80-87 (port 4174, `/tabcreator/`, `tests/e2e/serve-subpath.ts:14-23` MIME map).
  - Helpers:
    - `goLive` (`mic-helpers.ts:25-41`);
    - the record/stop/analyse pattern (`record.prod.spec.ts:147-165`);
    - note editing (`tab-edit.dev.spec.ts:84-90`, `tab-helpers.ts:120`);
    - `readTab` (`storage-helpers.ts:75`);
    - Copy and Download (private to `export.dev.spec.ts:14-54`; move them to a shared helper).
  - Clipboard needs `context.grantPermissions(['clipboard-read','clipboard-write'])`.
  - `tests/e2e/csp.spec.ts:7-33` and `hygiene.ts` (failed requests and console errors).
- **CI:** `.github/workflows/ci.yml` `pnpm install --frozen-lockfile` :60-61; dist greps :181-224; "CSP and relative assets" :226-243; Pages upload :245.
- **For story 4:** the plugin's client reloads on `controlling` unless `onNeedReload` is passed; `session/app-reload.ts` `reloadApp`/`isAppBusy` :40-47.

## Tasks & Acceptance

**Execution:**
- [x] `app/package.json` and `pnpm-lock.yaml`: add `vite-plugin-pwa@1.3.0` (exact).
- [x] `app/vite.config.ts` and a small build module (e.g. `app/build/pwa-icons.ts`): the plugin config, the manifest from tokens, and the icon generation; a unit test that the colours equal the tokens and the PNGs decode at the right sizes.
- [x] `app/src/main.tsx` and `app/tsconfig.json`: registration.
- [x] `app/tests/e2e/serve-subpath.ts`: the manifest MIME type.
- [x] `app/tests/e2e/offline.prod.spec.ts` (new) and a shared export helper: the manifest, installable, controlled and offline-flow rows; the sub-path row in `subpath.spec.ts`; the hygiene allowance for the offline `sw.js` update check.
- [x] `.github/workflows/ci.yml`: the dist checks.

**Acceptance Criteria:**
- Given the production build after one online visit, when the network is off and the page reloads, then a player records a take that analyses, edits a note, and copies and downloads the tab.
- Given the production build at the root and at `/tabcreator/`, when it loads, then Chrome reports it installable and a service worker controls the page.
- Given the full verification, when it runs, then it exits 0.

## Implementation Notes

- **Icons and manifest:** `app/build/pwa-icons.ts` reads the light `:root` tokens from `theme.css`, draws a six-line tab staff with a note head (`--color-primary` on `--color-background`, 4x4 supersampled) and writes RGBA PNGs with `node:zlib` and its own CRC32. The `pwaIcons()` plugin emits `icons/icon-192.png`, `icons/icon-512.png` and `icons/icon-maskable-512.png` in `generateBundle`, before vite-plugin-pwa globs `dist/` at `closeBundle`. The maskable glyph spans 52 % (corners at about 0.37 of the size from the centre, inside the 0.4 safe zone; unit-tested pixel by pixel).
- **Precache:** `globPatterns: ['**/*.{js,wasm,css,html,png,svg}']`. `webmanifest` is left out of the glob because the plugin already adds `manifest.webmanifest` as an additional entry; globbing it too would list it twice. The built `sw.js` precaches 15 entries: index.html, the manifest, the three icons and every file in `assets/` (wasm, engine glue, engine/opfs/backup/waveform workers, recorder worklet, workbox-window chunk, CSS, index JS).
- **Registration:** `main.tsx` imports `registerSW` from `virtual:pwa-register` statically and calls it once the window has loaded (or at once if the document is already complete), inside `'serviceWorker' in navigator`, with `onRegisterError` logging through `devWarn`; so the precache install does not compete with the first load. workbox-window is loaded by the plugin's client in its own lazy chunk (`assets/workbox-window.prod.es5-*.js`, 2.2 KB gz). The index chunk grew about 2.3 KB raw.
- **Hygiene:** failed requests issued by the service worker itself (`request.serviceWorker()`, e.g. a precache fetch aborted at context close) are ignored; page requests stay strict. `watchHygiene(page, baseURL, { offline: true })` also tolerates a failed `…/sw.js net::ERR_INTERNET_DISCONNECTED` update check. `collectErrors` ignores Playwright's "Service Worker registration blocked by Playwright…" message (matched by prefix).
- **Offline coverage:** besides the reload, fresh offline pages open at `./` and at `#/tab/<id>` of the recorded take (showing the edited note), all from the service worker; the sub-path spec also reloads offline under `/tabcreator/`.
- **CI step:** also requires `index.html` (the navigation fallback) in the precache and every root `workbox-*.js` to exist and be imported by `sw.js`; the inline-script check reads the newline-stripped HTML.
- **Engine spec:** `engine.spec.ts` now runs with `serviceWorkers: 'block'`. Its tests route the wasm with `page.route`, and once the service worker controls the page it would serve the precached wasm past the route (a race with the engine worker's first fetch).
- **Installability:** `Page.getInstallabilityErrors` works in the default headless shell, so no `channel: 'chromium'` project was needed.

## Plan Change Log

- **workbox-window 7.4.1 added as an exact runtime dependency** (alongside vite-plugin-pwa 1.3.0). The plugin's `virtual:pwa-register` imports `workbox-window`, which pnpm's strict layout does not resolve from `app/` through the plugin's own dependency, and the build failed without it. The spine's Dependencies note already expects workbox-window in a lazy chunk; same version the plugin resolves.

## Review Triage Log

### 2026-10-07 — Review pass
- verdicts: 28 findings — high 0, medium 0, low 20, false 8, maybe-false 0
- findings:
  - `low` `defer` (verification) nothing checks that a new service worker waits for the player (no `skipWaiting`) — story 4's two-build e2e is the natural test; its entry's verify now says build B's worker stays waiting until Reload (handoff recorded in tickets.toml).
  - `low` `patch` (intent) offline is never shown under `/tabcreator/` — the subpath spec now goes offline and reloads.
  - `false` `reject` (intent) registration through `virtual:pwa-register` instead of the plugin's `registerSW.js` — a recorded plan decision; it is external, bundled code (AD-13) and gives story 4 its callbacks.
  - `low` `reject` (intent) no SVG stage in the icon pipeline — the user's decision is a token-coloured glyph the builder generates; the PNGs come straight from the same shape, so nothing can drift.
  - `false` `reject` (intent) `theme_color` uses the background token, not the primary — a recorded plan decision; both are read from tokens.
  - `false` `reject` (intent) no font extensions in the precache — the app ships no font files (system stacks); CI's per-file grep would catch one added under `assets/`.
  - `low` `patch` (intent) CI's precache check skips `index.html` and the workbox runtime — both added.
  - `false` `reject` (intent) hygiene's offline carve-out — limited to the failed `sw.js` update check; any CSP or off-origin problem still fails.
  - `low` `reject` (intent) `engine.spec` blocks the service worker, so its wasm routes don't cover the worker-served path — the offline spec covers that path.
  - `low` `reject` (blind) no update path until story 4 lands — a waiting worker activates once every TabCreator tab closes; story 4 is next in the loop.
  - `low` `patch` (blind) CI misses `index.html` and `workbox-*.js` — same fix.
  - `low` `patch` (blind) the "after first render" comment is wrong, and registration competes with first load — registration now waits for `load`.
  - `low` `patch` (blind) registration errors are silent — `onRegisterError` logs; an offline-ready notice is not in this story.
  - `low` `reject` (blind) no dark or in-page `theme-color` meta — not in the ticket; the manifest colour follows AD-12.
  - `low` `patch` (blind) the manifest lacks `description` — added; screenshots and apple-touch-icon are rejected (desktop Chrome target, CAP-22).
  - `low` `patch` (blind) the offline test never opens a fresh page or a deep link offline, nor goes offline under the sub-path — added.
  - `low` `patch` (blind) the unit test's token parser isn't independent — expected values pinned.
  - `low` `patch` (blind) the build module's error paths are untested — tests added.
  - `low` `patch` (blind) a live service worker in other production specs may flake on precache fetches — hygiene ignores worker-originated failed requests.
  - `low` `patch` (blind) the blocked-worker filter matches exact text — prefix or regex now.
  - `false` `reject` (blind) the manifest and icons react differently to theme edits in `vite build --watch` — watch mode is not used; a normal build reads both fresh.
  - `false` `reject` (blind) the CI chunk loop is hard to follow — it works; readability alone.
  - `false` `reject` (blind) the inline-script check is line-based — fixed under the CI row (`tr -d` plus a tag match).
  - `low` `patch` (edge) the edit target may be undefined — asserted explicitly.
  - `low` `patch` (edge) registration rejection is swallowed — same as the blind row.
  - `low` `patch` (edge) CI misses `index.html` — same fix.
  - `low` `patch` (edge) inline script across lines or with `data-src` — tag-level match.
  - `false` `reject` (edge) a comment inside the light `:root` block breaks the parse — guarded anyway: comments are stripped and the regex is anchored (patched as hardening; theme.css has no such comment today).

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` (repo root, `~/.cargo/bin` on PATH) — expected: all exit 0.
- `ls app/dist/manifest.webmanifest app/dist/sw.js` — expected: both exist.

## Auto Run Result

- **Summary:** TabCreator is now an installable, offline PWA (the epic 7 tracer).
  - **Plugin:** `vite-plugin-pwa` 1.3.0 with `registerType: 'prompt'`, `injectRegister: false` and `clientsClaim`, with no `skipWaiting` and no CSP change.
  - **Registration:** through `virtual:pwa-register` in `main.tsx` on window `load`; errors go to `devWarn`.
  - **Manifest:** generated from the light `theme.css` tokens: TabCreator, standalone, `./` scope and `start_url`, plus a description.
  - **Icons:** 192, 512 and a 512 maskable, drawn by a zero-dependency build-time PNG writer in the token colours.
  - **Precache:** index.html, the manifest, the icons, every JS chunk, the CSS and the engine wasm (15 entries). Fonts are not needed (system stacks).
  - **Proof:** a prod-mic e2e, after one online visit and with the network off:
    - records a take, which analyses;
    - edits a note;
    - copies and downloads the tab;
    - opens fresh pages at `./` and at `#/tab/<id>`, all served by the service worker.

    Installability is checked through CDP at the root and under `/tabcreator/`, and the sub-path also loads offline.
  - **CI:** checks dist for the manifest, `sw.js`, the icons, `index.html` and the workbox runtime in the precache, and no inline script.
- **New dependencies:** `vite-plugin-pwa` 1.3.0 (dev) and `workbox-window` 7.4.1 (runtime, in a lazy chunk of about 2 KB gz; needed because pnpm can't resolve the plugin's virtual import otherwise). Both are exact-pinned.
- **Files changed:**
  - **New:** `app/build/pwa-icons.ts`.
  - **Config:** `app/vite.config.ts`, `app/src/main.tsx`, `app/tsconfig{,.node}.json`, `app/package.json`, `pnpm-lock.yaml`, `.github/workflows/ci.yml`.
  - **Tests:**
    - new: unit `pwa-icons.test.ts`; e2e `offline.prod.spec.ts`, `pwa-helpers.ts`, `export-helpers.ts`;
    - changed: `subpath.spec.ts`, `serve-subpath.ts`, `hygiene.ts`, `helpers.ts`, `engine.spec.ts` (blocks the service worker so its wasm routes apply), `export.dev.spec.ts`.
- **Review:** 28 findings (low 20, false 8).
  - Patched:
    - the CI precache check (`index.html`, workbox, tag-level inline-script check);
    - registration on load with an error log;
    - the offline fresh-page, deep-link and sub-path checks;
    - hygiene ignoring service-worker fetches;
    - a regex blocked-worker filter;
    - comment-safe token parsing;
    - pinned and error-path unit tests;
    - the manifest description.
  - One item deferred to story 4 (proving a new worker waits for Reload); its ticket now says so.
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 0, low 8 groups.
- **Verification:** the full plan command exited 0: 1888 unit tests; 220 e2e passed, 3 flaky passing on retry (the known timing tests); `app/dist/manifest.webmanifest` and `sw.js` exist.
- **Residual risks:**
  - Until story 4 lands, a new deploy's service worker waits until every TabCreator tab closes.
  - A future production spec that uses `page.route` must block service workers, as `engine.spec.ts` does.
