---
type: epic
title: "Platform baseline"
parent: initiative-tabcreator-v1
covers: []
after: []
assignee: ""
risk: medium
status: in-progress
---

# Platform baseline

## Description

The app shell, engine bridge, storage layer, test fixtures and deployment pipeline every later epic builds on. It carries no spec capability of its own; each requirement cites the spine or stories section it comes from.

## Outcome

Later epics start from a deployed, tested skeleton that already enforces the spine's layering, error, storage and styling rules.

## Requirements

This epic has no spec capabilities; each line cites its source.

- R1: App shell with hash routes `#/record`, `#/tab/:takeId`, `#/library`, `#/tuner`, `#/settings` and placeholder screens. (stories US-0.1)
- R2: The spine's directory layout, ESLint import rules, stylelint colour rule, `theme.css` tokens for light and dark, a `strings.ts` skeleton, and every shared type including `AppError` codes, `Prefs` and `TAKE_FIELD_OWNERS`. (spine AD-1, AD-10, AD-12, AD-14)
- R3: CI on every push and pull request — lint, Vitest, `cargo test`, clippy, wasm build, vite build, Playwright Chromium — with Node 24.21.0 pinned. (stories US-0.1; spine AD-17, Stack)
- R4: Engine crate and worker bridge: stub exports, take-scoped queue, map-frets priority, cancel by take, throttled progress, typed errors including init failure. (stories US-0.2; spine AD-7, AD-8, AD-10)
- R5: Storage layer: patch-write API with write fencing, change events, migrations and `versionchange` handling, OPFS raw writer, `prefs.ts`, audio-format table. (stories US-0.3; spine AD-2, AD-5, AD-11, AD-14, AD-16)
- R6: Deterministic test fixtures, including the 120 BPM, octave-leap, ringing, vibrato, bend, slide, count-in bleed, detuned and drop-D sets, and the dev-only fake mic. (stories US-0.4)
- R7: GitHub Pages deploy from `main` with relative base, CSP meta tag, no inlined assets and dev-only code stripped. (spine AD-13, AD-19)

## Done when

1. `pnpm dev` serves the app shell with all five routes; `pnpm build` produces a static `dist/` that the GitHub Actions pipeline deploys to GitHub Pages on `main`.
2. CI runs lint (including the AD-1 import rules and stylelint), Vitest, `cargo test`, clippy, the wasm build and Playwright Chromium on every push and pull request, and fails on any error.
3. The Settings screen of the deployed build shows the engine version from the wasm module, loaded through the worker bridge.
4. The storage layer round-trips a Take and Tab, rejects writes to a missing take, and emits typed change events (Vitest and Playwright).
5. `?fakeMic=open_strings` yields the fixture's audio in a dev build, and the production bundle contains no `fakeMic` string.

## Boundaries

Scaffold, CI, deployment, the engine bridge, the storage layer and test tooling only. No user-facing feature beyond placeholder screens and the engine version on Settings.

## References

- architecture — _bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md, sections Design Paradigm, AD-1, AD-2, AD-5, AD-8, AD-10, AD-11, AD-12, AD-13, AD-14, AD-16, AD-19, Structural Seed
- stories — TabCreator-User-Stories.md, sections Tech stack, Repository layout, Shared types, Engine contract, Worker protocol, Definition of Done, Epic 0

## Notes

- Decision: tracer bullet is entry 1; entries 2, 3 and 4 run in parallel after it (user approved, 2026-09-28).
- Decision: entry 1 creates every shared type and error code so entries 2 and 3 only read them; entry 2 is the only parallel entry that edits the CI workflow (2026-09-28).
- Decision: refactor sweep closes the epic (2026-09-28).
- Decision: accept that the engine and OPFS workers run with no CSP on GitHub Pages — the meta-tag CSP does not reach workers and Pages cannot send headers; resolves story 1.5's deferred item (user approved, 2026-10-02).
