---
title: 'Latency gates and backup on the production build'
type: 'feature'
ticket: '9'
created: '2026-10-07'
status: done
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '7c1cea5525d799148991a37dabad9ff0931fb43e'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The edit-to-paint p95 gate (500-note tab, ≤ 100 ms) and the 500-take search gate run on the dev server, seeded by dev-only pages. AD-17 and the epic decision put the latency gates on the production build.

Separately, backup and restore have never run against the production build: CSP, the backup-worker chunk and the `/tabcreator/` sub-path are untested (Library retro B4, DS12).

**Approach:**
- Move both gates to a `perf` Playwright project on the production build, seeded through story 8's helper (fixture backups restored with the real Restore UI).
- Read the limits from `app/budgets.json`, and report the p95s in the CI job summary.
- Add backup-and-restore e2e tests on the production build at the root and under `/tabcreator/`.

## Boundaries & Constraints

**Always:**
- **Metrics unchanged:** the existing probes (keydown `timeStamp` → MutationObserver signature change → rAF + setTimeout), the edit kinds, sample counts, warm-ups and query list, and the nearest-rank p95.
  - edit: the "phrased" shape is gated, and "one phrase" is reported only (seed it as a second take).
  - search: p95 over every keystroke.
- **Seeding** (story 8's `app/tests/e2e/seed-helpers.ts`, extended):
  - add builders for a 500-note analysed tab and for 500 analysed takes with small tabs;
  - takes are `status: 'analyzed'`, `analysisVersion: 'seeded'`, `audioMime: null`, settings from `DEFAULT_PREFS.analysisDefaults`, `createdAt` base + i s;
  - reuse the deterministic generators `tab500Notes` and `library500Title(s)` / `library500Notes` (move them from `src/dev` into the test helpers if importing from `src/dev` is awkward; their unit tests move with them);
  - restore through `restoreSeed` on the production build;
  - the restore time is reported, not gated.
- **Project:**
  - rename the specs, e.g. `tests/e2e/edit-latency.perf.spec.ts` and `search-latency.perf.spec.ts`, with `PERF_SPECS = /.*\.perf\.spec\.ts/`;
  - add PERF_SPECS to the `chromium` project's `testIgnore` so it doesn't run them in parallel;
  - the `perf` project: baseURL is the production preview (`:4173`), `workers: 1`, `fullyParallel: false`, `retries: 0`, `serviceWorkers: 'block'`, and the same `dependencies` as today;
  - remove the dev project's PERF ignore.
- **Limits:**
  - `editP95Ms: 100` and `searchP95Ms: 50` go in `app/budgets.json`, read and validated by the specs (update `$comment`);
  - env overrides `TABCREATOR_EDIT_P95_MS` / `TABCREATOR_SEARCH_P95_MS` let a run lower a limit to show the failure (plan decision, like the benchmark's `--limit-ms`).
- **Summary:** each perf spec appends its p95 table (gated or reported, limit, pass/fail, restore time) to `$GITHUB_STEP_SUMMARY` when set, even when the gate fails, and keeps the console table and JSON attachment.
- **Dev leftovers:**
  - delete `src/dev/Tab500Page.tsx` and its `App.tsx` route (only edit-latency used it);
  - keep `src/dev/Library500Page.tsx` (`library.dev.spec.ts:422` still uses it);
  - the CI dist greps stay.
- **Backup and restore on the production build** (B4):
  - a shared test body used by a `chromium` spec (e.g. `backup-restore.spec.ts`) and a sub-path spec (`backup-restore-subpath.spec.ts`, matching the subpath pattern);
  - steps: seed through `restoreSeed` (a take with WAV audio and a tab, plus a tab-less take); back up (download event); restore that file into a fresh context; compare takes, tabs and audio bytes (storage-helpers); re-restore imports 0;
  - `watchHygiene` clean in both contexts (no CSP violation, no failed request);
  - assert the `assets/backup-worker-*.js` response loaded (under `/tabcreator/` in the sub-path run).

**Never:**
- No change to the app's runtime code beyond deleting `Tab500Page` and its route.
- No new dev hooks.
- No change to metric definitions or budget values.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Edit gate | production build, seeded 500-note tab | every kind's p95 ≤ `editP95Ms`; table in the summary | none |
| Search gate | production build, 500 seeded takes | p95 ≤ `searchP95Ms`; table in the summary | none |
| Lowered limit | `TABCREATOR_EDIT_P95_MS=1` (or the search one) | that spec fails naming the p95 and the limit; the summary still written | none |
| Bad budgets | missing or invalid key | the spec fails with a clear message | none |
| Backup/restore root | chromium, production | round trip identical; re-restore imports 0; hygiene clean; backup-worker chunk loaded | none |
| Backup/restore sub-path | `/tabcreator/` | the same, under the sub-path | none |
| No dev in dist | `pnpm build` | dist greps pass; no Tab500 | none |

</intent-contract>

## Code Map

- **`app/tests/e2e/edit-latency.dev.spec.ts`:** `BUDGET_MS` :15, `SAMPLES` :17, `WARM_UP` :19, kinds :22-30, nearest-rank :42, seeding via `#/__test/tab500[?onePhrase]` :50-56, probe :65-114, report/attach :317-328, gate :330-339, one-phrase :341-345. Locators from `tab-helpers.ts`; `seedTab` there is dev-only.
- **`app/tests/e2e/search-latency.dev.spec.ts`:** `BUDGET_MS` 50 :17, `MIN_KEYSTROKES` :19, warm-up :21, queries :23, Node-side expected counts via `library500Titles()` + `searchKey` :2, :35-40, seeding via `#/__test/library500` :56-72, probe :81-137, run :152-201.
- **Dev pages:** `app/src/dev/Tab500Page.tsx:31-57`, `tab500.ts:56` (`tab500Notes`), `Library500Page.tsx`, `library500.ts`; routes at `App.tsx:60-61`.
- **`app/playwright.config.ts`:** patterns :10-20; chromium :57-61; prod-mic :62-80; subpath :81-88; dev :89-99; perf :100-113 (today the dev server); `retries` :51; web servers :115-136.
- **`app/tests/e2e/seed-helpers.ts`:** `seedTake` :119, `seedManifest` :140, `seedBackup` (multi-take with tabs) :162-183, `restoreSeed` :190-235 (needs the Library open; handles the "Restore N takes" dialog and the "Imported N takes" toast).
- **Restore validation:** accepts `analyzed` + `audioMime: null` (`storage/restore.ts:109-187`). Size limits are far above these seeds.
- **Backup/restore pattern:** `restore.dev.spec.ts:81-139`, `confirmRestore` :73-79.
- **Prod-safe helpers:** `library-helpers.ts` (`backupButton`/`restoreButton` :26-31), `hygiene.ts` `watchHygiene`, `helpers.ts` `collectErrors`, `storage-helpers.ts` (`readTakes`/`readTab`/`opfsFiles`/`opfsFileBase64`).
- **Budgets:** `app/budgets.json` (7.7, 7.8). The benchmark's `readConfig` validation pattern is at `app/build/benchmark.ts:94-108`. Summary-append precedent: `size-budget.ts`, `benchmark.ts`.
- **CI:** `ci.yml` `pnpm e2e` :343-344 runs all projects on the built dist.

## Tasks & Acceptance

**Execution:**
- [x] `app/tests/e2e/seed-helpers.ts`: the 500-note-tab and 500-take builders (generators moved or imported); unit tests at the `validateBackup` level.
- [x] `app/tests/e2e/edit-latency.perf.spec.ts` and `search-latency.perf.spec.ts` (renamed and reseeded): budgets plus env overrides, summary append; delete the `.dev` versions.
- [x] `app/playwright.config.ts`: the PERF pattern, chromium ignore, perf project on the production build.
- [x] `app/src/dev/Tab500Page.tsx` and its route in `App.tsx`: delete.
- [x] `app/budgets.json`: `editP95Ms`, `searchP95Ms`.
- [x] `app/tests/e2e/backup-restore.spec.ts` and `backup-restore-subpath.spec.ts` with a shared body: the round trip, hygiene, the worker chunk.

**Acceptance Criteria:**
- Given the production build, when the perf project runs, then both gates pass and their p95 tables appear in the job summary, with no dev page or hook needed.
- Given a limit lowered through its environment variable, when that spec runs, then it fails naming the p95 and the limit.
- Given the production build at the root and at `/tabcreator/`, when a backup is made and restored into a fresh context, then everything matches and no CSP or request errors occur.
- Given the full verification, when it runs, then it exits 0.

## Implementation Notes

- `tab500.ts` moved from `src/dev/` to `app/tests/e2e/tab500.ts` (nothing in `src/` uses it once `Tab500Page` is gone); its unit test stays in `tests/unit/tab500.test.ts`, importing the new path. `library500.ts` stays in `src/dev/` (Library500Page still uses it); `seed-helpers.ts` imports it.
- New builders in `seed-helpers.ts`: `seedAnalysedTake`, `tab500Seed` (both shapes as two takes, `TAB500_IDS`), `library500Seed` (ids `library500-iii`). Each latency test restores its seed with `restoreSeed`, then opens the take by `#/tab/:id` (edit) or stays in the Library (search).
- Shared perf code in `app/tests/e2e/perf-helpers.ts`: `readLimit` (budgets key validation; the env override must be a positive number no higher than the budget, so it can only lower the limit), nearest-rank `percentile`, `markdownTable`, `appendSummary`. Unit tests in `app/tests/unit/perf-seed.test.ts` (seeds at the `validateBackup` level, limits, overrides, summary).
- Backup/restore: shared body `app/tests/e2e/backup-restore-body.ts`; the tab-less take is `recorded` with no audio. The backup-worker chunk is asserted in both contexts (backup and restore each start it).
- The perf gates measure the production build served at the root (`:4173`, not `/tabcreator/`) with `serviceWorkers: 'block'`, so the service worker's precache install does not compete for the CPU while the timings run (also stated in `budgets.json` `$comment` and the `perf-helpers.ts` header). `PERF_SPECS` is ignored by both the `chromium` and `subpath` projects.
- Review fixes: the backup-worker check records only the page's own (not service-worker) responses from just before Back up, and in the fresh context from just before the restore pick and confirm; the fresh context uses Desktop Chrome like the projects; the re-restore toast comes from `strings['library.restored'](0, 2)`; `withinLimit` (NaN never passes) drives every verdict; the search spec asserts its sample count before any percentile; a failed summary write only warns; the reported time is labelled "Seeding (restore through the UI, end to end)".
- Measured locally on the production build: phrased edit p95 18–25 ms per kind, search p95 ~19 ms, restore 0.2 s (2 takes) / 1.0 s (500 takes). With `TABCREATOR_EDIT_P95_MS=1` / `TABCREATOR_SEARCH_P95_MS=1` both specs fail naming the p95 and the limit, and the summary still shows FAIL rows.

## Plan Change Log

## Review Triage Log

### 2026-10-07 — Review pass
- verdicts: 26 findings — high 0, medium 2, low 15, false 9, maybe-false 0
- findings:
  - `medium` `patch` (blind) the backup-worker check is satisfied by the seed restore before Back up runs — responses recorded only around Back up and the fresh-context Restore.
  - `medium` `patch` (edge) the service-worker precache fetch satisfies the worker check — SW-initiated responses ignored.
  - `low` `patch` (verification) the gate verdict and lowered-limit failure have no automated check — one `withinLimit` helper, unit-tested with a lowered limit.
  - `low` `patch` (blind) the gate decision is written in several places and disagrees on NaN — same helper; NaN fails.
  - `low` `patch` (intent) "with the limits lowered they fail" is checked by hand only — same unit test; the manual run stays recorded.
  - `low` `reject` (blind) no wired-up command showing the gate failing — the verdict is unit-tested; a deliberately red CI run is not wanted.
  - `false` `reject` (edge, claim) the perf project is skipped when a dependency project fails — the e2e step is already red then; a green run always ran the gates.
  - `false` `reject` (intent) same, under the CI-gate reading — same reason.
  - `false` `reject` (blind) same — same reason.
  - `low` `patch` (edge) the fresh restore context drops the project's device settings — Desktop Chrome device spread.
  - `low` `patch` (edge) an unwritable summary file throws before the gate — the write is caught and warned.
  - `low` `patch` (edge) empty samples throw from `percentile` before the summary — the sample count is asserted first.
  - `false` `reject` (verification) a bad override also fails the reported-only test — a bad configuration should fail loudly.
  - `low` `patch` (intent) the gates run at the root with the service worker blocked, not as deployed — documented (CPU from the precache install; the sub-path is covered by backup/restore).
  - `low` `patch` (blind) `serviceWorkers: 'block'` is undocumented — same note.
  - `false` `reject` (intent) no new dist assertion — the CI dist greps already cover dev pages; Tab500Page is deleted.
  - `false` `reject` (intent) the search limit comes from the earlier story — "limits from story 7's budgets config"; the value is unchanged by plan.
  - `false` `reject` (intent) story 13 is outside the diff — the builders sit in the shared seed helper for reuse.
  - `false` `reject` (intent) only the phrased shape is gated — the plan's Always keeps the earlier split.
  - `low` `reject` (blind) a third budgets.json reader — the test and build readers differ in error types; a sweep item.
  - `low` `patch` (blind) the restore time includes UI interaction — labelled as end-to-end seeding.
  - `low` `reject` (blind) the phrased test seeds both shapes — the plan seeds the one-phrase shape as a second take; the restore time is reported only.
  - `low` `reject` (blind) the round trip misses missing-audio, compressed and unfinished takes — outside this matrix; covered by the restore and backup unit tests and `restore.dev.spec.ts`.
  - `low` `patch` (blind) the re-restore toast text is hard-coded — built from `ui/strings.ts`.
  - `false` `reject` (blind) `library500.ts` stays in `src/dev` — deliberate (Library500Page still used); recorded in Implementation Notes.
  - `low` `patch` (blind) a sub-path perf spec could match two projects — PERF_SPECS ignored by `subpath`.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && pnpm --filter app size:check && TABCREATOR_E2E_BUILD=B pnpm --filter app exec vite build && CI=1 pnpm e2e && pnpm --filter app benchmark'` (repo root, `~/.cargo/bin` on PATH) — expected: all exit 0.

## Auto Run Result

- **Summary:**
  - **Latency gates on the production build:** the edit-to-paint p95 (500-note tab) and the 500-take search gates run in the `perf` Playwright project, now against the production preview (`*.perf.spec.ts`, `retries: 0`, service worker blocked).
    - Seeding: story 8's helper restores fixture backups through the real Restore UI. New builders are `tab500Seed` and `library500Seed`.
    - Limits: `editP95Ms` 100 and `searchP95Ms` 50 come from `app/budgets.json`. The env overrides `TABCREATOR_EDIT_P95_MS` and `TABCREATOR_SEARCH_P95_MS` can only lower them.
    - Each spec appends its p95 table to the job summary before asserting.
  - **Backup and restore on the production build:** a shared round trip (seed, Back up, restore into a fresh context, compare takes/tabs/audio, re-restore imports 0) runs at the root and under `/tabcreator/`. It checks for CSP violations and failed requests, and that Back up and Restore each load the built backup-worker chunk.
  - **Dev leftovers:** `Tab500Page` and its route are deleted, and `tab500.ts` moved to `tests/e2e/`.
- **Files changed:**
  - **App:** `app/src/App.tsx`, `app/src/dev/Tab500Page.tsx` (deleted), `app/src/dev/library500.ts`, `app/budgets.json`, `app/playwright.config.ts`.
  - **e2e:**
    - new: `tests/e2e/perf-helpers.ts`, `tab500.ts` (moved), `backup-restore-body.ts`, `backup-restore.spec.ts`, `backup-restore-subpath.spec.ts`;
    - changed: `seed-helpers.ts`, `edit-latency.perf.spec.ts` and `search-latency.perf.spec.ts` (renamed from `.dev`).
  - **Unit:** `tests/unit/perf-seed.test.ts` (new), `tab500.test.ts`.
- **Review:** 26 findings (medium 2, low 15, false 9).
  - Patched:
    - the worker-chunk check is now scoped to Back up and Restore, ignoring service-worker fetches;
    - one `withinLimit` verdict helper, unit-tested with a lowered limit and NaN;
    - an empty-sample assert;
    - a failed summary write is caught;
    - the fresh-context device settings;
    - the toast text comes from strings;
    - the seeding-time label;
    - `subpath` ignores perf specs;
    - the service-worker block is documented.
  - Rejected rows carry their reasons in the triage log.
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 2, low 10.
- **Verification:**
  - The full plan command exited 0: 2083 unit, 254 e2e with no retries, size and benchmark gates pass.
  - The lowered-limit failure was checked by hand and is now unit-tested.
  - The pre-patch run needed one e2e re-run (the count-in and cursor flakes).
- **Residual risks:**
  - The perf gates run at the root with the service worker blocked, not as deployed.
  - If a dependency project fails, the perf project is skipped; the e2e step is red in that case anyway.
  - `library500.ts` remains in `src/dev` for `Library500Page`.
