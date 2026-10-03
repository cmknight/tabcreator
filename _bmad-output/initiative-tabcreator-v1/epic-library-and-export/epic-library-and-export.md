---
type: epic
title: "Library and export"
parent: initiative-tabcreator-v1
covers: [CAP-17, CAP-18, CAP-19, CAP-25]
after: []
assignee: ""
risk: medium
---

# Library and export

## Description

Takes are kept in the browser, easy to find, rename and delete, and the tab gets out as copied text, a .txt file or a whole-library backup.

## Outcome

The player keeps their work and can take it anywhere.

## Done when

1. On the deployed build, new takes appear in the Library without reload, and search narrows 500 takes in ≤ 50 ms per keystroke.
2. Copied tab equals the downloaded .txt, and columns align in a monospace editor.
3. Backup then restore into a fresh profile reproduces every take, tab and audio file byte-for-byte; restoring twice creates no duplicates.
4. Delete audio only frees storage and keeps the tab; delete take leaves nothing behind.

## Boundaries

`session/library-session.ts`, `storage/backup.ts`, `ui/platform.ts`, the Library screen, and Copy/Download on the Tab screen. CAP-25: Library states.

## References

- spec — _bmad-output/specs/spec-tabcreator/SPEC.md, CAP-17, CAP-18, CAP-19
- architecture — _bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md, AD-5, AD-11, AD-14, AD-16
- experience — _bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/EXPERIENCE.md, Library row, Library states
- design — _bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/mockups/library.html
- stories — TabCreator-User-Stories.md, US-7.1–US-7.3

## Notes

- Waits on epic 5 because: needs tab layout and toText, the Tab screen.
- Touch point from epic 3 (Recording): compressed audio can be WAV (audio/wav, .wav) when recovery encoding fails. Backup and restore must accept it (2026-10-02).
