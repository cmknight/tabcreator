---
type: epic
title: "Offline, accessibility and budgets"
parent: initiative-tabcreator-v1
covers: [CAP-20, CAP-21, CAP-22, CAP-25]
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

PWA config and service worker, `ui/a11y/`, dark mode, the capability check, CI budgets, and the final CAP-25 sweep across screens.

## References

- spec — _bmad-output/specs/spec-tabcreator/SPEC.md, CAP-20, CAP-21, CAP-22, CAP-25
- architecture — _bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md, AD-12, AD-13, AD-17, AD-18, AD-19
- experience — _bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/EXPERIENCE.md, Accessibility Floor, State Patterns
- design — _bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/DESIGN.md
- stories — TabCreator-User-Stories.md, US-8.1–US-8.3

## Notes

- Waits on epic 6 because: needs every screen in place.
