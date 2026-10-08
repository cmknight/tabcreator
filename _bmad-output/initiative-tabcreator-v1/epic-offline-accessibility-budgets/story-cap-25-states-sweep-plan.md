---
title: 'CAP-25 states sweep'
type: 'feature'
ticket: '13'
created: '2026-10-07'
status: done
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: 'ce5d448f15e417271e0f68d52362a43ff1d2f830'
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** CAP-25 asks that every error and empty state gives a message and a way forward. The epic's checklist is EXPERIENCE.md's State Patterns table (28 rows, :95-122) plus SPEC's "player left during analysis" (user decision).

Every row has some test today, but nothing ties the rows to their tests, and these are untested:
- **No production test:** offline (no indicator), a real upgrade-blocked render, and a reload mid-analysis.
- **Recording retro A5:** Stop latency, Space in a text input and a recovery check, all on the production lane. The 5-minute take is also checked at 5 MiB rather than 5,000,000 bytes.
- **Library retro B4:** the Windows CRLF export is never forced.

**Approach:**
- A checklist module mapping each row to the tests that reach it.
- A unit test that parses the State Patterns table and fails on any unmapped row or missing test title.
- New production-lane tests for the gaps.
- One app change: a stop performance mark.

## Boundaries & Constraints

**Always:**
- **Checklist** (`app/tests/cap25-states.ts`):
  - Each entry is `{ state, surface, tests: [{ file, title, lane }] }`. The `state` text matches the table's first cell exactly, plus a final "Player left during analysis".
  - `file` is relative to `app/tests/` (`e2e/…` or `unit/…`); `title` is the literal test title as written in source, or the template literal text for a looped test such as `${api}`.
  - Each row maps to at least one test that reaches it. Prefer a production-lane test (`chromium`, `prod-mic`) where one exists, else dev, plus unit tests where they carry the logic.
  - Map story 7.4's `update.prod.spec.ts` tests and story 7.5's `unsupported.spec.ts` per-API loop; don't redo them.
  - Rows naming the Tuner as well as Record may map to the Record test (shared mic and meter code); say so in a note field.
- **Unit test** (`app/tests/unit/cap25-states.test.ts`, `// @vitest-environment node`):
  - Read EXPERIENCE.md, from `## State Patterns` to the next `##`, and parse the table rows' first cells.
  - Assert the set equals the checklist's states, minus the SPEC extra, both ways. A new or renamed row fails, and so does a stale entry.
  - For each mapped test, read the file and assert the title literal appears as a `test(`/`it(` title, with any quote style.
  - Test the parser against a small fixture table, including one row with no mapping, to show it fails.
- **New tests on the production build:**
  - **Offline, no indicator** (extend `offline.prod.spec.ts`): while offline and after the flow, no element outside the live regions shows text matching `/offline|no connection|network/i`, and no banner or alert appears.
  - **Upgrade blocked** (`chromium`, new `upgrade-blocked.spec.ts`), in a fresh context:
    1. A same-origin non-app page (e.g. `./manifest.webmanifest`) opens IndexedDB `tabcreator` at version 1, creating migration 1's stores, and ignores `versionchange`.
    2. Then the app loads in a second page and must show "Close other TabCreator tabs to finish updating".
    3. Closing the first connection lets the app continue (nav visible).
    
    If the app doesn't open the DB at startup, navigate to the Library to trigger it.
  - **Player left during analysis** (`chromium`, new `analysis-resume.spec.ts`):
    - seed a 240 s recorded WAV take through `restoreSeed`;
    - open its Tab, see "Analysing…", reload, see it analysing again, and wait for notes and stored `status: 'analyzed'`;
    - also leave for the Library mid-analysis and come back: it finishes.
  - **Stop latency** (`record.prod.spec.ts`):
    - Add a `performance.mark('record-capture-stop')` in `src/audio/recorder.ts` where the worklet's `stopped` message resolves. It follows the existing `record-capture-start` pattern and changes no behaviour.
    - The test measures the second Space keydown mark to the stop mark, and asserts ≤ 100 ms (epic recording Done-when 1) over a few runs: the median, plus each run ≤ 150 ms. Report the numbers.
    - If 100 ms is not reachable because of the 50 ms scheduling lookahead, still assert the measured values. Record the facts in Implementation Notes; do not loosen silently.
  - **Space in a text input** (prod-mic): focus the Tempo spinbutton and press Space; no take starts (Record not pressed, no timer).
  - **Recovery** (prod-mic, new `recovery.prod.spec.ts`): record about 5 s, accept the leave dialog, reload; the recovered-take banner shows; Open rebuilds the take, the Tab opens, and the stored `stopReason` is `'recovered'`.
  - **≤ 5,000,000 bytes:** `record.prod.spec.ts:137` asserts `≤ 5_000_000`.
  - **CRLF** (`chromium`, a test in `export.spec.ts` or similar):
    - an init script makes the platform report Windows (`navigator.userAgentData.platform` and `navigator.platform`);
    - seed an analysed take, download; assert the page saw Windows and the bytes contain `\r\n` and no lone `\n`;
    - a non-Windows run asserts no `\r`.
- **Already done, mapped only:**
  - the `onHeld` scan wiring (`instance-lock.test.ts:820`, `instance.dev.spec.ts:182`);
  - the WAV fallback in a browser (`decode.dev.spec.ts:194`, `recovery.dev.spec.ts:100`).
  
  Record both in the checklist's notes or in Implementation Notes.
- Every new prod test uses `watchHygiene` and `collectErrors`, and reaches states only through the UI, `restoreSeed`, standard-API init scripts or real browser conditions. There are no app hooks.

**Never:**
- No dev hooks in production code; only the one `performance.mark`.
- No change to app behaviour.
- Don't rewrite existing tests beyond the 5,000,000 assertion and the offline extension.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Unmapped row | a State Patterns row with no checklist entry | unit test fails naming it | none |
| Stale entry / missing title | an entry whose state or test title no longer exists | unit test fails naming it | none |
| Offline | prod-mic, offline flow | no offline indicator; everything works | none |
| Upgrade blocked | an old-version connection held open | full-screen "Close other TabCreator tabs to finish updating"; released → the app continues | none |
| Reload mid-analysis | 240 s take analysing, reload | analysing again, then completes | none |
| Stop latency | Space to stop on prod-mic | keydown → stop mark ≤ 100 ms (median) | none |
| Space in Tempo | Tempo field focused | no take starts | none |
| Recovery | reload mid-take on prod | banner, Open, the take is recovered | none |
| CRLF | Windows platform | `\r\n` only; non-Windows LF only | none |

</intent-contract>

## Code Map

- **The table:** EXPERIENCE.md `_bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/EXPERIENCE.md` `## State Patterns` :91, rows :95-122. SPEC `_bmad-output/specs/spec-tabcreator/SPEC.md:103-105`.
- **Existing coverage per row** (investigation; use and verify the titles):
  - mic-setup.spec.ts:5,45
  - mic-errors.dev.spec.ts:133,258
  - record.dev.spec.ts:744,713,541,573,760
  - mic-select.dev.spec.ts:142
  - input-quality.dev.spec.ts:44,210
  - level-meter.dev.spec.ts:76,99
  - tab-flags.dev.spec.ts:191,204,224,69,238,85
  - recovery.dev.spec.ts:51
  - tuner.dev.spec.ts:76
  - a11y-matrix.spec.ts:283 ("Tab: analysing in progress"; titles sit inside a `${theme} theme` describe, so match the inner title)
  - engine.spec.ts:31
  - tab-states.dev.spec.ts:152,244,208,262
  - playback.dev.spec.ts:254
  - storage-states.dev.spec.ts:88,146
  - library.dev.spec.ts:179,377
  - restore.dev.spec.ts:81
  - update.prod.spec.ts:62,99
  - offline.prod.spec.ts:62
  - unsupported.spec.ts:142 (template `${api}`)
  - instance.dev.spec.ts:66,275
- **Stop mark:** `app/src/audio/recorder.ts` — start mark :79/:196, `stopped` handled :197 (`resolveStopped`), stop scheduled with `LOOKAHEAD_S = 0.05` :27, `stop()` :299-306. The keydown mark is in `ui/a11y/shortcuts.ts:124,170`. Start-latency precedent: `record.prod.spec.ts:49-85`.
- **Upgrade blocked:**
  - `storage/db.ts:161-178` (blocked → `report('blocked')`; open → `report('open')`);
  - `storage/migrations.ts` (`DB_VERSION` 3; migration 1 creates `takes` (keyPath `id`, index `createdAt`) and `tabs` (keyPath `takeId`));
  - `instance-lock.ts:341-349`;
  - `App.tsx:87-93`;
  - copy `global.instanceUpgradeBlocked`.
- **Analysis resume:** `session/analysis.ts:5-8`, `take-session.ts:615-627`. Seeding pattern: `a11y-matrix.spec.ts:39-42,78-82,283-302` (`fixtureWav`, `seed`), `seed-helpers.ts`, `storage-helpers.ts` `readTake`.
- **Recovery:** `recovery.dev.spec.ts:51` (flow), `goLive(page, null)` (prod-safe).
- **Tempo field:** `getByRole('spinbutton', { name: 'Tempo' })`.
- **CRLF:**
  - `src/model/export-file.ts:48`, `src/ui/platform.ts:166` `isWindowsPlatform`;
  - `tests/e2e/export-helpers.ts:19-43` (`download()`, `windows(page)`).
- **Offline:** `offline.prod.spec.ts:62`, `hygiene.ts` (`offline: true`).
- **Unit-test precedent:** `tests/unit/test-location.test.ts` (node env, fs). Vitest includes `tests/unit/**`.
- **Playwright:** `chromium` (plain `*.spec.ts`, prod, no mic); `prod-mic` (`*.prod.spec.ts`, one fake device, needs a user gesture to Allow).

## Tasks & Acceptance

**Execution:**
- [x] `app/tests/cap25-states.ts` -- the checklist (29 entries).
- [x] `app/tests/unit/cap25-states.test.ts` -- the table parser, both-way set equality, title presence, parser fixture.
- [x] `app/src/audio/recorder.ts` -- the `record-capture-stop` mark (unit-test it if the recorder has tests).
- [x] `app/tests/e2e/record.prod.spec.ts` -- Stop latency, Space in Tempo, `5_000_000`.
- [x] `app/tests/e2e/recovery.prod.spec.ts`, `upgrade-blocked.spec.ts`, `analysis-resume.spec.ts`, the CRLF test; and the offline no-indicator check in `offline.prod.spec.ts`.

**Acceptance Criteria:**
- Given EXPERIENCE.md's State Patterns, when a row has no mapped test or a mapped title is missing, then the unit test fails.
- Given CI, when e2e runs, then every mapped test and every new production test passes.
- Given the full verification, when it runs, then it exits 0.

## Implementation Notes

- **Checklist** `app/tests/cap25-states.ts`: 29 entries (28 State Patterns rows + "Player left during analysis"), each `{ state, surface, tests: [{ file, title, lane }], note? }`. Every existing title in the Code Map was verified in source. Tuner-surface rows (mic lost, unplug, level warnings) map the Record tests with a shared-mic note. "Mic denied" also maps `tuner.dev.spec.ts` "a denied request shows the denied card on the Tuner; Try again recovers".
- **Already done, mapped only** (on the "Recovered take" entry, with a note): the `onHeld` scan wiring (`unit/instance-lock.test.ts` "the app-wide onHeld (scanWhenReady) scans once, when ready resolves", `instance.dev.spec.ts` steal mid-take) and the WAV fallback in a browser (`decode.dev.spec.ts:194`, `recovery.dev.spec.ts:100`).
- **Unit test** `app/tests/unit/cap25-states.test.ts` parses State and Surface from the first table under `## State Patterns`, asserts each entry's `surface` matches, fails on a state mapped twice, and checks each mapped test's lane against its file name (`unit/`, `.perf.spec` → perf, `.dev.spec` → dev, `.prod.spec` → prod-mic, `subpath.spec` → subpath, else chromium). Titles are read by parsing the spec with the TypeScript compiler (`test(`/`it(` calls, any quote style), so comments are stripped and a commented-out test does not count.
- **Stop mark** `record-capture-stop` set in the worklet `stopped` message handler before `resolveStopped()`. The three latency mark names now live in `src/model/latency-marks.ts` (re-exported by `recorder.ts` and `shortcuts.ts`), and `markKeydown(restart)` clears the stop mark too. Unit-tested in `recorder.test.ts` (including a throwing `performance.mark`) and `shortcuts.test.ts`.
- **Stop latency measured** (local, WSL2, prod-mic, 3 runs × 5 takes): medians 57.6, 51.6, 54.8 ms; individual takes 42.3–60.8 ms. 100 ms is reachable with the 50 ms lookahead inside the measure; asserted as planned (median ≤ 100 ms, each ≤ 150 ms). Values are attached as the `space-to-capture-stop-ms` annotation. Between takes the test waits for each take's analysis, so analysis never competes with the next stop.
- **Upgrade blocked**: the app opens the database at startup (the recovery scan once the lock is held), so no Library navigation was needed. The holder page is `./manifest.webmanifest`; the test also checks the DB is at `DB_VERSION` after release.
- **Analysis resume**: a 240 s WAV take analyses in about 10 s locally. The Library-leave test does not assert the take is still `recorded` on the Library (racy); it checks the end state only.
- **Coverage the rows promise** (review): Analysing Cancel (`tab-states.dev.spec.ts`), Audio deleted on the Library (`backup.dev.spec.ts`, `restore.dev.spec.ts`), Storage full on the Library (`storage-states.dev.spec.ts`) are mapped.
- **Recovery (prod)** also checks the recovered take ends `analyzed` with notes and no raw file; the banner check is the duration part only (locale-independent).
- **CRLF**: new `export.spec.ts` (chromium) with a Windows and a Linux run; `windows()` in `export-helpers.ts` is now exported and its comment updated.
- **Offline**: the text walk excludes only the announcer's two regions and skips hidden nodes. `expectNoOfflineIndicator` runs on Record after the offline reload, on the Tab after the flow, and on both fresh offline pages. "Banner or alert" is detected by stable hooks (every `*banner`, `*-failed`, `*storage-full` test id, `restore-error`, `persist-notice`, any `role="alert"` without `aria-live`), since banner classes are hashed in the build; take warnings (`tab-warning-*`) are audio-quality warnings and not counted.

- Verification fix (orchestrator): `offline.prod.spec.ts`'s service-worker origin check (pre-existing, two copies) counted a same-origin `blob:` URL as a network request (`new URL('blob:http://…').origin` is the page origin), which flaked once. `blob:` URLs are now excluded. Test-only; 3/3 repeats, green in the full run.

## Plan Change Log

## Review Triage Log

### 2026-10-07 — Review pass
- verdicts: 26 findings — high 0, medium 0, low 19, false 7, maybe-false 0 (verification-gap: none found)
- findings:
  - `low` `patch` (blind) the stop mark is never cleared between takes — cleared with the others in `markKeydown(restart)`.
  - `low` `patch` (blind) mark names hard-coded in the e2e — imported from source.
  - `low` `patch` (blind) the Library-leave status assertion is racy — removed or made deterministic.
  - `low` `patch` (blind) the checklist's `surface` is never validated — the Surface column is parsed and compared.
  - `low` `patch` (blind) Library "Audio deleted", Library "Storage full" and Analysing Cancel are not reached by mapped tests — mapped, or noted.
  - `low` `patch` (blind) lane inference ignores `perf` and `subpath` — added.
  - `low` `patch` (edge) same — same.
  - `low` `patch` (blind) commented-out or skipped titles count as present — comments stripped; fixture cases added.
  - `low` `patch` (edge) same — same.
  - `low` `patch` (blind) the latency clock starts in the handler — stated in the test's comment.
  - `low` `patch` (blind) the recovery test never checks the final status; en-US clock regex — asserted; locale-independent.
  - `low` `patch` (blind) the recorder test leaks ports and marks; the throw path is untested — reset in `afterEach`; tested.
  - `low` `reject` (blind) smaller e2e gaps (a fixed wait in Tempo, the hand-built v1 schema, no macOS case, a redundant `\r\n` check) — the v1 schema mirrors a frozen migration (migrations never change once shipped); the rest are style.
  - `low` `patch` (blind) the offline text walk scans hidden nodes — skipped.
  - `low` `patch` (edge) the parser reads a second table under the heading — first contiguous run only.
  - `low` `patch` (edge) the offline check excludes every `[aria-live]` subtree — only the announcer's regions are excluded.
  - `low` `reject` (intent) "player left during analysis" asserts no message — EXPERIENCE :76 defines the treatment as resuming automatically, with the Analysing row's progress bar and Cancel, which the test asserts.
  - `low` `reject` (intent) Stop latency measures to the worklet's `stopped` message, not the audio end — the closest observable point; it includes the lookahead, so it is conservative.
  - `low` `reject` (intent) the onHeld "delay" — the fixed 3.5 s delay was replaced by `scanWhenReady` (Tab view, handover and recovery coordination); the mapped tests cover the wiring that replaced it.
  - `false` `reject` (intent) the unit test doesn't prove a mapped test reaches its state — by design: the mapping is reviewed by hand; the test guards completeness and presence.
  - `false` `reject` (intent) update available and unsupported per API are mapped, not new — the ticket says to map stories 4 and 5's tests.
  - `false` `reject` (intent) Space in a number input, not a free-text field — the only text input on Record; the guard covers every `input`.
  - `false` `reject` (intent) CRLF via the platform, not the UA string — the app reads the platform; the test checks the real download bytes.
  - `false` `reject` (intent) the offline check is a heuristic — duplicate of the edge rows, patched.
  - `false` `reject` (intent) most rows map to dev-lane tests — the lane field shows it; the ticket's named gaps are on prod.
  - `false` `reject` (intent) "fills the gaps" for update and unsupported — duplicate of the mapping row.

## Design Notes

**Production lane where the build can reach it.** The new tests cover the ticket's named gaps on the production build. Rows reachable only through dev hooks keep their dev tests in the checklist; the lane field makes that visible.

**Tuner-surface rows.** For mic lost, unplug and level warnings, the Tuner shares the Record mic and meter code, so the Record test is mapped with a note.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && pnpm --filter app size:check && TABCREATOR_E2E_BUILD=B pnpm --filter app exec vite build && CI=1 pnpm e2e && pnpm --filter app benchmark'` (repo root, `~/.cargo/bin` on PATH) -- expected: all exit 0.

## Auto Run Result

- **Summary:**
  - **CAP-25 checklist** (`app/tests/cap25-states.ts`): 29 entries, the 28 EXPERIENCE State Patterns rows plus SPEC's "Player left during analysis". Each maps to the tests that reach it, with a lane per test and notes for Tuner-shared rows and already-done A5 items (onHeld wiring, WAV fallback). Stories 7.4's update tests and 7.5's per-API tests are mapped, not redone.
  - **`cap25-states.test.ts`:**
    - parses the table (state and surface) and checks both ways;
    - finds titles through a TypeScript parse, so commented-out tests don't count;
    - checks each lane against the Playwright file patterns, including perf and subpath;
    - fixture cases prove each failure.
  - **New production tests:**
    - offline shows no indicator;
    - a real IndexedDB upgrade-blocked render, then continuing;
    - analysis resumes after a reload and after leaving;
    - Stop latency (median ≤ 100 ms over 5 takes, measured about 52–58 ms);
    - Space in the Tempo field starts nothing;
    - recovery after a reload mid-take, ending analysed;
    - Windows CRLF and Linux LF downloads;
    - the 5-minute take ≤ 5,000,000 bytes.
  - **App change:** a `record-capture-stop` mark, cleared with the other latency marks on a new take. The names are in `src/model/latency-marks.ts`.
- **Files changed:**
  - **Source:** `app/src/audio/recorder.ts`, `app/src/ui/a11y/shortcuts.ts`, `app/src/model/latency-marks.ts` (new).
  - **Tests:**
    - `app/tests/cap25-states.ts` (new);
    - unit `cap25-states` (new), `recorder`, `shortcuts`;
    - e2e `upgrade-blocked.spec.ts`, `analysis-resume.spec.ts`, `export.spec.ts`, `recovery.prod.spec.ts` (all new), plus `record.prod.spec.ts`, `offline.prod.spec.ts` and `export-helpers.ts`.
- **Review:** 26 findings (low 19, false 7); the verification-gap lens found none.
  - Patched:
    - stop-mark hygiene and imported names;
    - comment-proof title detection, perf and subpath lanes, the surface check, a first-table-only parser;
    - Library and Cancel coverage mapped;
    - the racy assertion removed;
    - the recovery end state;
    - recorder test hygiene and the throw path;
    - the offline check excludes only the announcer;
    - the latency comment.
  - Rejected rows carry their reasons in the triage log.
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 0, low 15.
- **Verification:**
  - The full plan command exited 0: 2146 unit; 329 e2e, 1 flaky that passed on retry (the re-fit outline, unrelated); size and benchmark gates pass.
  - The first post-patch run also needed the test-only `blob:` fix in `offline.prod.spec.ts` (Implementation Notes).
- **Residual risks:**
  - Most State Patterns rows are still reached only on the dev lane through hooks; the lane field shows which.
  - The checklist proves mapping and presence, not that a test truly reaches its state.
  - Stop latency is measured to the worklet's `stopped` message.
