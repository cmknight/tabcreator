---
title: 'Refactor sweep (epic Tab editing)'
type: 'refactor'
ticket: '8'
created: '2026-10-05'
status: done
baseline_revision: 'b07c10d5cf94e7c74f497f7d966d56a0a235e604'
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
- [x] `app/src/session/analysis.ts` -- item 1.
- [x] `app/src/ui/components/TabArea.tsx` -- items 2, 4, 5.
- [x] `app/src/ui/screens/Tab.tsx` (+ `session/take-session.ts` event type if narrowed) -- item 3.
- [x] `engine/src/notes.rs`, `engine/tests/onset_fixtures.rs` -- item 6, the engine tests.
- [x] `app/tests/unit/tab-screen.test.tsx`, `app/tests/e2e/trim.dev.spec.ts` -- item 6, the app tests.
- [x] Implementation Notes -- the closed-as-fixed and deferred-with-owner lists.

**Acceptance Criteria:**
- Given the sweep is done, when lint, typecheck, unit tests, `cargo test` and the full Playwright run execute, then all pass with no test weakened, and the release accuracy files are unchanged (no `engine_version` bump).
- Given the plan, then every scoped item is closed, and every out-of-scope item is listed with its owner in Implementation Notes.

## Implementation Notes

**Scoped items, done:**
1. Double cancel: `analysis.ts` `cancelRun` is split into `cancelRerun` (the re-analysis) and `cancelQueued` (the queued run, unless committing); `cancelRun` is `cancelRerun || cancelQueued`, as before. `onStorage` now runs one commented sequence: cancel the re-analysis, cancel the queued run, drop the pending commit. Cancels settle their promises asynchronously, so moving `pending.delete` after the second cancel changes nothing observable; the take-deleted tests pass unchanged.
2. Re-fit state: `RefitState = 'shown' | 'fading'` in `TabArea.tsx`, derived once per note by `refitState`. `data-refit` keeps its values (`true` / `fading`, via `REFIT_ATTR`) because `tab-screen.test.tsx` and `tab-edit.dev.spec.ts` read them.
3. Unreachable labels: new `EditLabel` (`CommandLabel` without `reanalyse`, `trim`, `resetTrim`) in `model/edit-history.ts`; `EditCommand.label` and the `edit` `EditEvent`'s `label` use it, so `editText` in `Tab.tsx` has no impossible branches. The `resetTrim` branch was unreachable in the same way and went too. No copy changed; `commandLabelText` (undo/redo) still names all eight.
4. Memo comparator: `SYSTEM_VIEW_COMPARE` next to `SystemViewProps` is a mapped type over `keyof SystemViewProps` (`-?`): every prop must say `'whole'` (identity) or give its per-note projection, so a new prop fails `tsc` until it is listed. `sameSystemView` is derived from it. A unit test checks each per-note prop on a note inside vs outside the system, the fade, the whole props, and that the list's keys equal the props'.
5. Render side effect: the layout `useMemo` calls `layoutTab(…, committedLayout.current)`; the ref is set in a `useLayoutEffect` after commit. `react-hooks/refs` flags the read during render; it is disabled on that one line with the reason (`previous` changes only system identity, never the layout, and a discarded render never becomes `previous`). `createTabLayouter`, left with no caller, is removed; its reuse unit test now runs on `layoutTab(…, previous)`.
6. Tests: `notes.rs` `ring_over_window_ends_at_exactly_the_max_gap` (gap 500 dropped, 501 kept) and `ring_over_drops_each_repeat_while_the_middle_note_stays` (A B A′ A″). `onset_fixtures.rs` `ringing_overlap_middle_onsets_are_not_legato` (a separate test, as there was no ringing_overlap row in `onset_fixtures`): it passes on the current engine (12/12 onsets, none of the 11 after the first legato), so it is not ignored; the 8.9 deferral records this. `tab-screen.test.tsx`: the comparator test and a direct TabArea render with `refitIds`/`refitFading` plus flagged and selected notes. `trim.dev.spec.ts`: trim the end by keyboard (passes 5/5 runs).

**Closed as already fixed:**
- Deleting an inserted note records no `deletedStartMs` (8.6: `deleteNote`, `inserted`).
- Enter = Confirm on a note button and the modal-open dispatcher check (8.3).
- Re-analysis `before` uses the current trim (8.7's trim snapshot command).
- The dead strings, guards and props removed in 8.2, 8.6 and 8.7.
- The 8.9 trill `.any()` check (8.9).

**Deferred, with owners:**
- Later sweep (after the 8.1 save-lifecycle and 8.7 waveform-worker follow-up reviews): splitting `session/take-session.ts` and `ui/screens/Tab.tsx`.
- Epic Offline, accessibility and budgets: toolbar arrow-key navigation (8.4); the calibrated AD-17 latency gate on the deployed build (8.5).
- Architecture: `Note.inserted` with no shape-version bump (AD-11); `analysedSettings` across sessions; the route exit not awaiting `flush()`, and the reload/flush interplay (8.1).
- Engine: the `mapFrets` wait behind a running analysis; sensitivity versus note count; SM5 `legato` on picked notes (synth fixture now shows no legato middle onset; a real ringing recording remains); the `max_fret` overflow; the 8.9 residuals.
- Product and UX owner: the prefs clamp migration; a storage-full re-analysis having no Retry; the insert and popover-path rejects from 8.3; the waveform retry and theme redraw (8.7); all EXPERIENCE.md copy in deferred-work.

## Plan Change Log

- Item 3 also removed the `resetTrim` branch of `editText` (unreachable for the same reason); the label type is narrowed rather than guarded with `assertNever`.
- Item 6: the ringing_overlap check is its own `#[test]` in `onset_fixtures.rs` (the file had no ringing_overlap row), so an `#[ignore]` would not have disabled the main onset test; not needed, it passes.
- Item 5: one `eslint-disable-next-line react-hooks/refs` with its reason (precedent: two `exhaustive-deps` disables in `ui/components`).

## Review Triage Log

### 2026-10-05 — Review pass
- verdicts: 22 findings — high 0, medium 0, low 20, false 2, maybe-false 0
- findings:
  - `[low]` `[patch]` (verification-gap, other) `createTabLayouter` is dead after item 5 — removed; its reuse test now runs on `layoutTab(…, previous)`.
  - `[low]` `[patch]` (blind) `createTabLayouter` is dead — the same.
  - `[low]` `[patch]` (blind) The take-deleted path with both a re-analysis and a queued run live is untested — test added (both reject `analysis-cancelled`, pending dropped, listener released).
  - `[low]` `[reject]` (blind) The cancel order changed (`pending.delete` after both cancels) — the aborts only reject promises, whose handlers run later as microtasks; the verification-gap lens confirms nothing can observe the difference.
  - `[false]` `[reject]` (blind) `engine.cancel(takeId)` may run twice — `engineClient.cancel` rejects that take's queued and in-flight requests; a second call finds none and does nothing.
  - `[low]` `[patch]` (blind) `EditLabel` is a deny-list (`Exclude`) — `SnapshotLabel` is now its own union, with `CommandLabel = EditLabel | SnapshotLabel`.
  - `[low]` `[reject]` (blind) The comparator derives the re-fit state twice per note — negligible cost; both props must be listed for the coverage guarantee.
  - `[low]` `[reject]` (blind) The key-check test can miss an optional prop absent from `base`; memo wiring is untested — the mapped type with `-?` forces every key at compile time; the 8.5 render tests catch broken memo wiring.
  - `[low]` `[patch]` (blind) The e2e's exact `currentTime === endMs` is brittle — now within one trim step (10 ms).
  - `[low]` `[patch]` (blind) The e2e's fixture assumptions fail unclearly (`!` before `toBeDefined`, fret 7, chords) — the preconditions are asserted explicitly and the target is picked from distinct start times.
  - `[low]` `[reject]` (blind) Home/End, the minimum gap and undo of an end trim are not e2e-covered — unit-tested in 8.7; the start-trim e2e covers undo and redo.
  - `[low]` `[reject]` (blind) The ring-over tests don't cover a legato B or a Flux repeat — covered by 8.9's `a_trill_return_after_a_legato_middle_note_is_kept` and `ring_over_take(Flux)`.
  - `[low]` `[reject]` (blind) A″ inside the window doesn't show the outside-window case — `ring_over_keeps_a_repeat_starting_after_the_window` (8.9) covers it.
  - `[low]` `[patch]` (blind) The ringing_overlap test has an unexplained 30 ms tolerance, prints the table every run, and skips the last note — commented, printing removed, the last note included.
  - `[low]` `[reject]` (blind) `data-refit="true"` against the internal `'shown'` — per the plan (keep the attribute when tests depend on it); `REFIT_ATTR` now notes it is a fixed test contract.
  - `[false]` `[reject]` (blind) The plan files are missing from the diff — the reviewed diff covers app and engine only; the plan holds the closed and deferred lists.
  - `[low]` `[patch]` (edge) The comparator test assumes at least 2 systems — the precondition is asserted.
  - `[low]` `[patch]` (edge) `createTabLayouter` dead — the same as above.
  - `[low]` `[reject]` (intent) Item 4 enforces prop coverage, not projection correctness — the plan's reading ("fails when a prop is added but not compared").
  - `[low]` `[reject]` (intent) Item 2 derives twice in the comparator — the same as the blind finding.
  - `[low]` `[reject]` (intent) Item 5 still reads a ref during render (lint suppressed with a reason) — the write moved after commit as scoped; the read only picks objects to reuse.
  - `[low]` `[reject]` (intent) "Stories 1 to 7" against 8.9 items in scope — 8.9 is an epic Tab editing story that 8.8 waits on; scope was set at start.

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass.
- `cd engine && export PATH="$HOME/.cargo/bin:$PATH" && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked` -- expected: pass.
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test --project=dev tests/e2e/trim.dev.spec.ts tests/e2e/tab-edit.dev.spec.ts tests/e2e/tab-screen.dev.spec.ts` -- expected: pass.
- `git diff --stat -- engine/tests/*.json testdata` -- expected: empty.

## Auto Run Result

**Status:** built, 2026-10-05.

**Summary:** the cleanup sweep for epic Tab editing, with no behaviour, copy or engine-output change.
- **Code:**
  - `analysis.ts` `onStorage` runs one commented cancel sequence (`cancelRerun`, then `cancelQueued`);
  - the TabArea re-fit state is the named `RefitState` (`data-refit` values kept as a test contract);
  - the edit and snapshot command labels are split into `EditLabel | SnapshotLabel`, so `editText` has no unreachable branches;
  - `SYSTEM_VIEW_COMPARE` must name every `SystemViewProps` key (enforced by tsc);
  - the previous layout is held in a ref updated after commit, and the dead `createTabLayouter` is removed.
- **Tests:**
  - `ring_over` boundary tests (500 ms dropped, 501 kept; A B A′ A″);
  - ringing_overlap's 11 later onsets are not legato (passes; noted on the 8.9 deferral);
  - direct TabArea re-fit outline and comparator tests;
  - a take deleted with both runs live;
  - a trim-end e2e (later notes hidden and uncounted, earlier times kept, playback pauses at the end, Reset restores).
- **Closed as fixed and deferred-with-owner lists:** in Implementation Notes. That includes the take-session and Tab screen split, deferred until after the 8.1 and 8.7 follow-up reviews.

**Files:**
- `app/src/session/analysis.ts`, `app/src/model/edit-history.ts`, `app/src/model/tab-render.ts`, `app/src/session/take-session.ts` (types).
- `app/src/ui/components/TabArea.tsx`, `app/src/ui/screens/Tab.tsx`.
- `engine/src/notes.rs` (tests), `engine/tests/onset_fixtures.rs`.
- `app/tests/unit/{analysis,tab-render,tab-screen,take-session,edit-history}.test.ts(x)`, `app/tests/e2e/trim.dev.spec.ts`.

**Review:** thorough, 22 findings (20 low, 2 false).
- **Patched (low):**
  - the dead `createTabLayouter`;
  - the `SnapshotLabel` union;
  - the both-runs-live deletion test;
  - e2e preconditions and tolerance;
  - the `REFIT_ATTR` contract comment;
  - the onset test's tidy-up;
  - the comparator test precondition.
- **Deferred:** none new.
- **Rejected:** with reasons in the triage log.

**Follow-up review: not recommended.** No high or medium.

**Verification:**
- lint, typecheck, format:check and test pass (1489).
- Engine fmt, clippy and `cargo test` pass; the accuracy files are unchanged.
- The full Playwright run: 191 passed.
