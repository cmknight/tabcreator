---
title: 'Search 500 takes'
type: 'feature'
ticket: '3'
created: '2026-10-06'
status: 'draft'
route: 'full'
route_source: 'auto'
review: ''
review_source: ''
lenses_ran: []
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
- [ ] `app/src/model/library.ts` -- `searchKey`, `filterRows` -- the pure rule.
- [ ] `app/src/ui/screens/Library.tsx` (+ CSS), `strings.ts` -- search, no-match, Clear, announcement, virtualised list -- the screen.
- [ ] `app/src/dev/Library500Page.tsx` (+ seed module), `App.tsx`, `ci.yml` -- the dev page.
- [ ] `app/tests/e2e/search-latency.dev.spec.ts`, `playwright.config.ts` -- the gate.
- [ ] Unit tests for every I/O row; an e2e search on real takes in `library.dev.spec.ts`.

**Acceptance Criteria:**
- Given the 500-take dev page, when the e2e types and deletes at least 20 characters in the search field, then it reports per-keystroke filter-to-paint median and p95, and p95 is ≤ 50 ms.
- Given takes "Café Blues" and "Riff", when the player types "cafe", then only "Café Blues" is listed; and "zzz" shows the no-match state, whose Clear search restores both.
- Given 500 takes, then fewer than 50 row elements are in the DOM, and scrolling to the bottom reaches the oldest take, which opens with Enter.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass.
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test --project=dev tests/e2e/library.dev.spec.ts && npx -y pnpm@12.6.0 exec playwright test --project=perf --no-deps` -- expected: pass, with the search table printed.
- `cd app && npx -y pnpm@12.6.0 build && ! grep -rl "Library500" dist` -- expected: no match.
