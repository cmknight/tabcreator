- source_plan: `_bmad-output/initiative-tabcreator-v1/epic-platform-baseline/story-engine-crate-and-worker-bridge-plan.md`
  summary: Verify that a real Rust panic in the wasm engine surfaces in the worker as a catchable error and that the same instance keeps serving later requests (US-0.2 panic AC).
  evidence: Unverified (maybe-false, medium if true) — story 1.2 tests the panic path only with a JS throw in a fake engine; settle with a wasm-bindgen-test or an e2e that triggers a test-only panic export.
