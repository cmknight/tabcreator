- source_plan: `_bmad-output/initiative-tabcreator-v1/epic-platform-baseline/story-engine-crate-and-worker-bridge-plan.md`
  summary: Verify that a real Rust panic in the wasm engine surfaces in the worker as a catchable error and that the same instance keeps serving later requests (US-0.2 panic AC).
  evidence: Unverified (maybe-false, medium if true) — story 1.2 tests the panic path only with a JS throw in a fake engine; settle with a wasm-bindgen-test or an e2e that triggers a test-only panic export.
- source_plan: `_bmad-output/initiative-tabcreator-v1/epic-platform-baseline/story-refactor-sweep-plan.md`
  summary: A raw file locked by an open writer survives deleteTake until the start-up orphan scan — owner US-3.2.
  evidence: deleteTake removes OPFS files best-effort (spine AD-15); removeEntry fails on a file held by a sync access handle and the error is swallowed.
- source_plan: `_bmad-output/initiative-tabcreator-v1/epic-platform-baseline/story-refactor-sweep-plan.md`
  summary: Reopening a raw writer for an existing take id appends after the existing samples — owner US-3.2 (recovery defines reopen semantics).
  evidence: opfs-worker open() uses getFileHandle({create:true}) and appends at getSize(); no truncate on reopen.
- source_plan: `_bmad-output/initiative-tabcreator-v1/epic-platform-baseline/story-refactor-sweep-plan.md`
  summary: Two pull-offs in the legato_slurs fixture have a 2nd harmonic about as loud as the fundamental — owner US-8.4 (accuracy benchmark decides fixture fitness).
  evidence: Measured by the story 1.4 implementer; may affect Epic 4 octave-error targets.
- source_plan: `_bmad-output/initiative-tabcreator-v1/epic-platform-baseline/story-refactor-sweep-plan.md`
  summary: A failing GitHub API call in the deploy job's head-of-main check fails the deploy instead of skipping it — owner US-8.1.
  evidence: .github/workflows/ci.yml deploy job runs gh api repos/{repo}/commits/main without a fallback.
