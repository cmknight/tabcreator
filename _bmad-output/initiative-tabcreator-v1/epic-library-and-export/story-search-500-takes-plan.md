---
title: 'Search 500 takes'
type: 'feature'
ticket: '3'
created: '2026-10-06'
status: 'built'
baseline_revision: '5bf2b1968ef15d4f71bec0a4f4ef4dc485ffe59f'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-tab-editing/story-500-note-edit-latency-plan.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** With hundreds of takes the Library is one long list. The player cannot find a take by name, and rendering every row will slow the screen down (CAP-17: search narrows in ≤ 50 ms per keystroke with 500 takes).

**Approach:**
- Add a search field that filters rows by title, ignoring case and accents, as you type.
- Show a no-match state with Clear search.
- Virtualise the list above 100 rows.
- Prove the 50 ms budget with a seeded 500-take dev page measured in the `perf` Playwright project, like 8.5's edit-latency gate.

## Boundaries & Constraints

**Always:**
- **Search field** (EXPERIENCE :84, mockup header "libtools"): `type="search"`, `aria-label`/placeholder "Search takes", above the list.
  - Each keystroke filters the rows whose title contains the query. Matching folds case and accents: NFD, combining marks stripped, `toLocaleLowerCase` on both sides, on titles normalised once per row (kept in the row model, recomputed when the title changes).
  - No match highlighting. Whitespace-only queries show every row.
  - The query is screen state (not persisted). It survives live updates: a new or renamed take that matches appears, and one that stops matching disappears.
  - The search field is disabled in the empty library (EXPERIENCE :115).
- **No match** (EXPERIENCE :116): `No takes match "<query>"` with a Clear search button that empties the field and focuses it.
- **Announcements:** the result count is announced politely after typing settles (about 500 ms debounce): "3 takes", "1 take", or the no-match sentence.
- **Virtualisation** above 100 visible rows:
  - Only the rows in and near the viewport are in the DOM (an overscan of about 10 rows). Row height is fixed: the title stays on one line with an ellipsis and the preview stays on one line (6.1 already does this).
  - The list keeps its accessible structure (`role="list"`, `aria-setsize`/`aria-posinset` on rows), keyboard Tab order through the rendered rows, and scrolling to reach any row.
  - The row menu, inline rename and dialogs (6.2) work on virtualised rows. A row being renamed or with its menu open stays rendered.
  - At ≤ 100 rows the plain list renders as today.
- **Dev page** `#/__test/library500` (gated on `import.meta.env.DEV`, registered beside the other `#/__test/*` pages):
  - It seeds 500 takes with deterministic titles. They include accented and mixed-case titles, e.g. "Café Blues 017", so the search check can use them.
  - Each take is analysed with a small tab and has no audio, written through `db.createTake` + `commitAnalysis`.
  - It is StrictMode-safe (a module-level seed promise) and replaces the hash with `#/library`.
  - Its code is kept out of production by extending the CI dev-code grep.
- **Gate** (`app/tests/e2e/search-latency.dev.spec.ts`, in the `perf` project by extending `PERF_SPECS`):
  - The time is measured from each keystroke's `timeStamp` to after the next frame (rAF, then a task) once the list DOM reflects the filter.
  - At least 20 keystrokes across several queries (typing and deleting characters).
  - It reports median and p95 (logged and attached as JSON) and fails if p95 is over 50 ms.
- **Copy** goes in `ui/strings.ts`.

**Never:**
- No change to library-session's write paths (6.2) or the row model's fields beyond the normalised title.
- No new dependency for virtualisation.
- No footer, backup or restore (6.5–6.7).
- No dev page code in production.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Accents | "cafe" | matches "Café Blues" | — |
| Case | "BLUES" | matches "blues lick" | — |
| No match | "zzz" | `No takes match "zzz"` + Clear search; Clear empties and focuses the field | — |
| Clear by deleting | delete the query | all rows back | — |
| Live add | a matching take is saved during a search | it appears | — |
| Rename out | a filtered row renamed to stop matching | it disappears | — |
| Empty library | no takes | search disabled | — |
| Virtual | 500 takes | ≤ ~40 row elements in the DOM; scrolling to the end shows the oldest take | — |
| Small | 80 takes | all rows rendered (no virtualisation) | — |
| Budget | 500 takes, ≥ 20 keystrokes | p95 ≤ 50 ms | above: the gate fails |
| Announce | typing stops | "<n> takes" announced once | — |

</intent-contract>

## Code Map

- `app/src/session/library-session.ts` (snapshot `{loading, rows, error}`, events) and `app/src/model/library.ts` (`LibraryRow`, `libraryRow`, `sortRows`): add the normalised title to the row (or a pure `searchKey(title)` in `model/library.ts`) and a pure `filterRows(rows, query)`.
- `app/src/ui/screens/Library.tsx` + `Library.module.css`: rows, `Row`, `RowMenu`, `RenameField`, the empty, loading and error states (6.1, 6.2). Add the header search, the no-match state and the virtualised list.
- `app/src/ui/a11y/announcer.ts` `announce`.
- `app/src/App.tsx` dev pages (`#/__test/tab500` registration pattern, hash matched before `?`); `app/src/dev/Tab500Page.tsx` + `tab500.ts` (seeding pattern: module-level promise, `createTake` + `commitAnalysis`, replace hash).
- `app/playwright.config.ts:15` `PERF_SPECS` (extend to the new spec), the `perf` project :101; `app/tests/e2e/edit-latency.dev.spec.ts` (measurement helper: key `timeStamp`, MutationObserver, rAF then task; report table and JSON; the p95 gate).
- `.github/workflows/ci.yml` dev-code grep (add the new page's marker).
- Mockup: `mockups/library.html` header (search box) and the no-match state.
- Tests:
  - unit: `library.test.ts` (normalisation, filter), `library-screen.test.tsx` (search, no match, Clear, virtual window, announce);
  - e2e: `tests/e2e/library.dev.spec.ts` (search on real takes) and the new perf spec.

## Tasks & Acceptance

**Execution:**
- [x] `app/src/model/library.ts` -- `searchKey`, `filterRows` -- the pure rule.
- [x] `app/src/ui/screens/Library.tsx` (+ CSS), `strings.ts` -- search, no-match, Clear, announcement, virtualised list -- the screen.
- [x] `app/src/dev/Library500Page.tsx` (+ seed module), `App.tsx`, `ci.yml` -- the dev page.
- [x] `app/tests/e2e/search-latency.dev.spec.ts`, `playwright.config.ts` -- the gate.
- [x] Unit tests for every I/O row; an e2e search on real takes in `library.dev.spec.ts`.

**Acceptance Criteria:**
- Given the 500-take dev page, when the e2e types and deletes at least 20 characters in the search field, then it reports per-keystroke filter-to-paint median and p95, and p95 is ≤ 50 ms.
- Given takes "Café Blues" and "Riff", when the player types "cafe", then only "Café Blues" is listed; and "zzz" shows the no-match state, whose Clear search restores both.
- Given 500 takes, then fewer than 50 row elements are in the DOM, and scrolling to the bottom reaches the oldest take, which opens with Enter.

## Implementation Notes

- **Rule:** `model/library.ts` adds `searchKey(text)` (`foldLatin`, model/fold.ts: NFD, marks stripped, `toLowerCase`, ß ø æ œ ł đ folded), a `searchKey` field on `LibraryRow` (set in `libraryRow`), `withTitle(row, title)` (title and key together) and `filterRows(rows, query)` (the query trimmed; empty: the same array; otherwise `includes` on the folded query). library-session's only change: its two `{ ...row, title }` spots (pending rename, `showTitle`) use `withTitle`, so the key follows the title; no write path changed.
- **Screen:** a `role="search"` wrapper with the icon and a `type="search"` field ("Search takes" label and placeholder) under the heading (mockup `.libtools`, search box 340 px, radius-sm); disabled while there are no rows. The query is component state. No match: the `.empty` block with `No takes match "<query>"` (h2) and a secondary Clear search that empties and focuses the field. No `role="status"` on it (the mockup has one) because AD-18 keeps every live region in the announcer; instead the count ("3 takes", "1 take", or the no-match sentence) is `announce`d politely 500 ms after the last query change. A live update alone announces nothing.
- **Virtual list (`RowList`):** above `VIRTUAL_ABOVE` = 100 rows it renders [first visible − 10, last visible + 10) from the list's `getBoundingClientRect().top` and `innerHeight` (window scroll and resize listeners; the page scrolls, not a container), plus any row with focus (tracked by focus/blur on the list) or busy (menu, dialog or rename open; reported by `Row` through `onBusy`). Each rendered row's `margin-block-start` stands for the unrendered rows before it and the list's `padding-block-end` for those after, so no spacer elements break the list's semantics. The row height is measured from rendered rows (the smallest of up to five, skipping the first), 80 px before measuring. `role="list"` plus `aria-posinset`/`aria-setsize` on every row (plain lists too); the first-row border rule moved from `:first-child` to `[aria-posinset='1']`. Rows are a fixed height: title and metadata on one line with an ellipsis; every title line is at least `--size-control` (36 px) tall, the rename field's height, so renaming does not grow the row.
- **Dev page:** `dev/library500.ts` (`library500Title(i)`: two words from mixed-case/accented lists by `i` mod 10 and mod 7, plus the zero-padded number, so take 17 is "Café Blues 017"; `library500Notes(i)`: 6 notes) and `dev/Library500Page.tsx` (module-level seed promise, `createTake` + `commitAnalysis` per take, take 1 oldest, `location.replace('#/library')`). CI grep extended with `Library500|library500` and the `*Library500*` chunk name.
- **Gate:** `search-latency.dev.spec.ts` types and deletes 5 queries (`1239`, `roc`, `450`, `et`, `ca`; 28 keystrokes) after 4 unmeasured warm-up keys. The spec checks in advance that every keystroke changes the shown count (computed from the generator's titles with `searchKey`), so each has a DOM change to wait for; the probe waits until the first row's `aria-setsize` (or 0 for the no-match state) is the expected count, then rAF then a task. Median and p95 logged and attached as `search-latency.json`; fails above 50 ms. `PERF_SPECS` now matches `(edit|search)-latency.dev.spec.ts`.
- **Measured (perf project, `--no-deps`, this machine, dev build):** 28 keystrokes, median 14.1 ms, p95 24.5 ms.

## Plan Change Log

## Review Triage Log

### 2026-10-06 — Coordinator review fixes
- Folding: `searchKey` is now `foldLatin` (new `model/fold.ts`, shared with `slugify`, whose behaviour is unchanged): `toLowerCase` without the locale (Turkish-safe) plus ß ø æ œ ł đ folding; the query is trimmed before folding.
- Screen: an emptied library clears the query, moves focus from the field to the heading and drops a pending count; row titles carry `title`; row height via `getBoundingClientRect().height`; the range also follows a ResizeObserver (list and body); a window blur keeps the focused row rendered; the header comment says unrendered rows are out of reach of find-in-page and the virtual cursor (search is the find path).
- CSS: the rename field is back to `--size-control` (36 px) and every title line has a 36 px minimum, so all rows have the same height; no `lh`.
- Dev page: seeds in sequential batches of 25, skips when the 500 seeded takes (marked by their mic label) exist, and reports "Seeding failed: …" in its status; the perf spec fails fast on it, and its stored probe promises are marked handled.
- Tests: Turkish-locale stub, "oresund"/"Øresund", "blues " → "Riff Blues"; focused row, window blur and Confirm-dialog row stay rendered; tighter menu-scroll test; emptied-library test; the 500-take e2e checks the half-way scroll position and viewport coverage.

### 2026-10-06 — Review pass
- verdicts: 30 findings — high 0, medium 0, low 26, false 0, maybe-false 4
- findings:
  - `[low]` `[patch]` (blind, edge ×2) `searchKey` uses `toLocaleLowerCase` (Turkish İ/ı) and leaves ø/ß/æ/ł/đ/œ unfolded — `toLowerCase()` plus the same Latin fold the export slug uses (shared in `model/`); tests added.
  - `[low]` `[patch]` (blind, edge) The query isn't trimmed — trimmed before folding.
  - `[low]` `[patch]` (blind, edge ×3) An emptied library disables the field with a stale query, can strand focus, and announces "No takes match" over "No takes yet" — the query clears when the library becomes empty, focus moves to the heading if it was in the field, and the pending announcement is dropped.
  - `[low]` `[patch]` (blind, edge) Truncated titles can't be read in full — the title carries a `title` attribute.
  - `[low]` `[patch]` (blind, edge) The rename field shrank to ~26 px (below the 36 px control) and relies on `lh` — the title line has a 36 px minimum in every row, so the rename field keeps `--size-control`.
  - `[low]` `[reject]` (blind) The query and scroll position are lost on Back — no requirement asks to keep them; a later Library story can.
  - `[low]` `[patch]` (blind) Keep-rendered paths (focus, an open dialog) are untested and the menu-scroll test asserts too little — tests added and tightened.
  - `[low]` `[patch]` (blind, verification-gap) Row-height measurement and mid-list positions are unchecked in a real layout — the 500-take e2e scrolls to the middle and checks rows cover the viewport with matching `aria-posinset`.
  - `[low]` `[reject]` (blind) The scroll handler isn't rAF-throttled and rows aren't memoised — the p95 is 24.5 ms against 50; a future story can tune it.
  - `[maybe-false]` `[reject]` (blind, edge) Unrendered rows can't be reached by a screen reader's virtual cursor or find-in-page — inherent to virtualisation above 100 rows (the ticket's choice); search is the find path; the limit is now stated in the header comment.
  - `[low]` `[patch]` (blind) A loose generator assertion (fret ≤ 12) — tightened to < 12.
  - `[low]` `[patch]` (blind, edge ×2) The dev seed's `Promise.all` leaves a partial seed, and revisits duplicate — seeding is sequential in batches; a revisit with 500 seeded takes does not seed again; the e2e fails fast on the page's error status.
  - `[low]` `[reject]` (blind) The CI grep doesn't cover generator titles — the existing markers catch an import of the dev module.
  - `[low]` `[patch]` (edge) `offsetHeight` rounds fractional row heights, so positions drift over 500 rows — `getBoundingClientRect().height`.
  - `[low]` `[patch]` (edge) Content above the list changing height leaves a stale range — a ResizeObserver also recomputes it.
  - `[low]` `[patch]` (edge) Window blur unmounts the focused row on the next scroll — blur with no related target while the document lacks focus keeps the row rendered.
  - `[low]` `[patch]` (edge) The e2e probe's stored rejection logs an unhandled rejection — handled.
  - `[maybe-false]` `[reject]` (edge) "Fewer than 50 rows" fails on very tall viewports — the overscan design renders the viewport plus 20; the AC holds at the test viewport.
  - `[low]` `[reject]` (edge) Tab past the overscan skips the unrendered rows — the same inherent limit, documented.
  - `[maybe-false]` `[reject]` (intent) The virtualisation threshold applies to visible rows, not total takes — the plan's reading ("above 100 visible rows").
  - `[low]` `[reject]` (intent) The footer clause has no surface — the footer arrives with 6.7; filtering is view-local, so it will report the whole library.
  - `[maybe-false]` `[reject]` (intent) No evidence the gate trips — the gate is the assertion, as in 8.5.
  - `[low]` `[reject]` (intent) The gate times the count changing, not the exact rows — the same proxy as 8.5 (the DOM reflects the filter).
  - `[low]` `[reject]` (intent) Incremental scrolling is unit-only — the new mid-scroll e2e step covers a real layout.

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass.
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test --project=dev tests/e2e/library.dev.spec.ts && npx -y pnpm@12.6.0 exec playwright test --project=perf --no-deps` -- expected: pass, with the search table printed.
- `cd app && npx -y pnpm@12.6.0 build && ! grep -rl "Library500" dist` -- expected: no match.

## Auto Run Result

**Status:** built, 2026-10-06.

**Summary:**
- **Search:** the Library's "Search takes" field filters by title as you type, folding case, accents and ß/ø/æ/œ/ł/đ the same way in every locale (shared `model/fold.ts`), with the query trimmed.
  - No-match shows `No takes match "<query>"` with Clear search.
  - The count is announced 500 ms after typing stops.
  - The field is disabled, and the query cleared, when the library is empty.
- **Virtual list:** above 100 rows the list is virtualised: measured row height, overscan 10, `aria-posinset`/`aria-setsize`. Focused, menu-open, dialog-open and renaming rows stay rendered.
- **Dev page and gate:** the dev page `#/__test/library500` seeds 500 takes, and the `perf` project gates the per-keystroke filter-to-paint p95 at 50 ms or less.

**Files:**
- Model: `app/src/model/fold.ts` (new), `library.ts`, `export-file.ts`.
- Session and UI: `app/src/session/library-session.ts` (`withTitle`), `app/src/ui/screens/Library.tsx` (+ CSS), `icons.tsx`, `strings.ts`.
- Dev page: `app/src/dev/library500.ts` and `Library500Page.tsx` (new), `App.tsx`, `ci.yml` (grep).
- Tests:
  - `app/playwright.config.ts` (`PERF_SPECS`);
  - unit: `library`, `library500`, `library-screen`, `library-session`;
  - e2e: `library.dev.spec.ts` (search on real takes; 500 takes with top, middle and bottom scroll) and `search-latency.dev.spec.ts` (new).

**Review:** thorough, 30 findings (26 low, 4 maybe-false).
- **Patched (low):**
  - locale-independent folding with the Latin fold, and the trimmed query;
  - the emptied-library query, focus and announcement;
  - the title tooltip;
  - the 36 px rename field with fixed rows;
  - fractional row height and a ResizeObserver;
  - the window-blur focus guard;
  - dev seeding in batches with a skip-if-seeded check;
  - probe rejections handled;
  - tests for kept rows, the mid-list scroll and the tighter menu-scroll test.
- **Deferred:** none.
- **Rejected:** with reasons in the triage log.

**Follow-up review: not recommended.** No high or medium.

**Verification:**
- lint, typecheck, format:check and test pass (1648); the production build has no dev code.
- Full Playwright: 200 passed. A tuner timing test failed once under load and passed 12/12 alone; perf passed (search p95 ≈ 25 ms).

**Residual risks:**
- Unrendered rows aren't reachable by find-in-page or a screen reader's virtual cursor (stated in the header comment).
- The latency gate is wall-clock timing on the dev build.
