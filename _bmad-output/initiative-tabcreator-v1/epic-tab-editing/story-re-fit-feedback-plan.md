---
title: 'Re-fit feedback'
type: 'feature'
ticket: '2'
created: '2026-10-05'
status: 'draft'
route: 'full'
route_source: 'auto'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/DESIGN.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** After an edit, the phrase re-fit (8.1, 8.3) can silently move nearby unlocked notes to other strings or frets, and the player has no cue that this happened.

**Approach:**
- Each edit command reports which other notes its re-fit moved.
- The Tab screen outlines those notes with the dashed violet re-fit outline for 1.5 s and announces "<n> nearby notes re-fingered" after the edit's own announcement.

The edit announcements ("Moved to G string, fret 7", etc.) and the selection after undo/redo already exist (8.1, 8.3). Keep them and cover them in this story's e2e.

## Boundaries & Constraints

**Always:**
- **What counts as re-fingered:** after a command (set fret, move string, delete, insert, confirm) is applied, any note that existed before and after, other than the command's target, whose `string` or `fret` differs.
  - The session's `edit` edit event carries `refingered: string[]` (note ids, maybe empty).
  - A delete, whose target no longer exists, still reports its neighbours.
  - Undo and redo report nothing and outline nothing: they are restorations, not re-fits.
- **Outline:** each re-fingered note's button gets `tab-note-refit` (`2px dashed var(--color-refit)`) for 1.5 s, then fades out. Under `prefers-reduced-motion: reduce` it disappears at 1.5 s without fading.
  - It is visibly distinct from the selection outline (solid blue). A note that is both selected and re-fingered shows both, with neither hiding the other.
  - A new command's re-fit replaces the current outline set and restarts the timer.
  - Undo, redo, leaving the screen or the take going missing clears it.
- **Announcement:** when `refingered.length > 0`, the Tab screen announces `tab.refingered(n)` politely, after the edit announcement: "<n> nearby notes re-fingered" (EXPERIENCE verbatim), and "1 nearby note re-fingered" for one. Zero: nothing.
- **Note labels:** a re-fingered note's accessible label is unchanged; the live region carries the news.

**Never:**
- No change to which notes the re-fit moves (8.1's re-fit rules).
- No outline after undo, redo, analysis or reload.
- No colour-only cue: the dashed shape is the cue.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Re-fit moves 2 | an edit whose re-fit changes 2 neighbours | both outlined 1.5 s; "2 nearby notes re-fingered" after the edit announcement | — |
| One moved | 1 neighbour changed | "1 nearby note re-fingered" | — |
| None moved | the re-fit leaves the neighbours | no outline, no re-fit announcement | — |
| Target excluded | the edited note itself changed | not outlined, not counted | — |
| Delete | the neighbours re-fitted after a delete | the moved neighbours outlined and counted | — |
| Back to back | a second edit within 1.5 s | the outline set is replaced; timer restarts | — |
| Undo / redo | Ctrl+Z after an edit | no outline; the outline cleared; the selection on the step's note | — |
| Reduced motion | `prefers-reduced-motion: reduce` | the outline vanishes at 1.5 s, no transition | — |
| Selected + re-fit | a re-fingered note is also selected | both outlines visible | — |

</intent-contract>

## Code Map

- `app/src/session/take-session.ts`: `EditEvent` :100-101 (the `edit` variant: add `refingered`); `runCommand` (the `emitEdit({kind:'edit', …})` call :738; it has `tab` (before) and `next` (after) in hand, so compute the moved ids there by id). `onEditEvent` :900.
- `app/src/model/edit-history.ts`: `TabState` and the commands. Put a pure helper `refingered(before: Note[], after: Note[], targetId): string[]` here or in `model/notes.ts`, with unit tests.
- `app/src/ui/screens/Tab.tsx`: the edit-event effect (`editAnnouncement`, `announce`). Hold the outlined id set and its timer here, pass it to TabArea, and clear it on undo/redo, unmount and missing.
- `app/src/ui/components/TabArea.tsx`: the note button `className` :311-312 (`styles.note`, `styles.check` from `flagged`); add `styles.refit` from a new `refitIds: ReadonlySet<string>` prop. `TabArea.module.css`: the existing selected outline and `aria-pressed` styling, and the check style.
- `app/src/ui/theme.css:22, :68, :92`: `--color-refit` (light and dark). `LevelMeter.module.css:54`: the `prefers-reduced-motion` pattern.
- `app/src/ui/strings.ts`: `tab.editFret` and friends (add `tab.refingered`). `app/src/ui/a11y/announcer.ts`.
- Tests:
  - `app/tests/unit/take-session.test.ts` (8.1/8.3 command tests, `harness`, fake mapper);
  - `app/tests/unit/tab-screen.test.tsx` (edit-event announcement tests; fake timers);
  - `app/tests/e2e/tab-edit.dev.spec.ts` (`recordAndAnalyse` on `c_major_scale_pos1`, `storedTab`, `noteButton`; popover position buttons).

## Tasks & Acceptance

**Execution:**
- [ ] `app/src/model/…` -- the `refingered` helper with unit tests -- one rule.
- [ ] `app/src/session/take-session.ts` -- `refingered` on `edit` events (delete included) -- data for the screen.
- [ ] `app/src/ui/screens/Tab.tsx`, `TabArea.tsx` + CSS, `strings.ts` -- the outline set, timer, clearing, reduced motion, and the announcement after the edit's -- the feedback.
- [ ] Unit tests for every I/O matrix row at the lowest surface that shows it (helper, session, tab-screen with fake timers and a mocked `matchMedia` for reduced motion).
- [ ] `app/tests/e2e/tab-edit.dev.spec.ts` -- the AC below.

**Acceptance Criteria:**
- Given a `c_major_scale_pos1` take on the Tab screen, when the player moves its note on the A string, fret 3 to the low E string, fret 8 (the popover's position button), then:
  - the live region gives the move announcement (`tab.editMove` for string 6, fret 8) and then "<n> nearby notes re-fingered", with n equal to the number of other notes whose stored string or fret changed;
  - exactly those notes carry the re-fit outline, and it is gone about 1.5 s later.
- Given that edit, when the player presses Ctrl+Z, then the stored Tab equals the one before the edit, no note carries the re-fit outline, and the edited note is selected.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

- **Outline styling:** use `outline: 2px dashed var(--color-refit)` for the re-fit, with an `outline-offset` that differs from the selected style. If the selected style also uses `outline`, put one of the two in a `box-shadow` or a pseudo-element, so both can show at once.
- **Fade:** a `transition: outline-color` (or opacity on a pseudo-element) of about 300 ms after the 1.5 s hold. Under reduced motion, use `transition: none`.
- **Fallback for the AC:** if the real engine re-fingers no neighbour for this move on the recorded take, the e2e can't show the outline. In that case, record the fact in Implementation Notes and assert the outline with a seeded tab whose re-fit is known to move a neighbour, keeping the announcement and undo checks on c_major.

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass.
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test --project=dev tests/e2e/tab-edit.dev.spec.ts tests/e2e/tab-screen.dev.spec.ts` -- expected: pass.
