---
title: '500-note edit latency'
type: 'feature'
ticket: '5'
created: '2026-10-05'
status: 'built'
baseline_revision: '35a766c380ba1943f7a3bccc6dbc71b6e0a72d64'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
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
- [x] `app/src/dev/Tab500Page.tsx`, `App.tsx`, `ci.yml` -- the seeded generator and the page -- the measurement surface.
- [x] `app/tests/e2e/edit-latency.dev.spec.ts` -- the measurement, report and gate -- the AC.
- [x] `app/src/model/tab-render.ts`, `TabArea.tsx`, `Tab.tsx` (and whatever else the profile shows) -- fixes -- the budget.
- [x] Unit tests: the generator is deterministic; per-system memoisation keeps unchanged systems' identity; behaviour is unchanged (existing suites).

**Acceptance Criteria:**
- Given the dev build and `#/__test/tab500`, when the e2e performs at least 20 of each edit kind (set fret, string move, delete, insert, confirm, undo, redo), then it reports per-kind median and p95 edit-to-paint, and every p95 is ≤ 100 ms.
- Given `#/__test/tab500?onePhrase`, when the same edits run, then their numbers are reported in the same table, marked "not gated".

## Implementation Notes

- **Generator and page:** the seeded generator is its own dev module, `app/src/dev/tab500.ts` (`tab500Notes`, mulberry32, seed 500), so the unit test can import it; `Tab500Page.tsx` keeps the in-flight seed per shape at module level (StrictMode's second mount reuses it, so one take per visit) and seeds through `db.createTake` + `commitAnalysis` and `location.replace`s to `#/tab/<id>`. `App.tsx` looks dev pages up by the hash path before `?`, so `#/__test/tab500?onePhrase` reaches the same page. Phrases: 16 notes, then a 1550 ms gap (start-to-start +1500 ms). About 10% flagged (seeded), every 61st note (from index 30) locked. CI grep extended with `Tab500|tab500Notes` and the `*Tab500*` chunk name.
- **Measurement:** the probe is a capturing `keydown` listener (modifier keys ignored, so Ctrl+Z times from the Z) plus a MutationObserver on the tab area; "reflects the edit" means the area's signature changed (all `<pre>` text, the count of "check this note" labels, the note-button count), then one `requestAnimationFrame` and a `setTimeout 0` after it, so that frame's layout and paint count; a probe timeout names the kind and note, and an unparsable label throws. Each kind edits a different note per sample, spread over the tab, re-reading the note's label just before the key (a re-fit may have moved it); undo and redo are measured on the same note after an unmeasured fret change. Warm-up is 3 unmeasured edits per kind. Each shape has its own test (the phrased one gated, the one-phrase one reported only); each logs its table and attaches it as JSON.
- **Profile (CPU profile, 4x CDP throttle, dev build):** ~70% of an edit's main-thread time was React dev `jsxDEV` creating all ~500 note buttons on every Tab render (each render re-rendered every system and re-created every button's ref callback and style object). `layoutTab`, `noteLabels`, the status-line count and `mapFrets` were minor.
- **Fixes:** `layoutTab(notes, width, bpm, previous?)` reuses an earlier system object when its units (the same note objects, spacing and bar lines) are unchanged; `createTabLayouter()` remembers the last layout (TabArea holds one per mount). TabArea renders each system as a memoised `SystemView` (keyed by its first note id, so a change in the system count does not remount later systems) whose comparator checks the system, metrics and, per note in it, label, flag, selection, tab stop, playing and re-fit state; the note handlers are stable (`useState`) and call the latest callbacks (a ref refreshed in a layout effect, declared before the focus-follow effect). `TabStatusLine` counts flagged notes once per notes array. Re-fit scope checked: `refitting` sends `phraseOf` the edited note (delete: its former neighbours' phrases) — unchanged.
- **Not changed:** the edit popover and overlay. The popover is keyed per note on purpose (its state resets for each note) and is not on the keyboard edit path the profile measured; reusing it would change behaviour for no measured gain.
- **Numbers (p95 ms, phrased / one phrase; this machine, dev build):**

  | kind | before 1x | after 1x | before 4x throttle | after 4x throttle |
  |---|---|---|---|---|
  | set fret | 35.8 / 33.5 | 27.9 / 19.8 | 144.1 / 110.7 | 117.4 / 55.4 |
  | string move | 28.5 / 24.1 | 22.9 / 20.6 | 140.5 / 115.5 | 65.9 / 64.3 |
  | confirm | 26.0 / 24.8 | 20.6 / 21.5 | 125.0 / 120.6 | 41.8 / 37.5 |
  | insert | 52.7 / 52.8 | 32.3 / 25.5 | 274.3 / 235.1 | 175.0 / 138.4 |
  | delete | 49.8 / 55.3 | 31.1 / 29.3 | 269.3 / 240.3 | 153.1 / 136.6 |
  | undo | 30.8 / 24.6 | 16.6 / 8.4 | 109.1 / 110.0 | 36.8 / 34.5 |
  | redo | 26.5 / 24.6 | 20.3 / 21.5 | 106.9 / 112.3 | 35.6 / 46.8 |

  Medians at 4x fell from ~100–220 ms to ~30–98 ms. The 1x numbers (the gated run) were already under budget before the fixes on this machine. Insert and delete stay the slowest: they renumber every later note's label ("Note n: …") and shift the wrap of every later system, so every later system re-renders by design. The throttled run was a local profiling aid only (not in the spec).

## Plan Change Log

## Review Triage Log

### 2026-10-05 — Review pass
- verdicts: 25 findings — high 0, medium 0, low 22, false 3, maybe-false 0
- findings:
  - `[low]` `[patch]` (blind) StrictMode runs the seeding effect twice, leaving an orphan 500-note take per visit — the seed promise is kept at module level and reused.
  - `[low]` `[patch]` (blind) `key={i}` on `SystemView` remounts every later system when the system count changes — keyed by the system's first note id.
  - `[low]` `[patch]` (blind) The ungated one-phrase shape shares the gated test's timeout and assertions — moved to its own test.
  - `[low]` `[reject]` (blind) CI runs a wall-clock gate on the dev build on shared runners — the ticket specifies a dev e2e asserting p95 ≤ 100 ms; measured p95 is 17–33 ms (about 3× headroom); the calibrated AD-17 gate is epic Offline, accessibility and budgets'.
  - `[low]` `[reject]` (blind) Undo and redo are measured only after a set fret — every undo restores a snapshot through the same publish path; the other kinds are measured directly.
  - `[low]` `[patch]` (blind) The e2e parses English labels and silently falls back on a mismatch — it now throws when a label doesn't parse.
  - `[low]` `[patch]` (blind) No test pins the hand-written memo comparator or the stable handlers — the render-identity tests below; the handler-latest check is added too.
  - `[low]` `[reject]` (blind) The layout `useMemo` updates the layouter's `last` during render — output is identical either way (reuse never changes the result).
  - `[low]` `[patch]` (blind) Inaccurate comments in `tab500.ts` (spacing, a stale `PHRASE_GAP_MS` reference, "gap" naming) — corrected.
  - `[low]` `[reject]` (blind) Loose `?onePhrase` parsing — dev-only; only the e2e uses it.
  - `[low]` `[reject]` (blind) p95 of 20 samples is the second-worst sample — the plan's sample size; the margin is about 3×.
  - `[false]` `[reject]` (blind) The story record is missing — the plan's Implementation Notes hold the before/after and one-phrase numbers (the plan was outside the reviewed diff).
  - `[low]` `[patch]` (edge) The time is read in a rAF callback, before that frame's layout and paint — now read after the frame (rAF, then a task), so it includes layout and paint.
  - `[low]` `[patch]` (edge) A probe timeout fails with a generic error — it names the kind and note.
  - `[false]` `[reject]` (edge) A Note mutated in place would reuse a stale system — notes are immutable throughout (every command builds new objects; `Readonly` types), so in-place mutation does not occur.
  - `[low]` `[patch]` (verification-gap) Stale "Note n" and "Tab system i of n" after an insert or delete in reused systems would pass every test — a multi-system test now deletes and inserts early and checks later labels and group names.
  - `[low]` `[patch]` (verification-gap) Reverting the reuse/memo would still pass the gate — a tab-screen test asserts that an unchanged system's DOM nodes are reused (not re-rendered) across an edit.
  - `[low]` `[reject]` (intent) "Overlay reuse" read as the popover vs the note-button overlay — the memoised `SystemView` reuses the note-button overlay (epic 5's term); the popover is off the keyboard edit path (recorded).
  - `[low]` `[reject]` (intent) The gated run passed before the fixes — the fixes answer the profile; the new identity tests pin them structurally.
  - `[low]` `[reject]` (intent) The dev e2e becomes a CI gate — the same as the blind finding.
  - `[low]` `[reject]` (intent) Mouse paths and reanalyse/trim are not measured — the ticket names edit kinds on the keyboard path; reanalyse/trim are engine runs, not edits.
  - `[false]` `[reject]` (intent) The unknown is only reported — F1 is the plan's chosen reading; the one-phrase numbers (p95 ≤ 33 ms) answer it.
  - `[low]` `[patch]` (intent) Paint-proxy fidelity — the same as the edge rAF finding.
  - `[low]` `[reject]` (intent) Dev build, not the deployed build — the ticket specifies a dev e2e; the deployed-build budget is AD-17's gate in epic Offline, accessibility and budgets.

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass.
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test --project=dev tests/e2e/edit-latency.dev.spec.ts tests/e2e/tab-edit.dev.spec.ts tests/e2e/tab-screen.dev.spec.ts` -- expected: pass, with the table printed.
- `cd app && npx -y pnpm@12.6.0 build && ! grep -r "Tab500" dist` -- expected: no match.

## Auto Run Result

**Status:** built, 2026-10-05.

**Summary:**
- **Dev page:** `#/__test/tab500` seeds a deterministic 500-note take: phrases of 16, or one phrase with `?onePhrase`, StrictMode-safe. Its code is kept out of the production bundle (CI grep).
- **Gate:** `edit-latency.dev.spec.ts` measures edit-to-paint (key timestamp to after the first frame showing the edit, layout and paint included). It covers seven edit kinds × 20 samples, reports a table plus JSON, and fails if any phrased kind's p95 exceeds 100 ms. The one-phrase shape is reported, not gated.
- **Isolation:** it runs in its own `perf` Playwright project (one worker, after every other project), because parallel suite load had pushed insert to 108 ms.
- **Fixes from a CPU profile:**
  - `layoutTab` reuses unchanged systems (`createTabLayouter`);
  - TabArea renders each system as a memoised `SystemView`, keyed by its first note id, with stable handlers;
  - TabStatusLine memoises its flagged count.

**Files:**
- `app/src/dev/Tab500Page.tsx`, `app/src/dev/tab500.ts` (new); `app/src/App.tsx` (dev routes match on the hash before `?`).
- `app/src/model/tab-render.ts`, `app/src/ui/components/TabArea.tsx`, `TabStatusLine.tsx`.
- `app/playwright.config.ts` (`perf` project), `.github/workflows/ci.yml` (dev-code grep).
- Tests: `tests/unit/tab500.test.ts`, `tab-render.test.ts` (system identity and equivalence), `tab-screen.test.tsx` (renumbered labels and group names after insert and delete, DOM reuse of unchanged systems, latest callbacks); `tests/e2e/edit-latency.dev.spec.ts`.

**Measured p95, ms (perf project, two runs):**

| kind | phrased | one phrase |
|---|---|---|
| set fret | 32–35 | 24 |
| string move | 24–27 | 29–32 |
| confirm | 17–20 | 18–20 |
| insert | 28–33 | 41–49 |
| delete | 26–34 | 41–44 |
| undo | 9–17 | 22 |
| redo | 22 | 22–23 |

**Review:** thorough, 25 findings (22 low, 3 false).
- **Patched (low):**
  - StrictMode double seeding;
  - system keys;
  - the one-phrase run split into its own test;
  - timing after paint;
  - named probe timeouts;
  - label parse failures;
  - comments;
  - tests pinning the per-system reuse and label renumbering.
- **Deferred:** none.
- **Rejected:** with reasons in the triage log.

**Follow-up review: not recommended.** No high or medium.

**Verification:**
- lint, typecheck, format:check and test pass (1485); the production build has no dev code.
- The full Playwright run (dev, chromium, prod-mic, subpath, perf) passed twice: 190 passed, none flaky.

**Residual risks:**
- The gate measures the dev build on whatever machine runs it; on a much slower runner it could still flake. The calibrated AD-17 gate belongs to epic Offline, accessibility and budgets.
- `perf` is skipped if another project fails, and `--project=perf` alone needs `--no-deps`.
- The hand-written `SystemView` comparator must list every per-note prop. Tests catch a stale re-render of an unchanged system, but not a newly added prop.
