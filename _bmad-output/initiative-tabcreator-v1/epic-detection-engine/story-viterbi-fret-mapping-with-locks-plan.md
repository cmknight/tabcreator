---
title: 'Viterbi fret mapping with locks'
type: 'feature'
ticket: '5'
created: '2026-10-03'
status: done
baseline_revision: 'a9846874fe10c8f4303b49fa76906d443a6750e4'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-detection-engine/epic-detection-engine.md'
  - '{project-root}/TabCreator-User-Stories.md'
warnings: []
deferred:
  - summary: >-
      TabCreator-User-Stories.md (US-5.1 acceptance) and SPEC.md (CAP-11 success) still require position-specific scales to stay in position, which the user dropped for v1.
    evidence: |-
      The epic Notes hold the Source conflict and the settling Decision (2026-10-03). The source text should be updated by the owner or through bmad-spec so later readers do not re-raise it.
    location: >-
      TabCreator-User-Stories.md US-5.1; _bmad-output/specs/spec-tabcreator/SPEC.md CAP-11
    severity: low
---

<intent-contract>

## Intent

**Problem:** `map_frets` is still epic 1's stub: the lowest fret for each note. Tabs need playable positions chosen across the whole phrase, with user locks respected (CAP-11, US-5.1, the engine side of US-5.2).

**Approach:** Add `engine/src/fretmap.rs`, a shortest-path (Viterbi) over each note's string/fret candidates using US-5.1's costs, with weights in `FretWeights`. `lib.rs`'s `map_positions` delegates to it in one line. Bump `engine_version()` to `0.2.0` and regenerate the committed accuracy files (epic decision: a change to engine output bumps the version).

## Boundaries & Constraints

**Always:**
- **Candidates:** note `m` → every (string `s`, fret `f`) with `f = m − OPEN_MIDI[s]` and `0 ≤ f ≤ maxFret`. A note with no candidate maps to `null` and is left out of the path; its neighbours connect across it.
- **Unary cost:** `U(s,f) = 0.02·f + 0.3·max(0, f − 12)`.
- **Transition cost** between consecutive mapped notes `a=(s1,f1)` and `b=(s2,f2)`:
  - `d = |f2 − f1|`, but `d = 0` if either fret is 0;
  - `T = w_shift·d + w_jump·max(0, d − 3) + w_skip·max(0, |s2 − s1| − 1)`;
  - if `startMs(b) − endMs(a) > 500`, multiply the shift terms (`w_shift` and `w_jump`) by 0.5;
  - `FretWeights::default()` = `w_shift 0.3, w_jump 1.0, w_skip 0.4`.
- **Search:** Viterbi over the whole input sequence minimises the total cost.
  - Ties: the lower fret wins, then the lower string number. Order candidates by (fret, string) and keep the first strictly-better choice, so the result is deterministic.
  - The known simplification goes in a code comment: an open string resets the hand position.
- **Locks:** `{index, string, fret}` restricts that note's candidates to exactly that position, which is honoured as given even when it is not one of the computed candidates. Locked notes never change. The existing errors stay: index out of range, string outside 1–6.
- **Version:** bump `Cargo.toml` to `0.2.0`, update the version unit test, and regenerate `engine/tests/accuracy-baseline.json` and `engine/tests/fixture-outputs.json` with `UPDATE_ACCURACY=1`.
- **Unchanged:** the wasm export signatures and JSON shapes. Weights are tunable only through `FretWeights` (AD-7).

**Never:**
- No app-side re-fit, phrase splitting or highlighting (epic Tab view and editor).
- No new crates.
- No changes to analyze or the pre-processing path.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Open strings | `open_strings` ground-truth notes | every note on its open string | — |
| Position 1 | `c_major_scale_pos1` ground truth | matches the fixture's string and fret exactly (so frets 0–3) | — |
| Agreement | all synth fixtures' ground-truth notes (fret ≥ 0) | ≥ 80% exact string+fret agreement, pooled | failure prints per-fixture agreement |
| Lock gives the cheapest path | `c_major_scale_pos1` with its fret-3-on-A note (C3) locked to string 6 fret 8, and random short sequences (≤ 7 notes) with random locks | the locked note is exactly (6,8), and the mapping's total cost equals the brute-force minimum over all candidate paths that honour the locks (US-5.2: neighbours move only "when cheaper") | — |
| Locks never change | random locks on a fixture | each locked note is exactly its lock | — |
| Unplayable | midi above maxFret on string 1, or below 40 | `null`; neighbours still mapped | — |
| Ties | two equal-cost paths | lower fret, then lower string | — |
| Gap halving | same pair of notes with a 400 ms vs 600 ms gap | the 600 ms case allows a larger shift at equal cost | — |
| Speed | 2 000 notes | maps in ≤ 50 ms | — |

</intent-contract>

## Code Map

- `engine/src/lib.rs`
  - `OPEN_MIDI` (index 0 = string 1).
  - `FretNote {midi, start_ms, end_ms}`, `FretLock {index, string, fret}`, `Position {string, fret}`.
  - `map_frets_core` → `map_positions(notes, locks, max_fret) -> Result<Vec<Option<Position>>, String>` (~line 184). Replace its body with a call into `fretmap`; delete `lowest_fret`.
  - The existing tests `map_frets_lowest_fret_and_unplayable`, `map_frets_respects_max_fret`, `map_frets_honours_locks_by_index` and `map_frets_rejects_bad_locks` encode stub behaviour. Keep their intent (unplayable → null, max fret honoured, locks by index, bad locks rejected) and update any expectation the stub's lowest-fret rule produced.
  - `version_is_package_version` asserts `"0.1.0"`.
- `engine/tests/accuracy/` and `engine/tests/fixtures.rs` -- the harness and committed files. Regenerate them with `UPDATE_ACCURACY=1 cargo test --test fixtures`. Pooled fret agreement stays `n/a` while detection finds no notes.
- `testdata/synth/*.json` -- the ground-truth notes `{startMs,endMs,midi,string,fret}`.

## Tasks & Acceptance

**Execution:**
- [x] `engine/src/fretmap.rs` -- `FretWeights`, candidates, costs, Viterbi with locks and ties, plus unit tests for the unplayable, ties, gap halving and lock rows -- US-5.1, US-5.2 engine side.
- [x] `engine/src/lib.rs` -- `mod fretmap;`, `map_positions` delegating to it, updated stub-era tests, and the version test at 0.2.0.
- [x] `engine/tests/fretmap_fixtures.rs` -- the ground-truth-fed fixture rows (open strings, position 1, ≥ 80% agreement, lock gives the cheapest path, locks never change) and the 2 000-note timing row.
- [x] `engine/Cargo.toml`, `engine/Cargo.lock`, `engine/tests/accuracy-baseline.json`, `engine/tests/fixture-outputs.json` -- version 0.2.0 and the regenerated files.

**Acceptance Criteria:**
- Given the ground-truth notes of every synth fixture, when they are mapped with no locks, then pooled exact agreement is at least 80%, and the test prints per-fixture agreement.
- Given the production build, when the existing `engine.spec.ts` worker test runs, then it still passes (one valid position per ground-truth note).

## Implementation Notes

- Default `FretWeights` (0.3, 1.0, 0.4) kept: pooled agreement 520/590 = 88.1%. Below 100%: e_minor_pentatonic_pos12 2/12, legato_slurs 0/17, octave_leaps 9/12, octave_traps 7/8, slide_up 1/3, vibrato 1/3 (same for noisy twins); all others 100%.
- Position-12 row dropped per the Plan Change Log; its test is removed. e_minor_pentatonic_pos12 maps low (2/12 agreement), inside the passing pooled gate.
- Lock row: `fretmap::path_cost(notes, path, weights)` is exposed (the total `map_positions` minimises). `fretmap_fixtures.rs` checks the mapping's cost equals an exhaustive minimum over all lock-honouring candidate paths, on a 7-note window of `c_major_scale_pos1` with C3 locked at (6,8) (it maps exactly there) and on 300 seeded random sequences of 1–7 notes (with unplayable pitches, gaps either side of 500 ms, 0–2 random locks). Sanity check: forcing the Viterbi gap to 0 makes the random-sequence test fail. No `#[ignore]` remains.
- `UPDATE_ACCURACY` race: `gate_fails_on_clean_gate_f1_drop`, `gate_fails_naming_a_changed_hash_under_the_same_version` and `missing_committed_file_fails_without_update` read the committed files, which `accuracy_report` rewrites in parallel under `UPDATE_ACCURACY=1` (and which may be stale before it). They now return early, with a printed note, when `UPDATE_ACCURACY=1` (`skip_while_updating` in `tests/fixtures.rs`). The update run then passes 44/44.
- Stub-era test `map_frets_lowest_fret_and_unplayable` renamed `map_frets_whole_path_and_unplayable`: after open low E, E4 now maps to (3,9) (0.98) instead of open e (1.6, four skipped strings).

## Plan Change Log

### 2026-10-03 — position-12 row dropped and lock row corrected (user decision and plan fix)
- **Trigger:** two fixture rows could not pass.
  - "`e_minor_pentatonic_pos12` within frets 12–15" is unreachable under US-5.1's cost formula for any weights. The user settled the CAP-11 / US-5.1 conflict: position-specific scales may map low, phrases move with locks and re-fit, and the ≥ 80% gate stays (epic Notes Decision, 2026-10-03).
  - "A lock pulls at least one neighbour" was stricter than US-5.2, which says neighbours move only "when cheaper".
- **Amended:**
  - The position-12 row is removed.
  - The lock row now checks that the locked mapping is the brute-force minimum-cost path that honours the locks.
- **Known-bad state avoided:**
  - ignored tests left standing for unmeetable criteria;
  - weights retuned to force movement, which costs agreement.
- **KEEP:**
  - `fretmap.rs` as built: US-5.1 costs exactly, default `FretWeights` 0.3/1.0/0.4, tie tolerance, null bridging, locks applied as given.
  - The `lib.rs` delegation and the 0.2.0 bump with the regenerated files.
  - The passing fixture tests and the timing test.

## Review Triage Log

### 2026-10-03 — Review pass
- verdicts: 27 findings — high 0, medium 1, low 15, false 10, maybe-false 1
- findings:
  - `[medium]` `[patch]` verification-gap: the output-hash gate cannot see fret mapping (it only ever hashes `map_frets([])`) — each fixture's hash now includes map_frets on its ground-truth notes; files regenerated at 0.2.0.
  - `[low]` `[patch]` verification-gap: the 500 ms boundary is not pinned — assertions at exactly 500 ms and just above.
  - `[low]` `[reject]` edge: Lcg `% 0` on an empty truth list — every synth fixture has scorable notes; the agreement test now asserts `total > 0`.
  - `[low]` `[patch]` edge: `path_cost` with a mismatched path length — `assert_eq!` added.
  - `[low]` `[patch]` edge: three gate tests no-op and count as passed under UPDATE_ACCURACY — they now run on this run's produced text; the skip helper is removed.
  - `[low]` `[reject]` edge: argmin can keep a candidate up to eps worse — COST_EPS is 1e-9 against cost steps of 0.02 or more; no observable mapping effect.
  - `[low]` `[patch]` edge: metrics.rs comment cites the removed stub rule — reworded.
  - `[false]` `[reject]` blind: the plan's Auto Run Result is stale — the workflow rewrites it at finalize.
  - `[false]` `[reject]` blind: the review record is missing — this pass is that record.
  - `[maybe-false]` `[defer]` blind: TabCreator-User-Stories.md (US-5.1) and SPEC.md (CAP-11) still state the position-12 criterion the user dropped — the epic records the Decision; updating the sources is for the user or bmad-spec (if-true low documentation drift).
  - `[false]` `[reject]` blind: Cargo.lock and the attempt patch are not in the diff — the orchestrator excluded them; the lock is committed and the patch removed before commit.
  - `[low]` `[patch]` blind: skipping the gate tests hides the race — same fix as the edge row.
  - `[low]` `[patch]` blind: no fret-mapping regression guard beyond the 80% floor — grouped with the verification-gap hash row: any mapping change without a bump now fails the gate.
  - `[low]` `[patch]` blind: note order, timing and lock rules are unstated — documented in the `map_positions` doc (sorted notes assumed; locks applied as given; last duplicate wins).
  - `[low]` `[patch]` blind: the lib.rs doc says "None if unplayable" — corrected for locked notes.
  - `[low]` `[reject]` blind: the C-major lock row uses a 7-note window — brute force is 6^n; whole-sequence optimality is covered by the 300 random sequences and by Viterbi's structure.
  - `[low]` `[reject]` blind: the tie test misses middle-column back-pointers and the lower-string rule — argmin is shared by every column and is tested directly for both halves.
  - `[false]` `[reject]` blind: speed measured natively only — the browser timing gate is epic 7's (AD-17).
  - `[low]` `[patch]` blind: confusing NaN failure when no fixtures load — `total > 0` assert.
  - `[false]` `[reject]` intent: lock check is cost-optimality (A2), not an observed pull — the user's decision.
  - `[false]` `[reject]` intent: the position-12 check is gone — the user's decision.
  - `[false]` `[reject]` intent: regenerated files differ only in version — addressed by the hash patch above; they now include fret mapping.
  - `[false]` `[reject]` intent: no app-side test added — re-fit is the Tab epic's; engine.spec.ts still passes.
  - `[low]` `[reject]` intent: scope goes beyond fretmap.rs plus one line (harness changes, renamed test) — test and harness upkeep needed by the change; production code is fretmap.rs plus the delegation.
  - `[low]` `[reject]` intent: locks honoured off-candidate (C1) and per-column ties (D1) are choices the intent did not make — the plan's Always rules set both; documented now.
  - `[false]` `[reject]` intent: brute force reuses the module's own cost function — the formula has its own unit tests; brute force checks the search.
  - `[false]` `[reject]` intent: 2 000-note timing matches the intent's surface — no divergence.

## Design Notes

Each note has at most 6 candidates, so Viterbi is O(n·36). For a lock, its candidate list is just the locked position. A null note is skipped; the next mapped note's transition is from the previous mapped note, and the gap is measured from that note's `endMs`. If agreement falls short of 80%, retune `FretWeights` defaults and record the values and the per-fixture table in Implementation Notes. Changing the cost formula is a question for the user: stop and report rather than change it.

## Verification

**Commands:**
- `cd engine && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked` -- expected: all pass, including the regenerated accuracy self-check
- `npx -y pnpm@12.6.0 build:engine && npx -y pnpm@12.6.0 --filter app exec playwright test --project=chromium tests/e2e/engine.spec.ts` -- expected: 3 passed

## Auto Run Result

- **First run (2026-10-03):** blocked. "`e_minor_pentatonic_pos12` within frets 12–15" is unreachable under US-5.1's formula. The user settled the CAP-11 / US-5.1 conflict: position scales may map low, phrases move with locks and re-fit, and the ≥ 80% gate stays. The lock row was corrected to US-5.2's "when cheaper"; see the Plan Change Log.
- **Summary:**
  - `engine/src/fretmap.rs` maps notes to string/fret by Viterbi with US-5.1's exact costs: default `FretWeights` 0.3/1.0/0.4, shift terms halved across gaps over 500 ms, open strings as free hand moves.
    - Ties go to the lower fret, then the lower string.
    - Unplayable notes are null and bridged.
    - Locks are applied as given.
    - `path_cost` is exposed for the brute-force check.
  - `lib.rs` delegates to it.
  - Version is 0.2.0. Each fixture's output hash now also covers `map_frets` on its ground-truth notes, so a fret-mapping change without a version bump fails the gate.
  - The gate tests run against this run's produced files, so they no longer race `UPDATE_ACCURACY=1`.
- **Files changed:**
  - `engine/src/fretmap.rs` (new), `engine/src/lib.rs`.
  - `engine/tests/fretmap_fixtures.rs` (new), `engine/tests/fixtures.rs`, `engine/tests/accuracy/metrics.rs`.
  - `engine/Cargo.toml` and `Cargo.lock` (0.2.0).
  - `engine/tests/accuracy-baseline.json` and `engine/tests/fixture-outputs.json` (regenerated).
- **Review:** thorough, four lenses, 27 findings.
  - 13 rows patched, in 7 entries (patched entries by verdict: medium 1, low 6).
  - 1 deferred: updating the US-5.1 and CAP-11 source text to match the decision.
  - 13 rejected, each with its reason in the Review Triage Log above.
- **Follow-up review recommended:** false. One medium entry was patched: it extends the hash gate and only adds coverage.
- **Verification:**
  - fmt, clippy `-D warnings` and `cargo test --locked`: pass (49 lib + 44 harness + 7 fretmap fixtures + 5 oracle tests, 0 ignored).
  - Pooled ground-truth agreement: 520/590 = 88.1% (≥ 80%).
  - 2 000 notes map in about 0.5 ms natively.
  - `pnpm build:engine` and Playwright `engine.spec.ts`: 3 passed.
- **Residual risks:**
  - `e_minor_pentatonic_pos12` maps low (2/12), as the decision accepts.
  - The agreement margin over the 80% gate is 8.1 points.

