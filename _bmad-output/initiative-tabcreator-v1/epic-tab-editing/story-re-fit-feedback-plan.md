---
title: 'Re-fit feedback'
type: 'feature'
ticket: '2'
created: '2026-10-05'
status: 'built'
baseline_revision: 'd1f27fbc207216a2c6ccd437e209f8ca76aeedbe'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
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
- [x] `app/src/model/…` -- the `refingered` helper with unit tests -- one rule.
- [x] `app/src/session/take-session.ts` -- `refingered` on `edit` events (delete included) -- data for the screen.
- [x] `app/src/ui/screens/Tab.tsx`, `TabArea.tsx` + CSS, `strings.ts` -- the outline set, timer, clearing, reduced motion, and the announcement after the edit's -- the feedback.
- [x] Unit tests for every I/O matrix row at the lowest surface that shows it (helper, session, tab-screen with fake timers and a mocked `matchMedia` for reduced motion).
- [x] `app/tests/e2e/tab-edit.dev.spec.ts` -- the AC below.

**Acceptance Criteria:**
- Given a `c_major_scale_pos1` take on the Tab screen, when the player moves its note on the A string, fret 3 to the low E string, fret 8 (the popover's position button), then:
  - the live region gives the move announcement (`tab.editMoved` for string 6, fret 8) and then "<n> nearby notes re-fingered", with n equal to the number of other notes whose stored string or fret changed;
  - exactly those notes carry the re-fit outline, and it is gone about 1.5 s later.
- Given that edit, when the player presses Ctrl+Z, then the stored Tab equals the one before the edit, no note carries the re-fit outline, and the edited note is selected.

## Implementation Notes

- **Helper.** `refingered(before, after, targetId)` lives in `model/edit-history.ts`; ids come back in `after`'s order. An inserted note (absent from `before`) is never counted. The session diffs against the history step's `before`, so a merged second digit reports the whole step's re-fit. An edit that changed nothing (a fret set to the fret it has) carries no `refingered`, and the screen leaves a showing outline alone. A `failed` event clears the outline.
- **Outline.** The re-fit outline is a `::before` pseudo-element (2px dashed `--color-refit`, `inset: calc(-7px - var(--space-focus-ring))`). It sits outside the selection outline, the playing marker and the focus ring, so it combines with each. The fade is an opacity transition of 300 ms (`REFIT_FADE_MS`) after the 1.5 s hold (`REFIT_HOLD_MS`). The screen marks the notes `data-refit="true"`, then `"fading"`, then removes the mark. Under reduced motion the CSS transition is `none` and the screen drops the set at 1.5 s, skipping the fading phase. `reducedMotion()` is exported from `TabArea.tsx` for this.
- **Fallback taken for the AC.** On the recorded `c_major_scale_pos1` take, moving the A-string fret-3 note to string 6, fret 8 re-fingers **no** neighbour with the real engine (n = 0). That e2e therefore asserts the move announcement, no re-fit announcement, no outline, and the undo checks. The outline, its count and its ~1.5 s lifetime are asserted on a seeded tab: four notes of one phrase fingered high on strings 6 and 5. A fret-1 digit on the first note re-fits the rest, and undo restores the stored Tab with no outline. The c_major test asserts n = 0 explicitly and waits past the full hold and fade before asserting that no re-fit announcement or outline appeared.

## Plan Change Log

## Review Triage Log

### 2026-10-05 — Review pass
- verdicts: 23 findings — high 0, medium 4, low 17, false 2, maybe-false 0
- findings:
  - `[low]` `[patch]` (blind) The re-fit band (`::before`, inset −4 px) overlaps the playing marker (`::after`, inset −5 px), which hides the dashes — moved the re-fit band outside both.
  - `[low]` `[patch]` (blind) The re-fit band fills the focus ring's surface gap — the same fix; it now sits clear of the focus ring.
  - `[medium]` `[patch]` (blind) A merged step (two-digit entry) reports only the last increment's re-fingered notes — re-fingered is now measured from the merged step's `before`.
  - `[low]` `[reject]` (blind) "Both outlines visible" is never checked visually — jsdom applies no CSS; the class and attribute contract is tested, and the CSS keeps the bands apart.
  - `[low]` `[reject]` (blind) No reduced-motion or axe e2e with the outline showing — reduced motion is unit-tested with `matchMedia`; `--color-refit` is DESIGN's ≥ 3:1 token.
  - `[low]` `[patch]` (blind) The c_major "no re-fingering" check waits a fixed 700 ms — it now waits past the full hold window.
  - `[low]` `[patch]` (blind) The c_major outline branch is dead code against the real engine — the e2e now asserts n = 0 for that move explicitly, so an engine change shows up; the seeded test carries the outline.
  - `[low]` `[reject]` (blind) No direct TabArea test for `refitIds`/`refitFading` — exercised through the Tab screen, which is how they are used.
  - `[low]` `[reject]` (blind) The `'true' | 'fading'` state naming, computed twice — cosmetic.
  - `[low]` `[patch]` (blind) A failed re-fit leaves the previous edit's outline — a `failed` event now clears it.
  - `[low]` `[reject]` (blind) Clearing on analysis is untested — no analysis can start while the tab is shown in this story; re-analysis is 8.6.
  - `[medium]` `[patch]` (edge) The second digit's `refingered` is measured against the first digit's Tab — the same root cause as the blind merge finding.
  - `[low]` `[patch]` (edge) A no-op set-fret emits an empty list and wipes a still-showing outline — an edit that changed nothing now leaves the outline alone.
  - `[low]` `[patch]` (edge) Playing and re-fit outlines overlap — the same as the blind finding.
  - `[low]` `[patch]` (edge) The fixture e2e passes without checking the outline — the same as the blind finding (n = 0 asserted).
  - `[false]` `[reject]` (edge) The outline is removed at 1.8 s, not 1.5 s — DESIGN says it "fades after 1.5 s"; it holds 1.5 s, then fades over 300 ms.
  - `[medium]` `[patch]` (verification-gap) No test of re-fit feedback for a merged two-digit entry — added with the merge fix.
  - `[medium]` `[patch]` (verification-gap, other) The merged step's feedback disagrees with what undo reverts — the same root cause.
  - `[low]` `[patch]` (intent) The Verify scenario's positive branch runs only on a seeded tab — the plan's recorded fallback; the fixture move is now asserted to re-finger nothing.
  - `[low]` `[reject]` (intent) The tab-screen undo-selection unit test selects the note itself — the session tests (8.1, 8.3) and this story's e2e check the selection after undo.
  - `[low]` `[reject]` (intent) Visual claims rest on CSS — the same as the blind finding.
  - `[false]` `[reject]` (intent) The edit announcement and undo selection are not new code — the intent lists them as outcomes, and they already hold; the e2e checks them.
  - `[low]` `[reject]` (intent) Feedback also covers delete, insert and confirm — it follows the plan ("after a command"), and doesn't contradict the intent.

## Design Notes

- **Outline styling:** use `outline: 2px dashed var(--color-refit)` for the re-fit, with an `outline-offset` that differs from the selected style. If the selected style also uses `outline`, put one of the two in a `box-shadow` or a pseudo-element, so both can show at once.
- **Fade:** a `transition: outline-color` (or opacity on a pseudo-element) of about 300 ms after the 1.5 s hold. Under reduced motion, use `transition: none`.
- **Fallback for the AC:** if the real engine re-fingers no neighbour for this move on the recorded take, the e2e can't show the outline. In that case, record the fact in Implementation Notes and assert the outline with a seeded tab whose re-fit is known to move a neighbour, keeping the announcement and undo checks on c_major.

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass.
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test --project=dev tests/e2e/tab-edit.dev.spec.ts tests/e2e/tab-screen.dev.spec.ts` -- expected: pass.

## Auto Run Result

**Status:** built, 2026-10-05.

**Summary:** every edit command's `edit` event carries `refingered`: the other notes whose string or fret the re-fit changed, measured from the undo step's `before`, so a merged two-digit entry reports the whole step. The Tab screen:
- outlines those notes with a dashed `--color-refit` band, held 1.5 s then faded over 300 ms (no fade under reduced motion), clear of the selection outline, the playing marker and the focus ring;
- announces "<n> nearby notes re-fingered" ("1 nearby note …") after the edit's own announcement.

A new edit replaces the set, an unchanged edit leaves it, and undo, redo, failure, a missing take and unmount clear it. The edit announcements and the selection after undo and redo (8.1, 8.3) are unchanged and covered by the e2e.

**Files:**
- `app/src/model/edit-history.ts`: `refingered()`.
- `app/src/session/take-session.ts`: `refingered` on edit events.
- `app/src/ui/screens/Tab.tsx`: the outline set, timers, announcement.
- `app/src/ui/components/TabArea.tsx` and `TabArea.module.css`: `refitIds`, `refitFading`, the band.
- `app/src/ui/strings.ts`: `tab.refingered`.
- Tests: `edit-history`, `take-session` and `tab-screen` unit tests; `tests/e2e/tab-edit.dev.spec.ts` (the c_major move, asserted to re-finger nothing, plus a seeded tab whose re-fit moves neighbours: count, exact outline, gone after ~1.5 s, undo).

**Review:** thorough, 23 findings (4 medium, 17 low, 2 false).
- **Patched:**
  - 1 medium entry: a merged step's re-fingered set.
  - Low:
    - an unchanged edit keeps the outline;
    - a failed edit clears it;
    - the band moved clear of the playing marker and the focus ring;
    - the c_major e2e asserts n = 0 and waits out the hold.
- **Deferred:** none.
- **Rejected:** with reasons in the triage log.

**Follow-up review: not recommended.** No high was patched, and only one medium entry.

**Verification:**
- lint, typecheck, format:check and test pass (1310).
- Dev and chromium e2e: 173/173.
- prod-mic: 4/4.

**Residual risks:**
- The ticket's named move (c_major, A fret 3 to low E fret 8) re-fingers no note with the real engine. The outline is shown end to end on a seeded tab, per the plan's fallback.
- The "1 nearby note re-fingered" singular is new copy (deferred-work).
