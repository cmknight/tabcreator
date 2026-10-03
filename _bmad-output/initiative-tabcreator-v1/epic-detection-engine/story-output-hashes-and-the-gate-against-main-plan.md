---
title: 'Output hashes and the gate against main'
type: 'feature'
ticket: '2'
created: '2026-10-03'
status: 'built'
baseline_revision: 'cbfd678a668de275a0babbdd5fbf16d3c4de0822'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-detection-engine/epic-detection-engine.md'
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-detection-engine/story-accuracy-harness-and-report-tracer-plan.md'
warnings: []
deferred:
  - summary: >-
      The CI comparison-commit selection (pull request, main push, other push) has not run on GitHub yet.
    evidence: |-
      Unverified: checked only by running the extracted shell locally. Settled by the first pull request, and by the second push to main after this lands (the first compares with a commit that has no files).
    location: >-
      .github/workflows/ci.yml, Accuracy report step
    severity: medium (unverified)
  - summary: >-
      Committed baseline files would differ between machines if testdata/real were present on only some of them.
    evidence: |-
      Unverified: settled when human takes are added; committing them to git, as the spec's testdata/real implies, keeps CI and dev identical.
    location: >-
      engine/tests/fixtures.rs, real-fixture discovery
    severity: medium (unverified)
  - summary: >-
      A schema change to the baseline JSON would make main's older copy fail to parse, failing every PR until it merges.
    evidence: |-
      Unverified: settled when the schema first changes; add serde defaults or a parse-failure skip with a warning then.
    location: >-
      engine/tests/fixtures.rs, read_env_json
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** Nothing stops engine output from changing without an `engine_version()` bump (AD-7), and nothing stops accuracy from quietly regressing against `main` (CAP-23, US-8.4).

**Approach:** The story 4.1 harness gains two committed files, each checked against what the build produces. CI hands the harness `main`'s copies, so the harness fails on a drop of more than 1 point, or on changed output under an unchanged version. It also writes the change against `main` into the report.

## Boundaries & Constraints

**Always:**
- **Committed files:**
  - `engine/tests/accuracy-baseline.json` holds `engine_version`, the pooled `PooledRow` numbers for each set (counts, f1, octave_rate, fret_agreement) and each fixture's counts. It never holds timings.
  - `engine/tests/fixture-outputs.json` holds `engine_version`, plus for each fixture an FNV-1a 64-bit hex hash of `analyze JSON + "\n" + map_frets JSON`. The hash is written in test code, with no new crate.
  - Both are written with stable key order and pretty-printed with a trailing newline.
- **Self-check:**
  - `accuracy_report` fails, naming the file and its first difference, when the produced content differs from the committed file.
  - With `UPDATE_ACCURACY=1` it rewrites both files instead, and passes.
  - A missing file is a failure unless `UPDATE_ACCURACY=1` is set.
- **Gate against main:** active only when env `ACCURACY_MAIN_BASELINE` and/or `ACCURACY_MAIN_OUTPUTS` point to main's copies; a variable that is unset skips its check.
  - **Metric drop:** fail when a pooled metric of the clean-gate, noisy-gate, reported or real set falls more than 1.0 percentage point against main. For F1 and fret agreement that means a decrease; for octave rate, an increase. A metric that is `n/a` on main is skipped. A metric that has a value on main and is `n/a` now counts as a drop.
  - **Not gated:** per-fixture metrics and phantom counts are reported only (epic decision: pooled F1).
  - **Hash change:** fail when any fixture present in both files has a different hash while `engine_version` is equal. The failure lists each such fixture. Fixtures added or removed are ignored.
- **Report:**
  - The pooled table gains a "Δ vs main" cell per metric (in points).
  - Per-fixture tables gain a "ΔF1 vs main" column.
  - Without a main baseline, each says `n/a (no main baseline)`, once in the header.
- **Determinism:** a test runs `analyze_core` twice on one fixture and on `silence_60s`, and asserts byte-identical JSON.
- **CI:** in the Accuracy report step, before `cargo test`, pick the comparison commit:
  - `pull_request`: `origin/${{ github.base_ref }}`;
  - push to `main`: `${{ github.event.before }}`, skipped when it is all zeros;
  - any other push: `origin/main`.
  - Fetch that commit with `git fetch --no-tags --depth=1`, ignoring failure.
  - `git show <commit>:engine/tests/<file>` each file into `$RUNNER_TEMP`, and export its variable only when the show succeeds.

**Never:**
- No new crates.
- Don't change `engine/src/` or the fixtures.
- No gate on thresholds; that is entry 9.
- Don't bump `engine_version()`; the stub's output is unchanged.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| No main copies | env vars unset (first run) | Passes; report says no main baseline | — |
| Same as main | main files equal produced | Passes; Δ 0.0 | — |
| F1 drop 1.5 pt | main clean-gate f1 higher by 0.015 | Fails naming set and metric | — |
| Drop of exactly 1.0 pt | | Passes | — |
| Octave rate +1.5 pt | | Fails | — |
| Hash differs, same version | fixture X hash changed | Fails naming X | — |
| Hash differs, version bumped | | Passes | — |
| Committed file stale | produced ≠ committed | Fails naming file | `UPDATE_ACCURACY=1` rewrites |

</intent-contract>

## Code Map

- `engine/tests/fixtures.rs` -- `accuracy_report()` (~line 119) builds `rows`, runs the inventory checks and calls `render(&info, &rows)` (~183). Add the committed-file check/update, the main comparison and the determinism test here or in a new `accuracy/baseline.rs`.
- `engine/tests/accuracy/report.rs` -- `FixtureRow` (77), `PooledRow` (93, already `Serialize`), `pool()`, `RunInfo` (188), `render()` (198). Extend `RunInfo` with optional main data so `render` adds the delta cells. Keep the existing `render_shows_every_set` assertions passing.
- `engine/tests/accuracy/metrics.rs` -- `Counts` (Serialize) with `f1()`, `octave_rate()`, `fret_agreement()`. Reuse it; don't change it.
- `.github/workflows/ci.yml` -- the "Accuracy report" step (~line 76), `working-directory: engine`. Checkout is `actions/checkout@v7` with the default depth 1.
- `engine/Cargo.toml` -- has serde and serde_json. `env!("CARGO_PKG_VERSION")` is `engine_version()`.

## Tasks & Acceptance

**Execution:**
- [x] `engine/tests/accuracy/baseline.rs` (new, with `mod.rs` export) -- baseline/outputs types (Serialize + Deserialize), FNV-1a hash, `compare(main, current) -> Vec<String>` failures for metrics and hashes, and delta helpers -- the pure gate logic.
- [x] the same module -- unit tests covering every matrix row through `compare` and the delta rendering.
- [x] `engine/tests/fixtures.rs` -- collect each fixture's hash in `run_fixture`, add the committed-file check and the `UPDATE_ACCURACY` rewrite, read the `ACCURACY_MAIN_*` env files, fail with all gate failures joined after writing the report, and add the determinism test -- harness wiring.
- [x] `engine/tests/accuracy/report.rs` -- the "Δ vs main" cells and the "ΔF1 vs main" column -- the change against main (US-8.4).
- [x] `engine/tests/accuracy-baseline.json`, `engine/tests/fixture-outputs.json` -- generate with `UPDATE_ACCURACY=1 cargo test --test fixtures` and commit them.
- [x] `.github/workflows/ci.yml` -- the comparison-commit selection, fetch and env export in the Accuracy report step.

**Acceptance Criteria:**
- Given the committed files match the build, when `cargo test --locked` runs with no `ACCURACY_MAIN_*` variables set, then it passes and the report states there is no main baseline.
- Given `ACCURACY_MAIN_OUTPUTS` points to a copy of `fixture-outputs.json` with one hash edited, when the release harness runs, then it fails naming that fixture. With that copy's `engine_version` also edited, it passes.
- Given `ACCURACY_MAIN_BASELINE` points to a copy whose clean-gate f1 is 0.02 higher, when the harness runs, then it fails naming clean-gate F1, and the report shows the −2.0 point change.

## Implementation Notes

- `Counts` stays serialise-only (not changed); `baseline.rs` stores counts as a field-for-field `StoredCounts` with `From` both ways. `Set` gained `Deserialize`.
- Baseline `sets` and `fixtures`, and the outputs `fixtures`, are `BTreeMap`s (stable key order); set keys are `clean-gate`, `noisy-gate`, `reported`, `phantom-only` and `real`, and a set with no fixtures is left out. A gated set present on main but missing now counts as a drop on each metric main had.
- Report without a main baseline: the pooled table has one column headed `Δ vs main: n/a (no main baseline)` and each scored per-fixture table one headed `ΔF1 vs main: n/a (no main baseline)`, with empty cells. With one: pooled gains `ΔF1 / ΔOctave / ΔFret vs main` columns; per-fixture rows and the pooled row gain `ΔF1 vs main`. Deltas print as `+1.5`, `−2.0` (U+2212), `0.0` or `n/a`. The phantom-only table has no F1, so no delta column.
- A set `ACCURACY_MAIN_*` variable whose file cannot be read or parsed panics naming the variable and path (before the report is written).
- CI: the pull_request fetch uses an explicit refspec into `refs/remotes/origin/<base>` so `origin/<base>` resolves after a depth-1 checkout; `git show` errors go to /dev/null.

## Plan Change Log

## Review Triage Log

### 2026-10-03 — Review pass
- verdicts: 25 findings — high 0, medium 5, low 10, false 6, maybe-false 4
- findings:
  - `[maybe-false]` `[defer]` blind: `testdata/real` present on one machine only makes the committed files machine-dependent — settled by where real takes live; if committed to git as the spec intends, CI and dev see the same set (if-true medium).
  - `[false]` `[reject]` blind: the generated JSON files are not in the diff — the orchestrator excluded generated data from the review diff; both files exist and the harness's self-check passes against them in `cargo test`.
  - `[medium]` `[patch]` blind: CI cannot tell a failed fetch from "main lacks the file", so the gate can switch off silently — the step now fails on an unresolvable comparison commit and prints a notice when main has no copy.
  - `[low]` `[reject]` blind: branch pushes compare with main's moving tip, not the merge-base — this project commits to main directly; PRs use the merge checkout; the fix needs deeper history.
  - `[low]` `[patch]` blind: the failure message rounds the change to 0.1 points — it now prints 2 decimals.
  - `[low]` `[patch]` blind: determinism test does not repeat map_frets, and debug and release must hash alike — map_frets is now run twice; Rust has no fast-math, so profiles agree (both runs check the same committed file).
  - `[medium]` `[patch]` blind: check_committed and the env readers are untested; an empty env var panics unclearly — grouped with the verification-gap gate-wiring row; empty value now means unset.
  - `[maybe-false]` `[defer]` blind: the CI selection branches are untested — settled by the first real pull request and main-push runs after this lands (if-true medium).
  - `[low]` `[reject]` blind: UPDATE_ACCURACY accepts only `1`, and a rewrite can run while a regression is reported — the failure text names `UPDATE_ACCURACY=1`; the main gate only runs in CI, where nothing rewrites.
  - `[low]` `[reject]` blind: plan frontmatter and logs stale — fix edits this build's plan; status and logs are maintained by the workflow.
  - `[medium]` `[patch]` verification-gap: the gate wiring in `accuracy_report` is never run end to end — extracted into a function with tests for a clean-gate F1 drop, an edited hash and a missing committed file.
  - `[low]` `[patch]` verification-gap: the per-fixture pooled ΔF1 cell is unasserted — assertion added.
  - `[medium]` `[patch]` verification-gap (other): failed fetch treated as an absent file — same group as the blind CI row.
  - `[false]` `[reject]` verification-gap (other): every hash is equal under the stub — expected with constant stub output; a stub change still changes every hash and trips the gate.
  - `[maybe-false]` `[defer]` intent: the verify scenarios live on CI runs, the tests are local and synthetic — same deferral as the CI-selection row; settled by real runs.
  - `[false]` `[reject]` intent: an unregenerated stale file fails the debug step naming the file, not the fixture — the first differing line is that fixture's hash line, so CI fails naming it.
  - `[false]` `[reject]` intent: a lowered metric is only reachable through main's copy — the committed baseline must equal the build, so a real drop comes from an engine change; tests model it through main's copy, as the plan states.
  - `[false]` `[reject]` intent: pooled-only gating against "any accuracy metric" — settled by the epic decision (pooled F1, per-fixture rows reported).
  - `[medium]` `[patch]` intent: no baseline vs failed fetch — same group as the blind CI row.
  - `[false]` `[reject]` intent: local `cargo test` never gates against main — by design: CI supplies main's copies.
  - `[low]` `[reject]` intent: determinism is trivial under the stub — true until detection lands; nothing to fix now.
  - `[low]` `[patch]` edge: a real take with a synth fixture's stem overwrites its entry — uniqueness asserted.
  - `[maybe-false]` `[defer]` edge: a schema change makes main's older JSON fail to parse, so every PR fails — settled when the schema first changes; serde defaults or a skip-with-warning would be needed then (if-true medium).
  - `[low]` `[patch]` edge: failure message rounding — same group as the blind rounding row.
  - `[low]` `[patch]` edge: a CRLF checkout fails the byte-exact self-check — `.gitattributes` pins `engine/tests/*.json` to LF.

## Design Notes

The report is written before the gate fails, so CI still publishes it. A metric "point" is 0.01 on the 0–1 scale; compare with a 1e-9 tolerance so exactly 1.0 passes.

## Verification

**Commands:**
- `cd engine && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked` -- expected: all pass
- `cd engine && ACCURACY_MAIN_OUTPUTS=<edited copy> cargo test --release --locked --test fixtures` -- expected: fails naming the edited fixture
- `cd engine && ACCURACY_MAIN_BASELINE=<copy with clean-gate f1 +0.02> cargo test --release --locked --test fixtures` -- expected: fails naming clean-gate F1
- `cd engine && ACCURACY_MAIN_BASELINE=tests/accuracy-baseline.json ACCURACY_MAIN_OUTPUTS=tests/fixture-outputs.json cargo test --release --locked --test fixtures` -- expected: passes, Δ 0.0

## Auto Run Result

- **Summary:** The harness now keeps two committed files, checked byte-for-byte against the build:
  - `engine/tests/accuracy-baseline.json`: pooled and per-fixture metrics, with `engine_version`.
  - `engine/tests/fixture-outputs.json`: an FNV-1a hash per fixture of its analyze and map_frets output.

  `UPDATE_ACCURACY=1` rewrites both files. CI's Accuracy report step resolves a comparison commit, failing hard when it can't. It hands main's copies to the harness, which fails when a pooled metric is more than 1.0 point worse, or when an output hash changed without a version bump. The report shows the change against main in each pooled metric cell and in a per-fixture ΔF1 column.
- **Files changed:**
  - `engine/tests/accuracy/baseline.rs`: gate logic and its tests.
  - `engine/tests/accuracy/report.rs`: delta cells.
  - `engine/tests/accuracy/mod.rs`: exports the new module.
  - `engine/tests/fixtures.rs`: `run_all`, `gate_failures`, committed-file check, duplicate-name guard, determinism and gate tests.
  - `engine/tests/accuracy-baseline.json` and `engine/tests/fixture-outputs.json`: generated.
  - `.github/workflows/ci.yml`: selects and resolves the comparison commit, then exports main's copies.
  - `.gitattributes`: LF for the committed JSON.
- **Review:** thorough, four lenses, 25 findings.
  - 12 rows patched, in 8 entries (patched entries by verdict: medium 2, low 6).
  - 4 rows deferred as 3 items (CI selection unverified until real runs; machine-local `testdata/real`; a schema change in main's copy).
  - 9 rejected, each with its reason in the Review Triage Log above.
- **Follow-up review recommended:** true, because two medium entries were patched without a second review:
  - the CI step now fails on an unresolvable comparison commit, where it used to skip silently;
  - the gate wiring was extracted into `gate_failures`, with its new tests.
- **Verification:**
  - `cargo fmt --check`, clippy `-D warnings` and `cargo test --locked`: pass (9 lib tests + 44 fixtures-target tests).
  - Release harness with main's outputs carrying an edited vibrato hash: fails naming vibrato.
  - With main's clean-gate F1 at 0.02: fails with "clean-gate F1 … (-2.00 points)".
  - With the committed files as main's copies: passes.
  - Prettier: clean.
- **Residual risks:**
  - A force-push to main, or a network failure during the fetch, now fails the Accuracy report step.
  - Every fixture hash is identical under the stub until detection lands.
  - The gate only compares once main holds these files, which starts with the second push after this lands.
