---
title: 'Refactor sweep (epic Tab editing)'
type: 'refactor'
ticket: '8'
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

**Problem:** Stories 8.1–8.7 and 8.9 left cleanup items behind: dead or unreachable code kept for type reasons, a fragile hand-written memo comparator, a render-time side effect, duplicated cancel calls, awkward state naming, and test gaps rejected as "covered elsewhere".

**Approach:** Take the cleanup and test-only items below, with no change to behaviour, copy or engine output. Close the items later stories already fixed. Leave everything else explicitly deferred with its owner.

## Boundaries & Constraints

**Always (the agreed scope, set at start, 2026-10-05):**
1. **Double cancel** (8.6 triage): `app/src/session/analysis.ts` `onStorage` calls `cancelRun` twice (:215, :217) around `pending.delete`. Make it one clear sequence that cancels the re-analysis, then the queued run, with a comment. Behaviour stays identical, and the existing take-deleted tests pass.
2. **Re-fit state naming** (8.2 triage): the `'true' | 'fading'` re-fit state in `app/src/ui/components/TabArea.tsx` (:97 `noteClass`, :416-417) becomes a named type (`'shown' | 'fading'`), derived once per note. The `data-refit` attribute values may change only if no CSS or test outside TabArea and its CSS depends on them; otherwise keep the attribute values.
3. **Unreachable label branches** (8.6 triage): `editText` in `app/src/ui/screens/Tab.tsx` (:315-318: the `reanalyse` and `trim` branches that no `edit` event can carry). Narrow the `edit` event's label type, or use an exhaustive `assertNever` guard, so no plausible string is returned for an impossible case. No new copy.
4. **Memo comparator** (8.5 residual): `sameSystemView` in `TabArea.tsx` (:425) lists the per-note props by hand. Make it impossible to forget one: derive the compared per-note keys from a typed list next to `SystemViewProps` that must cover every prop. A type-level check or a unit test fails when a prop is added but not compared.
5. **Render side effect** (8.5 triage): the layout `useMemo` updates the layouter's `last` during render. Keep the previous committed layout in a ref, updated after commit (`useEffect`/`useLayoutEffect`), and pass it explicitly to `layoutTab(…, previous)`. Output stays identical, and the 8.5 reuse tests still pass.
6. **Tests only:**
   - `engine/src/notes.rs`: direct `ring_over` boundary tests: a gap of exactly `RING_OVER_MAX_GAP_MS` (dropped) and one more ms (kept); A B A′ A″ (both repeats dropped while B stays the middle note).
   - `engine/tests/onset_fixtures.rs`: assert that ringing_overlap's middle-note onsets come out with `legato == false` (8.9 deferred, medium, unverified). If the assertion fails on the current engine, do not change the engine. Mark the test `#[ignore]` with a comment, and record the finding in Implementation Notes and the 8.9 deferral for the engine owner.
   - `app/tests/unit/tab-screen.test.tsx` (TabArea block): render TabArea directly with `refitIds`/`refitFading` and assert the classes and `data-refit` on exactly those notes, combined with flagged and selected.
   - `app/tests/e2e/trim.dev.spec.ts`: trim the END by keyboard on the recorded take and save. Notes starting at or after the new end are hidden and not counted, earlier notes keep their `startMs`, Reset brings the hidden locked note back, and playback pauses at the trim end.
- **Close as already fixed** (record in Implementation Notes with the story that fixed each):
  - deleting an inserted note recorded `deletedStartMs` (8.6);
  - Enter = Confirm on a note button and the modal-open dispatcher check (8.3);
  - re-analysis `before` using the current trim (8.7's trim snapshot command);
  - the dead strings, guards and props removed in 8.2, 8.6 and 8.7;
  - the 8.9 trill `.any()` check (8.9).

**Never:**
- No behaviour, copy, layout or engine-output change, and no regenerated accuracy files.
- Don't weaken a test; a test changes only where a name or type moved.
- **Out of scope; these stay deferred with their owners** (record them in Implementation Notes):
  - **Large files** (later sweep, after the 8.1 save-lifecycle and 8.7 waveform-worker follow-up reviews, which cover the same code): splitting `app/src/session/take-session.ts` (1527 lines) and `app/src/ui/screens/Tab.tsx` (1109 lines).
  - **Epic Offline, accessibility and budgets:**
    - toolbar arrow-key navigation (8.4);
    - the calibrated AD-17 latency gate on the deployed build (8.5).
  - **Architecture:**
    - `Note.inserted` with no shape-version bump (AD-11);
    - `analysedSettings` across sessions;
    - the route exit not awaiting `flush()`, and the reload or flush interplay (8.1).
  - **Engine:**
    - the `mapFrets` wait behind a running analysis;
    - sensitivity versus note count;
    - SM5 `legato` on picked notes;
    - the `max_fret` overflow;
    - the 8.9 residuals.
  - **Product and UX owner:**
    - the prefs clamp migration;
    - a storage-full re-analysis having no Retry;
    - the insert and popover-path rejects from 8.3;
    - the waveform retry and theme redraw (8.7);
    - all EXPERIENCE.md copy in deferred-work.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Take deleted during a re-analysis | the existing take-deleted tests | unchanged results | — |
| Comparator guard | add a fake prop to `SystemViewProps` without comparing it | the type check or unit test fails | — |
| Layout reuse | an edit in system 1 | the same reuse as before (8.5 tests pass) | — |
| Ring-over boundary | gap = 500 ms / 501 ms | dropped / kept | — |
| Trim end | end handle to just after the 3rd note, Save | later notes hidden; earlier startMs unchanged; Reset restores; playback pauses at the end | — |

</intent-contract>

## Code Map

- `app/src/session/analysis.ts:205-220` `onStorage` (take-deleted: `cancelRun` ×2 around `pending.delete`); `cancelRun`; the reruns map (8.6).
- `app/src/ui/components/TabArea.tsx`: `noteClass` :97, the per-note re-fit state :416-417, `sameSystemView` :425, `SystemViewProps`, `SystemView`, the `createTabLayouter` use and the layout `useMemo` (8.5).
- `app/src/model/tab-render.ts`: `layoutTab(notes, widthChars, countInBpm?, previous?)`, `createTabLayouter`.
- `app/src/ui/screens/Tab.tsx`: `editText` :315-318; the `EditEvent` type from `session/take-session.ts` (the `edit` variant's `label: CommandLabel`); `CommandLabel` in `model/edit-history.ts`.
- `engine/src/notes.rs`: `ring_over`, `RING_OVER_MAX_GAP_MS`, the test module (`Candidate` helper `n()`). `engine/tests/onset_fixtures.rs`: the ringing_overlap rows; `Onset.legato`.
- `app/tests/unit/tab-screen.test.tsx` (the TabArea direct-render tests from 8.5). `app/tests/e2e/trim.dev.spec.ts` (the start-trim flow, `audioSha256`, recording helpers).

## Tasks & Acceptance

**Execution:**
- [ ] `app/src/session/analysis.ts` -- item 1.
- [ ] `app/src/ui/components/TabArea.tsx` -- items 2, 4, 5.
- [ ] `app/src/ui/screens/Tab.tsx` (+ `session/take-session.ts` event type if narrowed) -- item 3.
- [ ] `engine/src/notes.rs`, `engine/tests/onset_fixtures.rs` -- item 6, the engine tests.
- [ ] `app/tests/unit/tab-screen.test.tsx`, `app/tests/e2e/trim.dev.spec.ts` -- item 6, the app tests.
- [ ] Implementation Notes -- the closed-as-fixed and deferred-with-owner lists.

**Acceptance Criteria:**
- Given the sweep is done, when lint, typecheck, unit tests, `cargo test` and the full Playwright run execute, then all pass with no test weakened, and the release accuracy files are unchanged (no `engine_version` bump).
- Given the plan, then every scoped item is closed, and every out-of-scope item is listed with its owner in Implementation Notes.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass.
- `cd engine && export PATH="$HOME/.cargo/bin:$PATH" && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked` -- expected: pass.
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test --project=dev tests/e2e/trim.dev.spec.ts tests/e2e/tab-edit.dev.spec.ts tests/e2e/tab-screen.dev.spec.ts` -- expected: pass.
- `git diff --stat -- engine/tests/*.json testdata` -- expected: empty.
