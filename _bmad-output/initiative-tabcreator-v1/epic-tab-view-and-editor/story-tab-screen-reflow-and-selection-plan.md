---
title: 'Tab screen, reflow and selection'
type: 'feature'
ticket: '8'
created: '2026-10-04'
status: done
baseline_revision: '56afbe84a3f45bb7294cd8308c62738798f1817c'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/EXPERIENCE.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/mockups/tab.html'
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-tab-view-and-editor/story-analysis-states-plan.md'
warnings: ['oversized']
deferred:
  - summary: >-
      Enter on a focused note button stays native (the guard exempts only Space), so epic 8's Enter = Confirm can't fire with focus on a note.
    evidence: |-
      shortcuts.ts guarded() leaves Enter on buttons native; the note-button exception covers Space only. Needs an Enter exception when story 8.3 adds Confirm.
    location: >-
      app/src/ui/a11y/shortcuts.ts guarded()
    severity: low
  - summary: >-
      The shortcut dispatcher and TabArea's focus-follow don't know about modal dialogs.
    evidence: |-
      With overlays (story 8.3's popover, the ? dialog, the confirm dialog), N would select a note behind a modal and pull focus out of it, and Esc would clear the selection instead of closing the dialog.
    location: >-
      app/src/ui/a11y/shortcuts.ts dispatchShortcut; app/src/ui/components/TabArea.tsx
    severity: low
  - summary: >-
      The page scrolls sideways at 320 px because the shell's top navigation bar is wider than that; the tab itself fits.
    evidence: |-
      The tab-screen e2e checks page scroll only at 500 and 900 px and the tab area's bounds at every width; the shell nav is outside this story.
    location: >-
      app/src/App.tsx top bar
    severity: low
---

<intent-contract>

## Intent

**Problem:** the Tab screen renders the tab as fixed-width `<pre>` text, with no title editing, date, duration, note buttons, selection, keyboard movement, reflow, accessible structure or toolbar container.

**Approach:** build the screen around the layout from `model/tab-render.ts`, following US-6.2, US-6.3 (selection), US-8.2 and EXPERIENCE.md:
- the selection lives in `take-session`;
- the Tab area's shortcuts go through the shortcut registry, which reaches the open session through a registered "active take session";
- layout uses the measured character width and re-lays out on resize.

## Boundaries & Constraints

**Always:**
- **Header** (EXPERIENCE Tab row, DESIGN title, mockup).
  - **Title.** The `<h1>` holds the title as text, with a pencil button labelled "Rename take" that switches it to a text input.
    - Enter saves, Escape cancels, and blur saves.
    - The value is trimmed. Empty, or unchanged, reverts with no write. Maximum 100 characters.
    - Saving calls a new `takeSession.rename(title)`, which runs `db.patchTake(id, { title }, 'take-session')` and publishes the new title locally.
    - While editing, focus stays in the input. Afterwards it returns to the pencil button.
  - **Date and duration.** Below the title: the date as "Sun 27 Sep 2026, 21:14" (new `formatTakeDate` in `ui/format.ts`, local time, 24-hour), then " · ", then the duration as `m:ss` (`formatElapsed(take.durationMs)`).
- **Skip link.** A "Skip to tab" link is the screen's first focusable element. It moves focus into the tab area, onto the selected note or else the first note. It is visible on focus.
- **Toolbar container.** An empty `<div role="toolbar" aria-label="Tab tools">` sits under the header. Later stories add its buttons. The status line and playback come later too.
- **Tab area.**
  - A `<div role="application" aria-label="Tab" aria-describedby=…>`, whose instructions are a visually hidden paragraph (new copy, assumption): "Use Tab to reach the notes, Left and Right arrows to move between notes, Escape to clear the selection."
  - It holds one wrapper per system: a `<pre aria-hidden="true">` with the six lines, plus an overlay of note `<button>`s placed absolutely over their characters from `TabLayout.cells` (`left = col × charWidth`, `top = (string − 1) × lineHeight`, `width = width × charWidth`).
  - Each system wrapper has `aria-label="Tab system <i> of <n>"`.
- **Note labels** (US-6.2). "Note <n>: <string> string, fret <f>, <pitch>, at <s> seconds".
  - `n` is the 1-based index in played order.
  - The strings are named "high E", "B", "G", "D", "A", "low E".
  - The pitch is the scientific name with sharps (MIDI 60 = C4; new `midiName` in `model/`).
  - `s` is `startMs / 1000` with two decimals.
- **Measured width and reflow.**
  - The font is `var(--font-tab)`, 16 px, line-height 1.35.
  - Measure the character width once per mount from a hidden span of the tab font, and the line height from computed style.
  - `widthChars = max(20, floor(containerContentWidth / charWidth))`.
  - A `ResizeObserver` on the container recomputes, debounced 100 ms, and re-runs `layoutTab(notes, widthChars, countInBpm)`. No line exceeds `widthChars`, so there is no horizontal scroll at any width ≥ 320 px. Remove 5.6's fixed `TAB_WIDTH` and the `<pre tabIndex>` scroll workaround.
- **Selection** (US-6.3, EXPERIENCE).
  - `takeSession` gains `selectedNoteId: string | null` in the snapshot, plus `select(id | null)`, `selectNext()` and `selectPrev()`. Next and previous follow played order and stop at the ends.
  - The selection is kept by note id, so it survives reflow and re-renders. It is cleared if that note no longer exists.
  - Clicking a note button selects it.
  - **Focus.** One note button is in the tab order (roving `tabIndex`): the selected note, else the first. Focusing a note button selects it, and moving the selection moves focus to the newly selected button.
  - The selected button has `aria-pressed="true"` and the selection outline (`2px solid var(--color-primary)`), distinct from the focus ring per DESIGN.
- **Shortcuts** (`ui/a11y/shortcuts.ts`).
  - Add `ArrowLeft` and `ArrowRight` (route `tab`; previous and next note) and an Escape entry (route `tab`; clears the selection, only `when` a selection exists).
  - Their handlers reach the open session through a new module-level registration in `session/take-session.ts`: `setActiveTakeSession(session | null)` and `activeTakeSession()`. The Tab screen registers on mount and unregisters on unmount.
  - **Key precedence (the entry's unknown).** The existing guard already skips text fields (so the title input is safe) and Space/Enter on buttons. The arrow and Escape entries additionally do nothing while focus is inside the `role="toolbar"`; the toolbar will own its arrow keys under the ARIA toolbar pattern. The existing count-in Escape keeps priority on Record.
  - A new string goes in the shortcut descriptions.
- **Note list view** (US-8.2, EXPERIENCE). A toggle button "Note list view" (`aria-pressed`) under the toolbar shows an `<ol>` of the same labels in played order. It is visible when on, which is an assumption: US-8.2 says visually hidden, but a visible list is equally readable. Its state is per screen visit.
- **Accessibility.**
  - axe reports no serious or critical violations on the screen, in light and dark themes.
  - The visible focus ring is the app's.
  - Focus is never trapped, and the analysis-state focus handling from 5.7 is kept.
- **Copy:** in `ui/strings.ts` under `tab.*`.

**Never:**
- No editing of notes, no status line, no flags, no playback, no bar-line toggle (5.9, 5.10, epic 8).
- No new layout rules in `tab-render.ts`; it is used as is.
- No changes to the shortcut dispatcher's modifier and repeat rules.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Reflow | viewport 1200 → 500 → 900 px | systems re-laid out; every line length ≤ widthChars; selected note still selected and focused if it was | — |
| Label | 12th note, string 2 fret 3, MIDI 62, start 4250 ms | "Note 12: B string, fret 3, D4, at 4.25 seconds" | — |
| Arrows | → / ← with a note focused | the next / previous note is selected and focused; ends stop | — |
| Esc | a selection exists | cleared; focus stays in the area | — |
| Title field | arrows / Esc typed in the title input | no selection change; Esc cancels the rename only | — |
| Rename | type + Enter | title saved (patchTake by take-session); shown | empty → revert |
| Skip link | activate | focus on the selected (or first) note | — |
| Note list | toggle on | `<ol>` of the same labels, same order | — |
| Toolbar focus | arrow key while focus is in the toolbar | no selection change | — |
| axe | analysed tab shown | no serious/critical violations | — |

</intent-contract>

## Code Map

- **`app/src/ui/screens/Tab.tsx`:**
  - body states: missing, saving, running, cancelled, no notes and systems (about :141–210);
  - the focus-restore effect (:126–139);
  - `TAB_WIDTH` (:24);
  - the h1 (:228).
  - Keep the analysis states. Replace the systems branch with the new tab area, and add the header, toolbar and note list. Split it into components under `ui/components/` (e.g. `TabArea.tsx`, `TakeHeader.tsx`) if Tab.tsx grows large.
- **`app/src/session/take-session.ts`:**
  - the snapshot (:30–38) and actions (:51–73);
  - `WRITER` (:75);
  - `deps.db` is a `Pick` of `getTake`/`getTab`: add `patchTake`;
  - `rereadForeignFields` (:196–207) treats title as foreign and skips the session's own writes (:222). Once the session writes the title it must publish it itself.
- **`app/src/model/types.ts`:** `TAKE_FIELD_OWNERS` (:103–127; `take-session` owns `title`), `Note`, `OPEN_MIDI`.
- **`app/src/model/tab-render.ts`:** `layoutTab`, `TabCell` (`noteId`, `col` including the prefix, `width`, `string`) and `TabSystem`.
- **`app/src/ui/a11y/shortcuts.ts`:**
  - `SHORTCUTS` (:124), `Shortcut` (:22–32) and `guarded()` (:50–56);
  - the count-in Escape (:112–120);
  - `dispatchShortcut` (:143–171), which matches routes through `parseRoute`.
- **`app/src/ui/format.ts`:** `formatElapsed`. Add `formatTakeDate`.
- **`app/src/ui/theme.css`:** `--font-tab` (:34), `--color-primary`, the focus outline (:111). DESIGN `tab-note-selected` / `focus-ring`.
- **Tests:**
  - `tests/unit/tab-screen.test.tsx`: extend it, keeping the 5.7 state tests.
  - New unit tests for the selection in `take-session.test.ts`, the shortcuts in `shortcuts.test.ts`, and `midiName`/`formatTakeDate`.
  - New `tests/e2e/tab-screen.dev.spec.ts`. Seed an analysed take with a tab through `page.evaluate`, importing `/src/storage/db.ts` (`createTake` with status `recorded`, then `commitAnalysis` with about 40 generated notes so the tab wraps), as `tests/e2e/instance.dev.spec.ts:62-85` does. Put the seed helper in `tests/e2e/tab-helpers.ts`.
  - Use `expectNoSeriousAxe` (`tests/e2e/mic-helpers.ts:79`), and switch theme with the app's prefs/theme mechanism or `page.emulateMedia({ colorScheme })`.

## Tasks & Acceptance

**Execution:**
- [x] `model/` `midiName`; `ui/format.ts` `formatTakeDate`. Unit tests.
- [x] `session/take-session.ts`: the selection state and actions, `rename`, and the active-session registration. Unit tests.
- [x] `ui/a11y/shortcuts.ts`: ←/→/Esc for `tab`, with the toolbar guard. Unit tests.
- [x] The Tab screen: the header (rename, date, duration), skip link, toolbar container, tab area (measured layout, overlays, roving focus, labels, instructions), note list toggle, CSS and strings. Component tests: overlay positions match the cells, labels, rename.
- [x] `tests/e2e/tab-helpers.ts` and `tests/e2e/tab-screen.dev.spec.ts`: one test per matrix row.

**Acceptance Criteria:**
- **Dev e2e on a seeded tab:**
  - resizing reflows with no line over the width and keeps the selection;
  - ←/→ and Esc move and clear the selection, but not from the title field or the toolbar;
  - each note button has its label;
  - the note list matches;
  - axe shows no serious or critical violations in light and dark.
- **Regressions:** the unit tests, the 5.7 tab-states e2e and the 5.6 prod-mic test pass. The prod test's `pre` locator may need to follow the new markup without weakening what it checks.

## Implementation Notes

- **Files.** New: `model/notes.ts` (`midiName`, `playedOrder`), `ui/components/TabArea.tsx` (+ CSS), `ui/components/TakeHeader.tsx` (+ CSS), `tests/unit/notes.test.ts`, `tests/e2e/tab-helpers.ts`, `tests/e2e/tab-screen.dev.spec.ts`. Changed: `session/take-session.ts` (+ README), `ui/a11y/shortcuts.ts`, `ui/format.ts`, `ui/strings.ts`, `ui/components/icons.tsx` (PencilIcon), `ui/screens/Tab.tsx` and `Tab.module.css`, unit tests for take-session, tab-screen, shortcuts and format.
- **Shortcut guard.** `Shortcut.when` now receives the keydown target (`when(target)`), so the Tab entries can skip focus inside `[role="toolbar"]`. The dispatcher's modifier and repeat rules are unchanged. The arrows apply only while the active session has notes (so they don't swallow page scrolling elsewhere); with no selection, → selects the first note and ← the last.
- **Header.** The pencil button sits beside the `<h1>`, not inside it, so the heading's name stays the title (existing tests and e2e read `h1` text). While renaming, the `<h1>` holds the input. A blur saves without moving focus; Enter/Escape return focus to the pencil. A failed `patchTake` puts the old title back (devWarn).
- **Measurement.** A zero-height, invisible box with a system's padding and border holds a 100-character probe; `charWidth = probeWidth / 100`, the content width is the box's width minus its padding and borders. Without layout (jsdom) the fallbacks are 9.6 px and 21.6 px. The area keeps `data-testid="tab-systems"` and one `<pre>` per system, so 5.6/5.7 locators still work; `data-width-chars` exposes the current width for tests.
- **Focus.** A selection moved while focus is not in a text field moves focus to the selected button. A note button that a reflow re-created (it moved to another system) hands focus to its replacement; the blur handler only drops the claim if the old button is still connected a frame later.
- **Toolbar and note list** render only for an analysed take (idle with a tab); the skip link and note-list toggle only when the tab has notes.
- **Tests changed, not loosened.** The 5.7 "failed" test's exact button list now includes the header's Rename take; the registry test expects the tab Esc after the count-in Esc; two take-session `toEqual` snapshots include `selectedNoteId: null`.
- **320 px.** The tab itself fits at 320 px, but the shell's top bar (nav) is wider than 320 px and scrolls the page; that is outside this story. The e2e checks the page scroll at 500 and 900 px and the tab area's bounds at every width.

## Plan Change Log

- **Follow-up review fixes (after 5.9–5.11).**
  - The reflow restore refocuses a note only when focus fell to `<body>`, and drops a claim whose note has no button.
  - The Tab focus rescue also keys on `missing` and on whether the tab is shown.
  - One record of the last-focused note, `TakeSession.lastFocusedNoteId`, is set by `focusNote`. The arrows, `N`, Next to check and the tab stop all start from it.
  - Esc clears the selection from anywhere on the screen except text fields and the toolbar.
  - A per-shortcut `repeat` opt-in is used only by the Tab ←/→.
  - The area instructions now mention Space, N and P.
  - Selectors are shared in `ui/a11y/selectors.ts`.

- **Review fixes.**
  - With nothing selected, ←/→ step from the focused note (`selectNext(from)` and `selectPrev(from)`, passed by the shortcut handler). The roving tab stop falls back to the last-focused note before the first. A reflow refocuses the note that had focus, by id, without selecting it.
  - ←/→ act only with focus inside `[role="application"]`. Esc acts only with focus there or on the body. All three need the tab to be shown (idle, not missing, notes > 0).
  - A comment at `guarded()` and a unit test settle Space and Enter on toolbar buttons.
  - `rename` keeps the pending title over takes read while its write is in flight. A failed rename reverts to the last stored title, and only the latest rename's settlement decides what shows.
  - Titles are capped by code points (`capTitle`) in both the session and the field; `maxLength` was removed.
  - An Enter during an IME composition is ignored. Unmounting mid-edit saves the draft.
  - A new e2e checks with a DOM Range that note 12's button sits over its digits at two widths.

## Review Triage Log

### 2026-10-04 — Review pass
- verdicts: 32 findings — high 0, medium 5, low 25, false 2, maybe-false 0
- findings:
  - `medium` `patch` (verification-gap) nothing checks that note buttons sit over their digits in a real browser — patched: an e2e test comparing a DOM Range over note 12's characters with its button at two widths.
  - `low` `patch` (verification-gap other) a rename racing a foreign take-put can leave a stale title — grouped with the blind rename-race finding; patched there.
  - `medium` `patch` (blind) Esc leaves selection and focus out of step: → jumps to note 1, the roving stop moves, a reflow refocuses the first note — patched: step and the tab stop start from the focused note; the reflow refocuses by id; tests.
  - `low` `patch` (blind) a rename during analysis or a re-read can be overwritten by a stale title — patched: the pending title is kept over later publishes until the write settles.
  - `low` `reject` (blind) a failed rename gives no visible feedback — it reverts to the stored title; a message would be new copy beyond the plan.
  - `low` `patch` (blind) two quick failed renames revert to an unsaved title — patched: a failed rename reverts to the last stored title.
  - `low` `patch` (blind) the 100-character cap can split a surrogate pair — patched: capped by code points, with a test.
  - `low` `patch` (blind) the shortcuts act whenever the snapshot has notes, not only when the tab is shown — patched: they require the shown-tab state.
  - `medium` `patch` (blind) the arrows act from anywhere on the screen and pull focus into the tab — patched: ←/→ only with focus in the tab area; Esc in the tab area or on the body.
  - `low` `reject` (blind) aria-pressed misdescribes a selection — the plan's choice (a pressed note is the selected one); revisit with editing (epic 8) if users find it confusing.
  - `low` `reject` (blind) the ordered list repeats "Note N" — EXPERIENCE asks for an ordered list of the same labels.
  - `low` `reject` (blind) labels and played order are computed twice — a cost on 40–500 notes with no named harm; for the refactor sweep.
  - `low` `reject` (blind) formatTakeDate has no invalid-date guard, and its names live outside strings.ts — createdAt is always written by the app as ISO; the names are formatting data, not copy.
  - `low` `reject` (blind) blur on a window switch commits the rename — saving typed text on blur is the plan's rule; nothing is lost.
  - `low` `reject` (blind) the empty-title e2e check uses a 200 ms wait; readTake leaks a connection on error — the write would have to take over 200 ms to slip through, and the error path closes with the page.
  - `low` `defer` (blind) the page scrolls sideways at 320 px because of the shell's top bar — outside this story (the shell); for epic Offline, accessibility and budgets.
  - `medium` `patch` (edge) Esc then a reflow focuses and selects the first note — same root cause as the blind Esc finding.
  - `low` `patch` (edge) arrows and Esc swallowed while the tab isn't shown — same as the blind shown-tab finding.
  - `low` `patch` (edge) a rename during Saving or load is overwritten — same as the blind rename-race finding.
  - `low` `patch` (edge) the surrogate-pair cut — same as the blind cap finding.
  - `low` `patch` (edge) Enter during an IME composition saves half-composed text — patched: Enter ignored while composing.
  - `low` `patch` (edge) unmounting mid-edit discards the typed title — patched: the draft is saved on unmount.
  - `low` `reject` (edge) an invalid createdAt shows NaN — same as the blind date finding.
  - `low` `reject` (edge) removing overflow-x lets an area under 20 characters scroll the page — under about 200 px, below the 320 px floor.
  - `low` `reject` (edge) claim: lines can exceed a content box under 20 characters — same width floor.
  - `low` `patch` (intent) the stated unknown names Space and Enter, which no test presses — patched: a comment at the guard and a unit test that a tab-route Space/Enter entry doesn't fire on a toolbar button.
  - `medium` `patch` (intent) arrow scope beyond the tab area — same as the blind arrow-scope finding.
  - `low` `reject` (intent) the note list is visible, not visually hidden — the plan's recorded assumption; a visible list is equally readable.
  - `low` `reject` (intent) the title is edited through a pencil button, not by clicking the heading — the plan's choice; keeps the heading's name the title.
  - `low` `reject` (intent) the 320 px page check is skipped and the font isn't re-measured on zoom — the 320 px part is deferred above; zoom changes the container width, which re-lays out.
  - `false` `reject` (intent) Esc is registered on the tab route, not globally — it behaves the same on this screen; the count-in Esc keeps priority.
  - `false` `reject` (intent) axe covers only the analysed tab — the Verify line names that state.

### 2026-10-04 — Follow-up review pass (keyboard and focus model, after 5.9–5.11)
- scope: the full diff since the baseline (410 kB, 54 files) was too large for useful lenses; the review was scoped to the keyboard and focus surface the follow-up recommendation named — shortcuts.ts, TabArea, TakeHeader, Tab, take-session, use-playback, TabStatusLine and their tests (150 kB).
- verdicts: 25 findings — high 0, medium 3, low 18, false 4, maybe-false 0
- findings:
  - `medium` `patch` (verification-gap) nothing checks that a reflow leaves focus alone once it has left the tab area — patched with the edge stale-claim finding: restore only when focus is lost; tests for the title field and the Bar lines toggle.
  - `medium` `patch` (verification-gap other) the rAF-delayed claim clear leaves a window where a layout change pulls focus back — same root cause.
  - `low` `patch` (blind) N and Next to check start from different "focused note" records — patched: one last-focused id on the take session.
  - `low` `patch` (blind) Esc is narrower than EXPERIENCE's Global rule — patched: clears the selection from anywhere but text fields and the toolbar.
  - `low` `patch` (blind) holding ←/→ moves only one note — patched: a per-shortcut repeat opt-in for the Tab arrows.
  - `low` `patch` (blind) focus falls to <body> when the focused note disappears with the analysis state unchanged — patched: the rescue key includes missing and the shown tab.
  - `low` `patch` (blind) the area's instructions omit Space, N and P — patched.
  - `low` `reject` (blind) aria-pressed misdescribes a selection — carried: rejected in the first pass (the plan's choice), code unchanged.
  - `low` `defer` (blind) Enter on a focused note stays native, which will block epic 8's Enter = Confirm — the guard needs a note-button exception for Enter when Confirm lands (story 8.3).
  - `low` `defer` (blind) the dispatcher and focus-follow don't know about modal dialogs — needed when `ui/a11y/overlays.ts` lands (story 8.3).
  - `low` `reject` (blind) the toolbar has no roving arrow keys — carried from 5.9's pass: arrives with its other buttons in epic 8 and epic 6.
  - `low` `patch` (blind) two focused-note lookups use different scopes, and TEXT_FIELD is defined twice — patched: one shared selectors module.
  - `low` `reject` (blind) the skip link can do nothing before the first measure — the link and the note buttons appear in the same layout pass; no reachable gap shown.
  - `low` `reject` (edge) rename B then C, C fails before B succeeds, shows the original title — needs two overlapping renames with an out-of-order failure; storage still holds a valid title.
  - `low` `patch` (edge) focus drops to <body> when the take goes missing — same as the blind rescue finding.
  - `low` `reject` (edge) Next to check loses focus when the count drops to 0 — the count only changes on re-analysis today; epic 8's edits will revisit (noted for 8.1).
  - `medium` `patch` (edge) a stale focus claim for a removed id steals focus later — same root cause as the verification-gap finding.
  - `low` `reject` (edge) blur on a window switch commits the rename — carried: rejected in the first pass.
  - `low` `reject` (edge) a user scrolling the playing note away isn't followed until the next note — keep-in-view is per note change by design (500 ms cap).
  - `low` `patch` (edge) claim: Esc doesn't clear from the h1, Play, Next to check or Note list toggle — same as the blind Esc finding.
  - `false` `reject` (intent) arrows act only in the tab area (reading B) — the first pass's deliberate patch, following EXPERIENCE ("arrows move within it").
  - `low` `patch` (intent) Esc scope narrower than the intent — same as the blind Esc finding.
  - `false` `reject` (intent) the toolbar exclusion is redundant for arrows — harmless and still needed for N, Space and P.
  - `false` `reject` (intent) the skip link and tab stop use the last focused note after Esc — the first pass's patch for Esc then →; consistent with roving focus.
  - `false` `reject` (intent) restored focus after a reflow doesn't select — the first pass's patch; a reflow must not change the selection.

## Design Notes

**Why an "active take session" registration.** The shortcut registry is a static list of handlers that reach module singletons, but a `take-session` is created per screen visit. A single module-level slot, set by the mounted Tab screen, keeps the registry static and gives the handlers one well-defined target. It is cleared on unmount, so a handler never acts on a disposed session.

**Roving focus.** Only one note button is in the tab order, so the 40+ notes don't each cost a Tab stop. Tab enters the area and the arrows move within it, as EXPERIENCE says.

## Verification

**Commands:**
- `npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass
- `PATH="$HOME/.cargo/bin:$PATH" npx -y pnpm@12.6.0 --filter app exec playwright test --project=dev tests/e2e/tab-screen.dev.spec.ts tests/e2e/tab-states.dev.spec.ts tests/e2e/decode.dev.spec.ts` -- expected: pass
- `PATH="$HOME/.cargo/bin:$PATH" npx -y pnpm@12.6.0 --filter app exec playwright test --project=prod-mic` -- expected: pass

## Auto Run Result

**Summary:** the Tab screen is built around the tab.
- **Header:**
  - The title is renamed through the pencil. Enter saves, Escape cancels, and blur or unmount saves.
  - The title is capped at 100 code points, written by take-session, and protected against races with a commit or re-read.
  - Below it: the date ("Sun 27 Sep 2026, 21:14") and the duration.
- **Screen structure:**
  - The "Skip to tab" link.
  - An empty toolbar container (`role="toolbar"`).
  - A "Note list view" toggle showing an ordered list of the labels.
- **Tab area** (`role="application"`, with instructions):
  - It is laid out at the measured character width and re-laid out on resize after a 100 ms pause.
  - Each note is a labelled button over its digits ("Note 12: B string, fret 3, D4, at 4.25 seconds").
  - One note at a time is in the tab order.
- **Selection:**
  - It lives in take-session, survives reflow, and is reached by the shortcut registry through the active-session slot.
  - ←/→ work only from the tab area; Esc works from the tab area or the page body. All three only act while the tab is shown.
  - Arrow keys inside the toolbar, and Space/Enter on a focused button, stay with the browser.

**Files:**
- `app/src/model/notes.ts` (new): `midiName`, `playedOrder`.
- `app/src/ui/format.ts`: `formatTakeDate`.
- `app/src/session/take-session.ts`: selection, rename, `capTitle` and the active session.
- `app/src/ui/a11y/shortcuts.ts`.
- `app/src/ui/screens/Tab.tsx`.
- `app/src/ui/components/TabArea.tsx` and `TakeHeader.tsx` (new), with CSS.
- `icons.tsx` (`PencilIcon`), `ui/strings.ts`, `session/README.md`.
- Tests:
  - unit: notes, format, take-session, shortcuts and tab-screen;
  - e2e: `tests/e2e/tab-helpers.ts` (seeds a 40-note analysed take) and `tests/e2e/tab-screen.dev.spec.ts`.

**Review:** thorough (4 lenses), 32 findings.
- **Patched:**
  - 3 medium entries:
    - selection and focus after Esc;
    - arrow scope;
    - note-button geometry checked against the rendered digits with a DOM Range.
  - Low:
    - the shortcuts only act while the tab is shown;
    - the Space/Enter toolbar rule documented and tested;
    - the rename races and revert-to-stored;
    - the code-point cap;
    - IME Enter;
    - save on unmount.
- **Deferred:** sideways scroll at 320 px from the shell's top bar, for epic Offline, accessibility and budgets.
- **Rejected:** with reasons in the triage log.

**Follow-up review: recommended.** Three medium entries were patched. The keyboard and focus model is the unverified risk: roving focus, the reflow refocus that relies on a timing check, and the shortcut scope working together. It is covered piecewise by unit and e2e tests but not yet re-reviewed as a whole.

**Verification:**
- lint, typecheck, format:check and test pass (1003).
- Dev e2e for tab-screen, tab-states and decode: 22/22.
- prod-mic: 4/4.

## Auto Run Result (follow-up review, 2026-10-04)

**Scope:** the keyboard and focus model only (roving focus, reflow refocus, shortcut scope), reviewed as one diff against the current code, because the full diff since 5.8 spans the rest of the epic. Thorough, 4 lenses, 25 findings: 3 medium, 18 low, 4 false.

**Patched:**
- **Medium:** the reflow refocus could pull focus back to a note after the user had moved on, which mid-rename stole focus from the title field and saved a half-typed title. It now restores focus only when focus fell to the page body, and drops the claim otherwise.
- **Medium:** `N`, Next to check and the tab stop started from different notes. Take-session now holds one `lastFocusedNoteId` (set by `focusNote`), and all three start from it.
- **Medium:** Esc cleared the selection only from the tab area; EXPERIENCE makes it Global. It now clears it from anywhere on the Tab screen except text fields and the toolbar.
- **Low:**
  - focus is rescued to the h1 when the take goes missing;
  - held ←/→ repeat (a per-shortcut `repeat` opt-in);
  - `tab.areaInstructions` names Space, N and P;
  - the focus selectors are shared in `ui/a11y/selectors.ts`.
- **Deferred to story 8.3** (noted in epic Tab editing): an Enter exception on note buttons for Confirm, and making the shortcuts and focus-follow aware of modal dialogs.

**Follow-up review: not recommended.** No high finding was patched; the mediums are covered by new unit tests that fail on the old code.

**Verification:**
- lint, typecheck, format:check and test pass (1132).
- Dev and chromium e2e: 163/163 after reruns. The 8 first-run failures were all audio-timing specs (level meter, count-in, playback cursor, fake mic, banner styles, decode, instance), none in the tab screen; 6 passed on rerun and the last 2 passed alone with one worker.
- prod-mic: 4/4.
