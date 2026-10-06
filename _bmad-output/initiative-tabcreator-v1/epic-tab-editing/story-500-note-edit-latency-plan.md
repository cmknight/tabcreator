---
title: '500-note edit latency'
type: 'feature'
ticket: '5'
created: '2026-10-05'
status: 'draft'
route: 'full'
route_source: 'auto'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** CAP-14 and AD-17 require every edit to render in ≤ 100 ms (p95) on a 500-note tab. Nothing measures it, and the editing code (8.1–8.7) has never been timed at that size.

**Approach:**
- A dev-only page, `#/__test/tab500`, seeds a generated 500-note take and tab, then opens it on the Tab screen.
- A dev e2e measures edit-to-paint for each edit kind and fails if any kind's p95 is above 100 ms.
- Fix whatever the measurement finds: layout memoisation per system in `model/tab-render.ts`, reuse of the edit popover and overlays, and anything else the profile shows.

## Boundaries & Constraints

**Always:**
- **Dev page** (`app/src/dev/Tab500Page.tsx`, registered with the other `#/__test/*` pages in `App.tsx`, gated on `import.meta.env.DEV`).
  - It generates a deterministic (seeded) 500-note tab: notes 250 ms apart, a scale-like pitch walk across all six strings within frets 0–12, about 10% flagged low-confidence, a few locked.
  - Notes come in phrases of 16 separated by gaps over 1000 ms. This is the gated shape, typical playing.
  - With `?onePhrase`, there are no gaps: one 500-note phrase, the ticket's unknown. It is measured and reported, not gated.
  - It seeds through `db.createTake` + `commitAnalysis` like the e2e `seedTab` helper (no audio needed), then replaces the hash with `#/tab/<id>`.
  - Nothing from it reaches the production bundle; extend the CI dev-code grep with its name.
- **Measurement** (`app/tests/e2e/edit-latency.dev.spec.ts`):
  - **Edit-to-paint** is the time from the key event's `timeStamp` to the first animation frame after the tab area's DOM reflects the edit. The tab area is watched with a MutationObserver, then the next `requestAnimationFrame` is awaited.
  - It includes the real engine's `mapFrets` round trip (the dev build's worker), React render and layout.
  - **Edit kinds:** set fret (one digit), string move (↑ or ↓), delete, insert, confirm (Enter), undo (Ctrl+Z), redo (Ctrl+Shift+Z).
  - **Sampling:** at least 20 samples per kind, each on a different note spread over the tab, after 3 unmeasured warm-up edits.
  - p95 is the nearest-rank 95th percentile.
  - **Report:** the test logs a table (kind, n, median, p95) for both shapes and attaches it as JSON (`testInfo.attach`).
  - **Gate:** it fails when any kind's p95 on the phrased shape exceeds 100 ms. The one-phrase numbers are reported only.
- **Fixes:** change what the profile shows, keeping behaviour identical. The existing unit and e2e suites must pass unchanged. Likely candidates:
  - **Layout:** `layoutTab` re-lays out only the systems whose notes changed (memoised per system on note identity); TabArea re-renders only changed systems (`React.memo` per system, stable props).
  - **Labels and counts:** `noteLabels` and the status-line counts are computed once per notes array.
  - **Popover and overlay:** the edit popover and overlay are reused, not re-created.
  - **Re-fit:** the re-fit sends only the edited phrase (already true; check it).
- Record before-and-after numbers in Implementation Notes.

**Never:**
- No CI budget gate wiring (AD-17's gate belongs to epic Offline, accessibility and budgets).
- No change to edit semantics, the re-fit scope or engine code.
- No loosening of 100 ms.
- No dev page code in production.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Phrased 500 | each edit kind × ≥ 20 | p95 ≤ 100 ms per kind; the table is logged | > 100 ms: the test fails, naming the kind |
| One phrase | `?onePhrase` | the table is logged; not gated | — |
| Deterministic | the page loaded twice | identical notes (seeded) | — |
| Prod bundle | `pnpm build` | no Tab500Page code (grep) | CI grep fails |
| Memoised layout | one note's fret changed | only that system's layout object changes; the others keep identity | — |

</intent-contract>

## Code Map

- `app/src/App.tsx:51-58`: the dev test page map (`'#/__test/storage'`, `'#/__test/ui'` → lazy imports from `./dev/`). Dev pages: `app/src/dev/StorageTestPage.tsx`, `UiTestPage.tsx`.
- `app/tests/e2e/tab-helpers.ts`: `makeNotes`, `seedTab` (dynamic-imports `/src/storage/db.ts`; `createTake` then `commitAnalysis(..., analysisVersion 'seeded')`), `noteButton`, `tabArea`. Mirror its seeding in the dev page.
- `app/src/model/tab-render.ts`: `layoutTab(notes, widthChars, countInBpm?) → {systems}` :147, `TabCell`, `toText`.
- `app/src/ui/components/TabArea.tsx`: the `layout` memo on notes (:173 at 5.8; it has moved since); the per-system render and note buttons; the focus-follow and reflow effects.
- `app/src/ui/screens/Tab.tsx`: `noteLabels`, `visibleNotes`/`shownNotes`, TabStatusLine, TakeWarnings, usePlayback, and the EditPopover/overlays wiring.
- `app/src/session/take-session.ts` `runCommand` (the plan, `mapFrets` and publish path); `app/src/model/edit-history.ts` (the re-fit request per phrase).
- `.github/workflows/ci.yml:195`: the dev-code grep list (add `Tab500Page` or the page's marker string).
- e2e config: `app/playwright.config.ts` (the `dev` project matches `*.dev.spec.ts`).

## Tasks & Acceptance

**Execution:**
- [ ] `app/src/dev/Tab500Page.tsx`, `App.tsx`, `ci.yml` -- the seeded generator and the page -- the measurement surface.
- [ ] `app/tests/e2e/edit-latency.dev.spec.ts` -- the measurement, report and gate -- the AC.
- [ ] `app/src/model/tab-render.ts`, `TabArea.tsx`, `Tab.tsx` (and whatever else the profile shows) -- fixes -- the budget.
- [ ] Unit tests: the generator is deterministic; per-system memoisation keeps unchanged systems' identity; behaviour is unchanged (existing suites).

**Acceptance Criteria:**
- Given the dev build and `#/__test/tab500`, when the e2e performs at least 20 of each edit kind (set fret, string move, delete, insert, confirm, undo, redo), then it reports per-kind median and p95 edit-to-paint, and every p95 is ≤ 100 ms.
- Given `#/__test/tab500?onePhrase`, when the same edits run, then their numbers are reported in the same table, marked "not gated".

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass.
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test --project=dev tests/e2e/edit-latency.dev.spec.ts tests/e2e/tab-edit.dev.spec.ts tests/e2e/tab-screen.dev.spec.ts` -- expected: pass, with the table printed.
- `cd app && npx -y pnpm@12.6.0 build && ! grep -r "Tab500" dist` -- expected: no match.
