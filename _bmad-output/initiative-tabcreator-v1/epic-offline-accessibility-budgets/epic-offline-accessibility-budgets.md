---
type: epic
title: "Offline, accessibility and budgets"
parent: initiative-tabcreator-v1
covers: [CAP-20, CAP-21, CAP-22, CAP-23, CAP-25]
after: []
assignee: ""
risk: medium
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

PWA config and service worker, `ui/a11y/`, dark mode, the capability check, CI budgets, and the final CAP-25 sweep across screens. CAP-23: the analysis-speed, editor-latency and bundle gates (AD-17); the accuracy measures and gates belong to epic Detection engine. US-4.2's 1.2 s pYIN sub-budget is dropped; the 60 s analysis ≤ 2 s gate stands (decided at Detection engine inception, 2026-10-03).

## References

- spec — _bmad-output/specs/spec-tabcreator/SPEC.md, CAP-20, CAP-21, CAP-22, CAP-25
- architecture — _bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md, AD-12, AD-13, AD-17, AD-18, AD-19
- experience — _bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/EXPERIENCE.md, Accessibility Floor, State Patterns
- design — _bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/DESIGN.md
- stories — TabCreator-User-Stories.md, US-8.1–US-8.3

## Notes

- Waits on epic 6 because: needs every screen in place.
- Touch points from the Tab epic split (2026-10-04):
  - `ui/a11y/overlays.ts` is built by epic Tab editing (entry 3), inside this epic's `ui/a11y/` scope;
  - epic Tab editing's 500-note edit-to-paint measurement (entry 5) feeds this epic's AD-17 CI gate;
  - Recording retro A4 (failure-stop and storage-full notices on any screen, Esc from a text field) and A5's remaining test gaps join this epic's final CAP-25 sweep (user, 2026-10-04).
- Carried from epic Analysis and tab view at its close (user, 2026-10-04):
  - the page scrolls sideways at 320 px because the shell's top navigation bar is wider than that (the tab itself fits; story 5.8);
  - the Tab screen's state changes (analysis done, failed, take not found) are not announced and the progress bar has no aria-valuetext (story 5.6);
  - the polite announcement queue has no cap or expiry (Recording retro, story 3.3).
- Carried from story 8.4's review (2026-10-05): the Tab toolbar declares role="toolbar" but has no arrow-key navigation; every button is a Tab stop (now six or so).
