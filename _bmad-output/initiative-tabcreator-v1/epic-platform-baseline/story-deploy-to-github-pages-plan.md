---
title: 'Deploy to GitHub Pages'
type: 'feature'
ticket: '5'
created: '2026-10-01'
status: 'built'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: true
baseline_revision: '819474b10a3d695257a6e2f790617f21c0ba3f48'
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The meta-tag CSP does not apply to workers and GitHub Pages cannot send CSP headers, so the engine and OPFS workers run without any CSP and 'wasm-unsafe-eval' is never enforced.
    evidence: |-
      Implementer showed removing 'wasm-unsafe-eval' still passes csp.spec.ts; workers loaded from URLs take CSP from their response headers, which Pages does not set. Spine AD-13 assumes the meta tag covers the app. Needs an architecture decision (accept, or self-host behind headers).
    location: >-
      app/vite.config.ts CSP; spine AD-13
    severity: medium
---

<intent-contract>

## Intent

**Problem:** The app builds but is not published, and the production build neither enforces spine AD-13 (CSP, no inlined assets, no non-self requests) nor works under a sub-path such as `/tabcreator/`.

**Approach:** Make every production build relative-based (`base: './'`), CSP-tagged and inline-free; add a CI deploy job that publishes the already-verified `app/dist` to GitHub Pages on pushes to `main`; and prove CSP and request hygiene with Playwright against the built site. The owner enables Pages with GitHub Actions as the source.

## Boundaries & Constraints

**Always:** CSP meta tag exactly `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; media-src 'self' blob:; connect-src 'self'` in every production `index.html`, injected at build time only (the Vite dev server needs inline scripts). `build.assetsInlineLimit: 0`. `base: './'`. Deploy only from `push` to `main`, only after every other CI job passes, using `actions/upload-pages-artifact` and `actions/deploy-pages` (pinned majors) with `permissions: pages: write, id-token: write` on the deploy job only, the `github-pages` environment, and a `pages` concurrency group that does not cancel an in-progress deploy. The deployed artifact is the same `app/dist` the CI job built and checked.

**Never:** No PWA, service worker or manifest (US-8.1, AD-19). No custom domain. No deploy from pull requests or other branches. No cross-origin request, CDN or remote font. No change to the existing dev-only stripping checks except to keep them in force.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Relative assets | `pnpm build` | `dist/index.html` references `./assets/…`, never `/assets/…` | CI fails otherwise |
| CSP present | `pnpm build` | `dist/index.html` has the exact CSP meta | CI fails otherwise |
| CSP clean | built site, visit all five routes, Settings loads the engine | zero `securitypolicyviolation` events and no "Refused to" console errors | test fails |
| Same-origin only | same visit | every request URL has the page's origin | test fails |
| Sub-path | built site served under `/tabcreator/` | `#/settings` shows "Engine v…" | test fails |
| Dev server | `pnpm dev` | no CSP meta; HMR works | none |
| PR / branch push | `pull_request` or non-main push | CI runs, deploy job skipped | none |
| Main push | push to `main`, CI green | deploy job publishes; job URL is the Pages URL | job fails if Pages is not enabled |

</intent-contract>

## Code Map

Builds on 1.1–1.4 (`819474b`). `app/vite.config.ts` has `worker.format: 'es'`, no `base`. `app/index.html` has no CSP. `dist` today references `/assets/…` (absolute). The engine worker is a module worker created with `new URL('./engine-worker.ts', import.meta.url)`; the wasm is fetched by the wasm-pack glue. `.github/workflows/ci.yml` has jobs `fixtures` and `app`; `app` builds the engine and app and greps `app/dist` for dev-only code. `app/playwright.config.ts`: project `chromium` serves the built app with `node_modules/.bin/vite preview` on 4173 (its command also builds engine and app; keep `node_modules/.bin/vite`, `pnpm exec` hangs Playwright); project `dev` serves the dev server on 5174 for `*.dev.spec.ts`. Owner-side status at planning time: `gh api repos/cmknight/tabcreator/pages` returned 404 and no `github-pages` environment exists.

- `app/vite.config.ts` -- `base`, `build.assetsInlineLimit`, a small build-only plugin injecting the CSP meta (`transformIndexHtml`, `apply: 'build'`), exporting the CSP string for tests.
- `app/tests/e2e/csp.spec.ts` -- new, `chromium` project.
- `.github/workflows/ci.yml` -- artifact upload in `app`, new `deploy` job.

## Tasks & Acceptance

**Execution:**
- [x] `app/vite.config.ts` -- `base: './'`, `build.assetsInlineLimit: 0`, build-only CSP injection.
- [x] `app/tests/e2e/csp.spec.ts` -- collect `securitypolicyviolation` via `page.addInitScript`, console "Refused to" errors and every request; visit `#/record`, `#/library`, `#/tuner`, `#/settings` (wait for "Engine v…"), `#/tab/x`; assert none and all same-origin; assert the CSP meta text equals the exported string.
- [x] `app/playwright.config.ts`, `app/tests/e2e/subpath.spec.ts` -- serve `dist` under `/tabcreator/` (a tiny static server script in `app/tests/e2e/` or `vite preview` with a sub-path proxy; no new dependency) and check `#/settings` shows the engine version.
- [x] `.github/workflows/ci.yml` -- in `app`, after the dist checks: fail if `dist/index.html` lacks the CSP meta or contains `="/assets`; on push to `main`, `actions/upload-pages-artifact` with `app/dist`. New `deploy` job: `needs: [fixtures, app]`, `if: github.event_name == 'push' && github.ref == 'refs/heads/main'`, `environment: { name: github-pages, url: ${{ steps.deployment.outputs.page_url }} }`, `actions/deploy-pages`.
- [x] `README.md` (root, new or appended) -- one "Deploy" section: Pages source must be "GitHub Actions"; deploys run on green `main` pushes.

**Acceptance Criteria:**
- Given `pnpm build`, when `dist/index.html` is read, then it has the exact CSP meta and only relative asset URLs.
- Given the built site, when Playwright runs `csp.spec.ts` and `subpath.spec.ts`, then both pass with zero violations and zero non-self requests.
- Given a pull request, when CI runs, then the `deploy` job is skipped; given a green `main` push, then it runs after `fixtures` and `app`.

## Implementation Notes

- CSP is injected by a build-only `transformIndexHtml` string replace right after `<meta charset>` (charset stays first; the build throws if the anchor is missing). Attribute is unescaped so the CI `grep -F` can match the exact string.
- Sub-path: `app/tests/e2e/serve-subpath.ts`, a node:http static server (run by Node's type stripping) serving `dist/` only under `/tabcreator/` (404 elsewhere), as Playwright project `subpath` on port 4174; `chromium` ignores `subpath.spec.ts`.
- CSP spec reports `securitypolicyviolation` through `page.exposeFunction`, so a reload cannot drop one; requests are collected on the context (includes the worker's wasm fetch).
- One build: with `CI` set, the `chromium` and `subpath` web servers serve the existing `dist/` without rebuilding (locally they still rebuild engine and app), so the grep-checked, Playwright-tested and uploaded `app/dist` are the same bytes.
- `deploy` first checks `github.sha` is still the head of `main` (`gh api …/commits/main`, `contents: read` on the job) and skips `deploy-pages` otherwise, so a late-finishing older run cannot publish over a newer one; the non-cancelling `pages` group is kept.
- `csp.spec.ts` and `subpath.spec.ts` share `tests/e2e/hygiene.ts`: CSP violations, "Refused to" console, `requestfailed`/>=400 responses, and same-origin requests.
- CI dist check rejects any root-absolute `(src|href)="/x` in `index.html` and any `url(/` in `dist/**/*.css`.
- `actions/upload-pages-artifact@v5`, `actions/deploy-pages@v5` (latest majors on 2026-10-01).
- Negative checks run: `base: '/'` fails `subpath.spec.ts`; `worker-src blob:` fails `csp.spec.ts`. Removing `'wasm-unsafe-eval'` does NOT fail it: the wasm compiles in the module worker, and a document's meta CSP does not apply to workers (a worker's CSP comes from its own response headers, which GitHub Pages does not set). The directive is kept as specified; it is enforced on the main thread only.
- Dev server checked: no CSP meta, inline react-refresh script present.

## Plan Change Log

## Review Triage Log


### 2026-10-01 — Review pass
- verdicts: 27 findings — high 0, medium 8, low 14, false 5, maybe-false 0
- findings:
  - `medium` `patch` (blind) overlapping main pushes can deploy out of order — deploy skips unless `github.sha` is the head of `main`.
  - `medium` `patch` (blind) Playwright tests a rebuilt dist, not the uploaded one — in CI the web servers serve the existing `dist`.
  - `low` `reject` (blind) CSP string duplicated in the CI step — a mismatch fails CI loudly; `csp.spec.ts` asserts the exported string against the build.
  - `low` `patch` (blind) root-absolute check only covers `="/assets` — broadened to any root-absolute `src`/`href` and CSS `url(/`.
  - `false` `reject` (blind) CSP lacks `base-uri`, `form-action`, `object-src`, `frame-ancestors` — the policy string is fixed verbatim by spine AD-13.
  - `false` `reject` (blind) `worker-src blob:` broader than needed — fixed verbatim by spine AD-13.
  - `medium` `defer` (blind) meta CSP does not reach workers and Pages sends no headers, so the engine worker runs without CSP and `'wasm-unsafe-eval'` is unenforced — pre-existing spine assumption, not caused by this change.
  - `low` `patch` (blind) sub-path spec misses blocked requests and console errors — added with the claim fix below.
  - `low` `reject` (blind) malformed URL crashes the test server — test-only; requests come from the app; fix adds a guard.
  - `low` `reject` (blind) README lacks app basics and the published URL — plan asked for a Deploy section only.
  - `low` `reject` (edge) malformed percent escape crashes `serve-subpath.ts` — as above.
  - `low` `reject` (edge) non-numeric port argument — the config passes a constant.
  - `low` `reject` (edge) reused local server serves a stale `dist` — local-only; CI never reuses.
  - `low` `patch` (edge) other root-absolute URLs pass CI — same broadened check.
  - `medium` `patch` (edge) out-of-order deploys — same fix.
  - `medium` `patch` (edge) uploaded and tested bundles can differ — same fix.
  - `low` `reject` (edge) late violation binding may be missed — the spec waits for the engine and navigations; fix adds timing code.
  - `low` `patch` (edge) sub-path spec ignores `requestfailed` — added.
  - `low` `reject` (edge) loose `subpath.spec.ts` match — no such file names exist.
  - `medium` `patch` (edge, claim) sub-path spec does not assert zero violations or non-self requests — assertions added.
  - `low` `patch` (edge, claim) "only relative asset URLs" not enforced — same broadened check.
  - `false` `reject` (intent) a real push publishing is not verified — needs the owner's Pages setting and a push; recorded as the manual check (hitl).
  - `false` `reject` (intent) deployed Settings not checked on github.io — same; the sub-path spec models it locally.
  - `medium` `patch` (intent) browser tests run on a rebuild, not the published bytes — same fix as above.
  - `medium` `patch` (intent) CSP/origin assertions not run under `/tabcreator/` — same fix as the claim.
  - `low` `reject` (intent) no explicit check for `data:` URIs — `assetsInlineLimit: 0` plus the CSP spec (default-src blocks `data:`).
  - `false` `reject` (intent) owner step only in README — the intent assigns it to the owner.

## Design Notes

Deploying the artifact built in the `app` job means the published bytes are exactly the ones that passed lint, tests, the dev-code greps and Playwright. A separate deploy workflow would rebuild and could drift.

The live publish needs the owner: Pages source set to "GitHub Actions" (Settings → Pages). Until then the `deploy` job fails on `main` while CI stays otherwise green; this run cannot push, so the live check is the owner's after the first push.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` -- expected: all exit 0
- `grep -c 'Content-Security-Policy' app/dist/index.html && ! grep -q '="/assets' app/dist/index.html` -- expected: `1`, exit 0
- `uv run --with pyyaml python -c "import yaml;d=yaml.safe_load(open('.github/workflows/ci.yml'));print(sorted(d['jobs']))"` -- expected: `['app', 'deploy', 'fixtures']`

**Manual checks (if no CLI):**
- After the owner's first push to `main`: the `deploy` job succeeds, the Pages URL opens, and `#/settings` shows "Engine v0.1.0".

## Auto Run Result

- **Summary:** production builds are now relative-based (`base: './'`), never inline assets, and carry the exact AD-13 CSP meta, injected at build time only. CI uploads the single checked-and-tested `app/dist` and deploys it to GitHub Pages from green `main` pushes, skipping when a newer commit is already the head of `main`. Playwright proves zero CSP violations, zero failed or non-self requests at `/` and under `/tabcreator/`, and the engine version on Settings.
- **Files changed:**
  - `app/vite.config.ts`: `base`, `assetsInlineLimit`, the exported `CSP` and the build-only CSP plugin.
  - `app/tests/e2e/{csp,subpath}.spec.ts`, `hygiene.ts`, `serve-subpath.ts`: CSP and request-hygiene tests, and the sub-path server.
  - `app/playwright.config.ts`: `subpath` project; in CI the web servers serve the existing `dist`.
  - `.github/workflows/ci.yml`: CSP and relative-URL checks, Pages artifact upload, `deploy` job with the head-of-main guard.
  - `README.md`: the Deploy section.
- **Review:** 27 findings; 4 fixes applied (3 medium entries, 1 low), 1 deferred (meta CSP does not reach workers; Pages cannot send headers), the rest rejected with reasons in the Review Triage Log.
- **Follow-up review recommended:** true. Three medium entries were patched. Unverified risks: the head-of-main skip and the `deploy-pages` step have never run in Actions.
- **Verification:**
  - The full plan command exited 0 (150 Vitest tests, 16 Playwright tests).
  - `dist/index.html` has the CSP meta once and no root-absolute `src`/`href`.
  - The workflow parses to `['app', 'deploy', 'fixtures']`.
- **Owner action (hitl):** `gh api repos/cmknight/tabcreator/pages` returned 404 at planning time, so Pages does not appear to be enabled yet. Set Settings → Pages → Source to "GitHub Actions", push `main`, then confirm the deploy job succeeds and `#/settings` on the Pages URL shows "Engine v0.1.0".
- **Residual risks:**
  - Workers run without CSP on Pages (deferred).
  - If the GitHub API call fails, the head-of-main check fails and so does the `deploy` job.
  - `CI=1 pnpm e2e` needs an existing `dist`.
