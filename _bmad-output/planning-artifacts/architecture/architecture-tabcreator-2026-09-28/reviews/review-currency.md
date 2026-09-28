# Review — Currency & Reality-Check Lens

- **Target:** `ARCHITECTURE-SPINE.md` (TabCreator v1), with `.memlog.md` as the author's version evidence
- **Lens:** Was every committed decision web-researched or reality-checked, rather than asserted from training data? Covers versions, whether each named technology still exists and fits, starter defaults, and platform APIs.
- **Reviewed:** 2026-09-28, against live registries and sources (commands and results below)

## Verdict

**Pass with fixes.** Every pinned version in the Stack table matches the live `latest` today. The one deliberate hold-back (TypeScript 6.0.3 instead of 7.0.2) is correct and recorded in the memlog. All of the pairwise peer ranges that were asked about are satisfied, and every platform API the spine relies on is standard and non-experimental in Chrome 153/154.

The gaps are in what was *not* checked:
- The stack leaves out packages the stories need, so agents would fill them in from training data.
- The wasm-pack → wasm-opt toolchain was never spike-built against Rust 1.98.
- rubato's API has changed completely since the version training data knows.
- One CAP-20 acceptance criterion depends on a Lighthouse category that no longer exists.
- The current `create-vite` starter defaults to oxlint, not the ESLint that AD-1 relies on.
- The developer's own local Node version falls outside the engine ranges of the pinned test stack.

## Findings

### F1 — Stack omits packages the stories and spine require (peers and siblings), so agents will pick versions from memory
- **Severity:** Medium
- **Location:** Stack table (lines 146–173); AD-1 (ESLint enforcement); story lines 13–15, 742 ("Vitest (unit, jsdom)", "React Testing Library")
- **Problem:** The stack pins the headline packages but not the packages they need in order to work as the stories describe. Agents will choose versions for the missing ones from training data (for example `@types/react@18` or `jsdom@24`), which is exactly what this lens exists to prevent. On the Rust side, `serde_json` is listed but `serde` (with `derive`) is not, even though the engine's camelCase JSON I/O convention needs `#[derive(Serialize, Deserialize)]` and `#[serde(rename_all = "camelCase")]`.
- **Evidence (live, 2026-09-28):**
  - `@types/react` 19.3.0 and `@types/react-dom` 19.3.0 (peer `@types/react ^19.3.0`). React 19 does not ship its own types. The current `create-vite` react-ts template (9.2.1) includes both.
  - `jsdom` 30.1.1: an optional peer of vitest 5.0.2, but it is the environment the stories name. Its engines are `^22.22.2 || ^24.15.0 || >=26`.
  - `@testing-library/react` 16.3.3 has a **required** peer on `@testing-library/dom ^10.0.0` (current 10.4.2), plus React and the types packages ^18 || ^19.
  - `eslint-plugin-react-hooks` 7.1.1 (peer includes eslint ^10) and `@eslint/js` 10.0.1 (peer eslint ^10). A flat-config setup for AD-1 needs both.
  - `serde` 1.0.229 (crates.io, 2026-07-18).
  - **@vitejs/plugin-react 6.1.1 peers are covered:** `vite ^8.0.0` is satisfied. `oxc-transform-react`, `@rolldown/plugin-babel` and `babel-plugin-react-compiler` are all marked `optional: true`. No required peer is missing for that plugin.
  - Type-lib gaps in TypeScript 6.0.3:
    - `createSyncAccessHandle` is declared only in `lib.webworker.d.ts`, not `lib.dom.d.ts`.
    - There is no AudioWorklet global-scope lib: `registerProcessor` is not declared, and `AudioWorkletProcessor` is only referenced in DOM. `@types/audioworklet` 0.0.100 exists.
- **Fix:**
  - Add rows for `@types/react` 19.3.0, `@types/react-dom` 19.3.0, `jsdom` 30.1.1, `@testing-library/react` 16.3.3, `@testing-library/dom` 10.4.2, `eslint-plugin-react-hooks` 7.1.1, `@eslint/js` 10.0.1, `@types/audioworklet` 0.0.100 and `serde` 1.0.229 (features `derive`).
  - Add one line under Conventions: worker files (`engine-worker.ts`, `opfs-worker.ts`) compile under a tsconfig with `lib: ["ES2023","WebWorker"]`, and `recorder-worklet.ts` uses `types: ["audioworklet"]`.

### F2 — wasm-pack 0.15.0 runs a 2024 wasm-opt against Rust 1.98 output; this was never spike-built
- **Severity:** Medium
- **Location:** Stack rows `Rust (stable) 1.98.1`, `wasm-bindgen 0.2.129`, `wasm-pack 0.15.0`; Deployment diagram (CI step "wasm-pack")
- **Problem:** Each version was checked on its own in a registry. Nobody checked that the three work together. wasm-pack 0.15.0 (released 2026-05-15) downloads **binaryen `version_117`** and runs `wasm-opt -O`. The only feature flags it adds are `--enable-reference-types` (when that is set) and `--enable-memory64` (for wasm64). Since Rust 1.87, `wasm32-unknown-unknown` turns on `bulk-memory` and `nontrapping-fptoint` by default. If the wasm-bindgen output does not carry a `target_features` section that wasm-opt 117 honours, validation fails ("Bulk memory operations require bulk memory"). The spine commits CI to `wasm-pack build` without evidence that this combination builds.
- **Evidence:**
  - wasm-pack 0.15.0 source, `src/install/mod.rs:207`: `vers = "version_117"`.
  - `src/command/build.rs:504-509` shows only the reference-types and memory64 flags.
  - Latest binaryen is `version_133` (2026-09-21).
  - The Rust stable docs (`platform-support/wasm32-unknown-unknown.md:132-133`) list `nontrapping-fptoint` and `bulk-memory` as enabled by default in Rust 1.87.0+.
  - Compatibility confirmed:
    - The wasm-bindgen-cli 0.2.129 prebuilt tarball that wasm-pack fetches exists (HTTP 200 on `github.com/wasm-bindgen/wasm-bindgen/releases/download/0.2.129/wasm-bindgen-0.2.129-x86_64-unknown-linux-musl.tar.gz`).
    - The wasm-bindgen 0.2.129 MSRV is 1.81, which Rust 1.98.1 exceeds.
    - wasm-pack has moved to the `wasm-bindgen/wasm-pack` org and is maintained; 0.15.0 fixed the npm-install 404 that affected 0.14.0.
- **Fix:**
  - Add a spike or first-story acceptance criterion: `wasm-pack build engine --target web` succeeds on Rust 1.98.1 in CI.
  - Pre-empt the risk in `engine/Cargo.toml` with `[package.metadata.wasm-pack.profile.release] wasm-opt = ["-O", "--enable-bulk-memory", "--enable-nontrapping-float-to-int"]`. The alternative is `wasm-opt = false` plus an explicitly pinned current binaryen step.
  - Add a Stack row for binaryen/wasm-opt.
  - Also state that `wasm-bindgen` in `Cargo.toml` is pinned with `=0.2.129`, so the CLI that wasm-pack auto-downloads matches exactly.

### F3 — rubato 5 API differs completely from the version training data knows, and it releases majors about every six weeks; AD-7 determinism depends on an exact pin
- **Severity:** Medium
- **Location:** Stack row `rubato 5.0.0`; AD-7; story line 475 ("resample to 22 050 Hz with `rubato` (sinc, 128 taps)")
- **Problem:** The version is correct, but the spine gives no API anchor, and the rubato API has been rewritten.
  - The pre-1.0 API that models know (`SincFixedIn`, `Vec<Vec<f32>>` I/O, `InterpolationParameters`) no longer exists.
  - rubato went 3.0.0 (2026-05-20) → 4.0.0 (2026-07-09) → 5.0.0 (2026-08-10), with breaking changes each time.
  - A caret `"5"` requirement is safe for now. However, any resampler change that alters output silently breaks AD-7 byte-identical results unless it is locked.
- **Evidence:**
  - rubato 5.0.0 source: `lib.rs` exports `Async`, `FixedAsync`, `Fft`, `FixedSync`, `SincInterpolationParameters` and `WindowFunction`, and re-exports `audioadapter`.
  - `Async::new_sinc(resample_ratio, max_resample_ratio_relative, &SincInterpolationParameters, chunk_size, nbr_channels, FixedAsync)` is at `asynchro.rs:269`. `Resampler::process_all` (the one-shot whole-clip method) was added in 4.0.
  - The v5 changelog moves to `audioadapter` 5.0 and raises the MSRV to 1.87.
  - A sinc resampler is **still offered**, so the story's requirement is achievable.
  - The default feature `fft_resampler` pulls in `realfft` → `rustfft 6.4.1`, the same version as the pinned rustfft, so the two agree.
- **Fix:**
  - Change the row to `rubato =5.0.0 (API: Async::new_sinc + SincInterpolationParameters::new(128, …), process_all; audioadapter 5)`.
  - Require `engine/Cargo.lock` to be committed.
  - Add to AD-7: bumping any DSP crate (rubato, rustfft) counts as an output-affecting change until the fixtures prove otherwise.
  - Optionally set `default-features = false` if the `Fft` resampler is unused, to keep the wasm smaller.

### F4 — CAP-20 relies on "Lighthouse PWA checks", but Lighthouse no longer has a PWA category
- **Severity:** Medium
- **Location:** Capability map row CAP-20 (`vite-plugin-pwa` config, service worker); inherited story AC at story line 924 ("Lighthouse PWA checks report installable with no errors")
- **Problem:** The spine adopts CAP-20 without reality-checking its verification method. The AC cannot be met with current Lighthouse.
- **Evidence:** In `lighthouse` 13.5.0 (npm latest), `core/config/default-config.js` defines only these categories: `performance`, `accessibility`, `best-practices`, `seo` and `agentic-browsing`. No PWA category exists, and no audit named `installable-manifest` exists. The PWA category was removed in Lighthouse 12.
- **Fix:** Add a spine note under CAP-20 that installability is verified by Playwright instead. Check that the manifest link resolves with the required fields and icons, that `navigator.serviceWorker.ready` resolves, and that the offline reload passes (already in the stories). Treat Chrome DevTools > Application > Manifest as the manual check. Then update the story AC.

### F5 — The current `create-vite` react-ts starter uses oxlint, not ESLint; AD-1's enforcement mechanism is not the starter default
- **Severity:** Low
- **Location:** AD-1 ("Enforce with ESLint `no-restricted-imports` per directory"); Stack row ESLint / typescript-eslint
- **Problem:** The spine names no starter. An agent scaffolding `app/` with `pnpm create vite --template react-ts` today gets `oxlint` ^1.81.0 and an `_oxlintrc.json`, not ESLint. It would then have to remove oxlint or run two linters alike. The template otherwise agrees with the spine: `typescript ~6.0.2`, `vite ^8.3.0`, `@vitejs/plugin-react ^6.1.1`, `react ^19.2.8`. It also includes `@types/react*` and `@types/node`, which supports F1.
- **Evidence:** `create-vite` 9.2.1, `template-react-ts/package.json`: `"lint": "oxlint"`; devDependencies include `oxlint`, and there is no `eslint`.
- **Fix:** Add one line to the Structural Seed saying either "Scaffold from `create-vite@9.2.1` react-ts, then replace oxlint with ESLint 10 flat config + typescript-eslint 8.70.1" or "Do not use a starter; hand-write the configs." Either way, make it explicit.

### F6 — Local Node (v25.6.1) is outside the engine ranges of vitest 5 and jsdom 30; no Node pin is enforced
- **Severity:** Low
- **Location:** Stack row `Node.js (LTS, build only) 24.21.0`
- **Problem:** 24.21.0 is correct: it is the current `Krypton` LTS on nodejs.org. However, the existing dev machine runs Node v25.6.1, an odd-numbered non-LTS release. vitest 5.0.2 declares engines `^22.12.0 || ^24.0.0 || >=26.0.0`, and jsdom 30.1.1 declares `^22.22.2 || ^24.15.0 || >=26.0.0`. Node 25 is excluded from both. The spine commits to a version but not to a way of enforcing it.
- **Evidence:** `node --version` → `v25.6.1` on this machine. The engine ranges come from the npm registry. Node 26.10.0 is current but not yet LTS; it is due for LTS around October 2026, which makes a bump likely soon.
- **Fix:** Add `.nvmrc` / `.node-version` set to `24.21.0`, `"engines": {"node": ">=24.21 <25"}`, `"packageManager": "pnpm@12.6.0"` and `engine-strict=true` in `.npmrc`. Record a revisit trigger for when Node 26 reaches LTS.

### F7 — Playwright 1.63.0 tests Chromium 153; Chrome stable is now 154
- **Severity:** Low
- **Location:** Stack rows `@playwright/test 1.63.0` and `Target browser: Chrome, last 2 stable versions`
- **Problem:** The e2e suite, which is the only browser gate, runs on the older of the two supported versions and never on the current one.
- **Evidence:** `playwright-core@1.63.0/browsers.json` → chromium `153.0.8010.12`. Chromium Dash Stable/Linux → `154.0.8037.57`, released 2026-09-23. 1.63.0 is still npm `latest`.
- **Fix:** Add a Playwright project with `channel: 'chrome'`, installed with `npx playwright install chrome`, alongside bundled Chromium. Alternatively, restate the target as "the Chromium bundled with the pinned Playwright, plus current stable, checked manually".

### F8 — CSP details not reality-checked against Vite dev or worker CSP scoping
- **Severity:** Low
- **Location:** AD-13 (CSP meta tag)
- **Problem:**
  - (a) The policy has no `style-src 'unsafe-inline'`. If the meta tag is present in the dev server's `index.html`, Vite dev injects CSS through `<style>` elements, and those injections are blocked. "Ships in every build" leaves open whether dev is covered.
  - (b) A `<meta>` CSP governs the document only. Dedicated workers loaded from same-origin URLs take their CSP from their own response headers, and GitHub Pages cannot set headers. So `'wasm-unsafe-eval'` limits nothing in `engine-worker.ts`, where the wasm actually compiles. AD-13's "nothing leaves the device" guarantee therefore does not reach the workers through CSP.
  - Both directives are otherwise current: `wasm-unsafe-eval` has been in Chrome since 97 and is standard-track and non-experimental.
- **Evidence:**
  - MDN browser-compat-data 8.1.3: `http.headers.Content-Security-Policy.script-src.wasm-unsafe-eval` added in Chrome 97, not experimental.
  - `api.Worker.Worker.options_type_parameter` has been in Chrome since 80.
- **Fix:**
  - Inject the meta tag only at build time (a `transformIndexHtml` plugin with `apply: 'build'`).
  - Reword AD-13 so that the no-network rule in workers is enforced by code review and lint (`no-restricted-globals: fetch, XMLHttpRequest, WebSocket` in `app/src/**`), not by CSP.

### F9 — TypeScript held at 6.0.3: verified and justified, but no revisit trigger
- **Severity:** Info
- **Location:** Stack row `TypeScript 6.0.3`; memlog line 10
- **Problem:** None in the decision itself. It is well-evidenced. The spine gives no signal for when to move to TS 7.
- **Evidence:**
  - npm `typescript` latest is 7.0.2 (2026-07-08); 6.0.3 was released 2026-04-16.
  - `typescript-eslint` 8.70.1 **and** the canary 8.70.2-alpha.12 both declare peer `typescript >=4.8.4 <6.1.0`.
  - The `create-vite` template also pins `~6.0.2`.
  - TS 6.0.3 defaults `strict` to `true` (`defaultValueDescription: true`) and emits "deprecated and will stop functioning in TypeScript 7" errors for legacy options.
- **Fix:** Add a note to the row: "Revisit when typescript-eslint's peer range admits 7.x; keep tsconfig free of TS-6-deprecated options (no `ignoreDeprecations`)."

### F10 — Platform APIs: all current in Chrome (verified)
- **Severity:** Info (no action)
- **Location:** AD-2, AD-3, AD-6, AD-9, AD-13; Structural Seed
- **Evidence:** Source is MDN browser-compat-data 8.1.3 (npm latest). Every entry below is standard-track, not deprecated and not experimental, with support in Chrome 153/154.

  | API | Chrome since |
  | --- | --- |
  | `LockManager.request` | 69 |
  | `FileSystemFileHandle.createSyncAccessHandle` | 102 (dedicated workers only, matching AD-2's `opfs-worker.ts`) |
  | `FileSystemSyncAccessHandle.flush` | 102 |
  | `StorageManager.getDirectory` | 86 |
  | `AudioWorklet` / `AudioWorkletNode` | 66 |
  | `MediaRecorder` and `isTypeSupported` | 47 (Chrome records `audio/webm;codecs=opus`) |
  | `crypto.randomUUID` | 92 |
  | Module workers | 80 |
  | CSP `wasm-unsafe-eval` | 97 |

  BCD has no separate sub-feature for the Web Locks `steal` option. It is part of the Web Locks spec that Chrome has shipped since 69.

  `useSyncExternalStore` is exported by `react@19.3.0` (present in `cjs/react.production.js`) and is a stable React 19 API.

  `idb@8.0.3` still exports `openDB(name, version, {upgrade, blocked, blocking, terminated})` and `deleteDB`. It was last released 2025-05-07; it is stable, not abandoned.
- **Fix:** None required. Two optional additions: AD-9's "durable per append" relies on calling `flush()` after each `write()`, so state that explicitly. AD-6's losing tab also needs the idb `blocking` callback to close its connection so the other tab can run a version upgrade.

## Verified as current (no finding)

| Package / tool | Spine | Live latest (2026-09-28) | Peer / compat check |
| --- | --- | --- | --- |
| react / react-dom | 19.3.0 | 19.3.0 | react-dom peer `react ^19.3.0` ✓ |
| vite | 8.3.1 | 8.3.1 (2026-09-24) | engines node `^20.19 \|\| >=22.12` ✓ |
| @vitejs/plugin-react | 6.1.1 | 6.1.1 | peer `vite ^8.0.0` ✓; other peers optional |
| vite-plugin-pwa | 1.3.0 | 1.3.0 | peer vite `…\|\| ^8.0.0` ✓; workbox-build/window 7.4.1 are direct deps |
| vitest | 5.0.2 | 5.0.2 | peer `vite ^6.4 \|\| ^7 \|\| ^8` ✓; engines node `^22.12 \|\| ^24 \|\| >=26` ✓ for 24.21 |
| typescript | 6.0.3 | 7.0.2 (held back, see F9) | typescript-eslint peer `<6.1.0` ✓ |
| eslint / typescript-eslint | 10.11.0 / 8.70.1 | same | ts-eslint peer `eslint ^8.57 \|\| ^9 \|\| ^10` ✓ |
| idb / fflate / fake-indexeddb | 8.0.3 / 0.8.3 / 6.2.5 | same | — |
| @playwright/test / @axe-core/playwright | 1.63.0 / 4.13.0 | same | axe peer `playwright-core >=1.0.0` ✓ |
| prettier / pnpm | 3.9.9 / 12.6.0 | same | — |
| Node.js LTS | 24.21.0 | 24.21.0 (Krypton) | see F6 |
| Rust stable | 1.98.1 | 1.98.1 (channel toml, 2026-09-01) | ≥ rubato MSRV 1.87, wasm-bindgen MSRV 1.81 ✓ |
| wasm-bindgen / wasm-pack | 0.2.129 / 0.15.0 | same | CLI 0.2.129 binary published ✓; see F2 |
| rustfft / rubato / serde_json | 6.4.1 / 5.0.0 / 1.0.151 | same | rubato's lockfile uses rustfft 6.4.1 ✓ |
| console_error_panic_hook | 0.1.7 | 0.1.7 (2021) | Old but still the latest release and still works; no action |

## Memlog evidence assessment

The memlog records a registry sweep (line 10) and the TypeScript/typescript-eslint peer conflict. That is good evidence for the Stack table as written. It records no check of:
- the peer ranges other than ts-eslint and vite-plugin-pwa,
- the Rust ↔ wasm-pack ↔ wasm-opt toolchain,
- the rubato API,
- the platform APIs,
- any starter template.

Findings F1–F5 fall in those unrecorded areas.

## Commands used (reproducible)

- `curl -s https://registry.npmjs.org/<pkg>/latest` (versions, `peerDependencies`, `peerDependenciesMeta`, `engines`), including the dist-tags for typescript, typescript-eslint and pnpm.
- `curl -s -A review https://crates.io/api/v1/crates/<crate>` (wasm-bindgen, wasm-bindgen-cli, wasm-pack, rustfft, rubato, serde, serde_json, console_error_panic_hook).
- `https://static.rust-lang.org/dist/channel-rust-stable.toml`, `https://nodejs.org/dist/index.json`, and Chromium Dash `fetch_releases?channel=Stable&platform=Linux`.
- Downloaded and inspected source for: rubato 5.0.0, wasm-pack 0.15.0, idb 8.0.3, typescript 6.0.3, react 19.3.0, playwright-core 1.63.0 `browsers.json`, lighthouse 13.5.0 `default-config.js`, create-vite 9.2.1 `template-react-ts`, and @mdn/browser-compat-data 8.1.3.
- Rust `wasm32-unknown-unknown` platform-support doc (stable branch) and binaryen GitHub latest release.
