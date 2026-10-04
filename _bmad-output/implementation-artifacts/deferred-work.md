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
  status: settled 2026-10-03 (story 4.8) — legato_slurs scores 17/17 with 0 octave errors at engine 0.4.0; no fixture change needed.
- source_plan: `_bmad-output/initiative-tabcreator-v1/epic-platform-baseline/story-refactor-sweep-plan.md`
  summary: A failing GitHub API call in the deploy job's head-of-main check fails the deploy instead of skipping it — owner US-8.1.
  evidence: .github/workflows/ci.yml deploy job runs gh api repos/{repo}/commits/main without a fallback.
- source_plan: `_bmad-output/initiative-tabcreator-v1/epic-detection-engine/story-unnotated-techniques-and-the-accuracy-gates-plan.md`
  summary: The app's `lowConfidence` (US-4.4: confidence < c + 0.15) must use the engine's retuned c = 0.55 − 0.4·s (engine 0.5.0), not US-4.6's c = 0.7 − 0.4·s — owner US-4.5 (epic Tab view and editor).
  evidence: Story 4.9 retuned Params::from_settings; app/src/model/types.ts carries lowConfidence with nothing tying it to the engine's c. Better still, have the engine emit the flag or c.
- source_plan: `_bmad-output/initiative-tabcreator-v1/epic-detection-engine/story-unnotated-techniques-and-the-accuracy-gates-plan.md`
  summary: TabCreator-User-Stories.md US-4.6 (k, c formulas) and US-5.1 (FretWeights defaults) state the pre-tuning values — owner: product owner (spec text).
  evidence: Engine 0.5.0 uses k = 4.5 − 1.0·s, c = 0.55 − 0.4·s, FretWeights 0.15/1.0/0.3 (epic Notes Decision, 2026-10-03).
