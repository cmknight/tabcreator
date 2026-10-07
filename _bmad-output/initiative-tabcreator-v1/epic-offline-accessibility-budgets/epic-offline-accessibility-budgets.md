---
type: epic
title: "Offline, accessibility and budgets"
parent: initiative-tabcreator-v1
covers: [CAP-19, CAP-20, CAP-21, CAP-22, CAP-23, CAP-25]
after: []
assignee: ""
risk: medium
status: in-progress
---

# Offline, accessibility and budgets

## Description

The app installs and works offline, meets WCAG 2.2 AA in both themes, enforces its performance and bundle budgets, and tells unsupported browsers so.

## Outcome

The finished app works for everyone, anywhere, at the speed the spec promises.

## Done when

1. After one online visit, the deployed build with the network off completes record → analyse → edit → export.
2. axe reports no serious or critical violations on every screen in both themes; the core flow completes keyboard-only.
3. CI fails when a budget is exceeded: initial JS > 200 KB gz, wasm > 1 MB gz, 60 s analysis > 2 s, edit p95 > 100 ms.
4. Every CAP-25 state in EXPERIENCE.md is reachable in a test; the unsupported screen appears when a required API is missing.

## Boundaries

PWA config and service worker, `ui/a11y/`, the storage-full status and restore correctness carried from epic Library and export (retro B1–B3: `storage/persistence.ts`, `storage/restore.ts`, `storage/backup*.ts`, `session/library-session.ts`, `ui/platform.ts`), dark mode, the capability check, CI budgets, and the final CAP-25 sweep across screens. CAP-23: the analysis-speed, editor-latency and bundle gates (AD-17); the accuracy measures and gates belong to epic Detection engine. US-4.2's 1.2 s pYIN sub-budget is dropped; the 60 s analysis ≤ 2 s gate stands (decided at Detection engine inception, 2026-10-03).

## References

- spec — _bmad-output/specs/spec-tabcreator/SPEC.md, CAP-19, CAP-20, CAP-21, CAP-22, CAP-23, CAP-25
- architecture — _bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md, AD-5, AD-6, AD-11, AD-12, AD-13, AD-14, AD-15, AD-16, AD-17, AD-18, AD-19
- experience — _bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/EXPERIENCE.md, Accessibility Floor, State Patterns
- design — _bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/DESIGN.md
- stories — TabCreator-User-Stories.md, US-8.1–US-8.3

## Notes

- Waits on epic 6 because: needs every screen in place.
- Decision: the Library and export retrospective's actions B1 (storage-full status: clear when space is freed, one source for Record and the Library, the Library banner through the announcer) and B2 (restore correctness) are entries 1–2, in that order, ahead of every other story here (user decision, 2026-10-06). For B2 the user decided: a take whose audio is missing from the backup is restored as "Audio deleted" (`audioMime: null`); restore reads the zip in pieces (streaming unzip) rather than capping backup size; restore never adds audio to a take already in the library. See `epic-library-and-export/epic-library-and-export-retrospective.md` for scope and source findings.
- Touch points from the Tab epic split (2026-10-04):
  - `ui/a11y/overlays.ts` is built by epic Tab editing (entry 3), inside this epic's `ui/a11y/` scope;
  - epic Tab editing's 500-note edit-to-paint measurement (entry 5) feeds this epic's AD-17 CI gate;
  - Recording retro A4 (failure-stop and storage-full notices on any screen, Esc from a text field) and A5's remaining test gaps join this epic's final CAP-25 sweep (user, 2026-10-04).
- Carried from epic Analysis and tab view at its close (user, 2026-10-04):
  - the page scrolls sideways at 320 px because the shell's top navigation bar is wider than that (the tab itself fits; story 5.8);
  - the Tab screen's state changes (analysis done, failed, take not found) are not announced and the progress bar has no aria-valuetext (story 5.6);
  - the polite announcement queue has no cap or expiry (Recording retro, story 3.3).
- Carried from story 8.4's review (2026-10-05): the Tab toolbar declares role="toolbar" but has no arrow-key navigation; every button is a Tab stop (now six or so).
- Decision: inception (user approved, 2026-10-07). Build order as in tickets.toml: B1 (1), restore validation (2), streaming restore (16) and Library robustness/B3 (17) open the epic; the tracer is entry 3 (installable offline app, record → analyse → edit → export with the network off); the budgets lane 7 → 8 → 9 and the accessibility lane 6 → 10 → 11 meet at the axe sweep (12); the CAP-25 sweep (13), the hitl screen-reader check (14) and the refactor sweep (15) close it. Built unattended with no plan or done checkpoints; the loop stops at the hitl entry 14.
- Decision (user, 2026-10-07): the CAP-25 checklist is EXPERIENCE.md's State Patterns plus SPEC's "player left during analysis".
- Decision (user, 2026-10-07): the 60 s analysis gate runs the wasm engine in Chromium on the production build, one warm-up then the median of 5, scaled by a calibration factor (1.0 until the owner measures it in entry 14); cold start and 5-minute peak memory are reported, not gated.
- Decision (user, 2026-10-07): the latency gates (edit p95, search, 60 s analysis) run on the production build, seeded through a fixture backup restored by the real Restore path.
- Decision (user, 2026-10-07): the app reflows at 320 px (WCAG 1.4.10) despite EXPERIENCE's desktop-only line.
- Decision (user, 2026-10-07): the capability check requires every API the app uses (AudioWorklet, OPFS, WebAssembly, Web Locks, BroadcastChannel, MediaRecorder, IndexedDB, module Workers), run in main.tsx before the instance lock.
- Decision (user, 2026-10-07): "initial JS" is the gzip size of the entry chunk plus its static imports; CSS, workers, worklets and lazy chunks are excluded.
- Decision (user, 2026-10-07): the manual NVDA/VoiceOver check is hitl entry 14, which also carries the Ctrl/⌘+Shift+C check, the standalone-window check and the benchmark calibration.
- Decision (user, 2026-10-07): Library retro B3 is entry 17, right after the restore stories; the builder generates the PWA icons (a token-coloured glyph, replaceable later).
- Decision (2026-10-07, inception): focus moves to each screen's h1 on route change (entry 10) as standard accessibility practice; no spec line requires it.
- Recording retro A5's "WAV fallback in a real browser" was done by epic Tab view entry 12 and is not repeated here.
