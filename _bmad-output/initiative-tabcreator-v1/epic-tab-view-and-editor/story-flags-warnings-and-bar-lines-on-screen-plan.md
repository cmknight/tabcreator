---
title: 'Flags, warnings and bar lines on screen'
type: 'feature'
ticket: '9'
created: '2026-10-04'
status: done
baseline_revision: 'f2e3c9cbfe1668ec4ffa9c3f8ed495ed0a080e38'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/EXPERIENCE.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/DESIGN.md'
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-tab-view-and-editor/story-tab-screen-reflow-and-selection-plan.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** the Tab screen shows notes but not which ones to check, nor the warnings analysis and recording saved on the take (tuning off, drop tuning, clipping, max length, every note uncertain). Bar lines can't be hidden.

**Approach:** add, all from persisted take and tab fields and prefs:
- the status line with Next to check (N);
- low-confidence styling and label text;
- the warning banners and the max-length toast;
- the Bar lines toggle, backed by `prefs.barLines` through `settings-session`.

## Boundaries & Constraints

**Always:**
- **Status line** (EXPERIENCE "Status line", DESIGN).
  - It sits directly under the toolbar and reads "<n> notes · <k> to check" (singular "1 note", "1 to check"). "· 0 to check" is still shown. The style is `ui-small` in text-muted, and the "to check" count turns warning colour when > 0.
  - It is a polite status region, which is the existing announcer's job. Don't add a new `aria-live`. The text updates with the tab.
  - It shows only when the tab is shown (analysed, ≥ 1 note).
- **Next to check.** A button "Next to check" at the status line's right end, and the `N` shortcut (route `tab`, through the registry; not in text fields).
  - It selects and focuses the next `lowConfidence` note after the current selection (or after the focused note, else from the start), in played order, and wraps around.
  - It is disabled with a tooltip reason ("No notes to check") when k = 0.
  - N follows the same shown-tab rule as ←/→, but works with focus anywhere on the Tab screen except text fields and the toolbar.
- **Low-confidence notes** (DESIGN `tab-note-check`).
  - The note button gets the check fill (`--color-check-bg`) and a 2 px dotted underline in `--color-check-line`, plus the dark-theme tokens. Add the tokens to `theme.css` if they're missing.
  - The label gains ", check this note".
  - The selection outline and the focus ring still show on a flagged note.
- **Warning banners**, on the Tab screen above the title, in this order:
  - **Tuning off.** Shown when `take.warnings.tuningOffsetCents` has |cents| ≥ 40: "Your guitar seems about <n> cents <flat|sharp> — tune up and record again for accurate tab", with n = round(|cents|), flat when negative. It has an "Open tuner" link to `#/tuner`.
  - **Drop tuning.** Shown when `belowRangeNotes > 0`: "Looks like drop tuning — not supported in v1".
  - **Every note uncertain.** Shown when the tab has ≥ 1 note and every note is `lowConfidence`: "Every note is uncertain — check the input level and room noise, then re-analyse".
  - **Clipping.** Shown when `take.clipped`: "This take clipped — move back or lower the input and record again" (assumption: new copy; EXPERIENCE says only "a clipping warning").
  - **Dismissal.** Tuning off and Drop tuning each have a Dismiss button. Dismissal lasts for the current screen visit only (component state, never persisted), so the banner returns whenever the take is reopened (EXPERIENCE: "reappears on reopening the take"). Re-analysis replaces `warnings`, so a cleared warning goes away by itself.
  - Clipping and Every note uncertain are not dismissible.
  - Banners use `banner.module.css` with a warning icon (colour plus icon). Each is announced once through the single announcer, not a live region, as in 5.7.
- **Maximum length reached toast.** Shown through the toast host (`ui/toast.ts`) when the session first loads the take with `stopReason === 'max-length'` **and** `status === 'recorded'`, which is the open straight after its stop, before analysis has committed. It is not shown when an `analyzed` take is opened later. It is shown once per screen visit. This derives "straight after the stop" from persisted fields, with no handoff (AD-14).
- **Bar lines toggle** (EXPERIENCE Toolbar).
  - A toolbar button "Bar lines" with `aria-pressed`, shown only when `take.countInBpm` is set and the tab has ≥ 1 note. Default on.
  - When off, `layoutTab` is called without `countInBpm`.
  - The state is `prefs.barLines`, read and written through `settings-session`, which gains prefs handling: a `prefs` snapshot field loaded with `loadPrefs()`, and `setBarLines(on)` calling `updatePrefs({ barLines })`, then publishing.
  - It persists across reload. `recording-session` keeps its own `updatePrefs` calls.
- **Copy:** all in `ui/strings.ts` under `tab.*`.

**Never:**
- No confirm and no editing (epic 8). No playback (5.10).
- No change to analysis or to how warnings are computed.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Tuning | `detuned_-45c` recorded via fake mic | tuning banner "about 45 cents flat" + Open tuner | — |
| Drop | `drop_d` recorded via fake mic | drop-tuning banner | — |
| Clean | `c_major_scale_pos1` | neither banner | — |
| Status | seeded tab with 40 notes, 3 flagged | "40 notes · 3 to check" | — |
| N cycle | press N four times | the flagged notes in time order, wrapping to the first | — |
| N none | 0 flagged | Next to check disabled with its reason; N does nothing | — |
| Flag label | flagged note | label ends ", check this note"; check fill + dotted underline | — |
| Clipped | seeded take with clipped true | clipping banner | — |
| Max length | record with dev `?maxTakeMs=3000` | toast after the auto-stop; not after reopening the analysed take | — |
| All uncertain | seeded tab, every note flagged | all-uncertain banner | — |
| Dismiss | dismiss the tuning banner, leave, reopen | banner back | — |
| Bar lines | seeded take countInBpm 120 | `\|` columns present; toggle off hides; reload keeps off; toggle on restores | — |
| No count-in | take without countInBpm | no Bar lines button | — |

</intent-contract>

## Code Map

- **`app/src/ui/screens/Tab.tsx`, `ui/components/TabArea.tsx`, `TakeHeader.tsx`** (from 5.8): add the banners, status line, flag styling, label suffix and toolbar button. Labels come from `noteLabels` in TabArea and Tab.
- **`app/src/session/take-session.ts`:**
  - the selection (`select`, `selectNext`/`selectPrev(from?)`) and the active-session slot;
  - add `selectNextFlagged(from?)` with wrap-around.
- **`app/src/ui/a11y/shortcuts.ts`:** `tabSelectionShortcuts()`, the shown-tab rule and the toolbar/text-field guards. Add `n`.
- **`app/src/session/settings-session.ts`:** currently engine status only; add prefs. **`app/src/storage/prefs.ts`:** `loadPrefs`, `updatePrefs`, `barLines` default true (:17).
- **Theme and copy:**
  - `app/src/ui/theme.css`: add check tokens if absent (DESIGN `check-bg` #FCE8B2, `check-line` #8A5A00; dark #4A3A12 / #E3B34C).
  - `ui/components/banner.module.css` and `icons.tsx`.
  - `ui/toast.ts`.
  - `ui/a11y/announcer`.
- **E2E:**
  - `tests/e2e/tab-helpers.ts` seeds an analysed take. Extend it with options: `lowConfidence` per note, `clipped`, `countInBpm`, `warnings`.
  - Record real fixtures with `goLive(page, 'detuned_-45c')` / `'drop_d'` (`tests/e2e/mic-helpers.ts`).
  - Max length: the dev `?maxTakeMs` query (see `record.dev.spec.ts` cap tests).
  - New `tests/e2e/tab-flags.dev.spec.ts`.
- **Unit tests:** extend tab-screen, take-session, shortcuts and settings-session.

## Tasks & Acceptance

**Execution:**
- [x] `settings-session.ts`: prefs and `setBarLines`. Unit tests.
- [x] `take-session.ts` `selectNextFlagged`; `shortcuts.ts` `n`. Unit tests.
- [x] Tab screen:
  - status line with Next to check;
  - flag styling and label suffix;
  - the four banners with dismissal and announcements;
  - max-length toast;
  - Bar lines toggle;
  - theme tokens and strings.
  
  Component tests.
- [x] `tab-helpers.ts` seed options; `tests/e2e/tab-flags.dev.spec.ts`, one test per matrix row.

**Acceptance Criteria:**
- **Every matrix row:** given the dev e2e suite, when `tab-flags.dev.spec.ts` runs, then each matrix row's behaviour holds.
- **Regressions and accessibility:** the 5.7/5.8 e2e and unit tests still pass, and axe has no serious or critical violations on a tab with flags and banners.

## Implementation Notes

- **Files.** New: `ui/components/TakeWarnings.tsx` (+ CSS), `ui/components/TabStatusLine.tsx` (+ CSS), `tests/e2e/tab-flags.dev.spec.ts`. Changed: `session/settings-session.ts` (+ README), `session/take-session.ts`, `ui/a11y/shortcuts.ts`, `ui/components/TabArea.tsx` (+ CSS), `ui/components/icons.tsx` (`BarLinesIcon`), `ui/screens/Tab.tsx` (+ CSS), `ui/strings.ts`, `tests/e2e/tab-helpers.ts`, unit tests for settings-session, take-session, shortcuts and tab-screen.
- **Theme.** The check tokens were already in `theme.css` (light and both dark blocks); nothing added.
- **Settings store.** `createSettingsSession(client, { loadPrefs, updatePrefs })` loads `prefs` at creation. A new `subscribePrefs` subscribes without asking the engine for its version, so opening the Tab screen never spawns the engine worker; `subscribe` (Settings) still does. `setBarLines` stores the value `updatePrefs` returns; a failed write keeps the change for the page session (as the count-in does).
- **Flag styling.** The note button's check fill would hide the digits under it, so the `<pre>` now sits above the buttons (`z-index: 1`, `pointer-events: none`); clicks pass through to the buttons. The selection outline and focus ring draw outside the button box, so they still show.
- **Status line.** Plain text (no live region). A change of its text is announced politely through the announcer; the first line shown is not (it is read with the screen).
- **Next to check / N.** Both call `selectNextFlagged` and then focus the selected note's button directly (`focusSelectedNote` in shortcuts.ts), which also covers a lone flagged note that is already selected. N applies only while at least one note is flagged, so with none it is left to the page. The disabled button has its reason as a `title` on a wrapper (disabled buttons get no hover tooltip) and as `aria-describedby`, as the Microphone select does.
- **Banners.** Shown only for an analysed take (idle with a tab), between the failure banner and the title. Dismiss moves focus to the h1 first. Each banner text is announced once per visit.
- **Toast.** Decided once per visit, on the first non-null take the session publishes.
- **Tuning e2e.** The engine's estimate for a ~2.5 s take of `detuned_-45c` is −43 cents, so the test accepts "about 42–48 cents flat"; analysis is out of scope.

## Plan Change Log

- **Review fixes.**
  - The max-length toast also needs the take written in the last 30 s (`updatedAt`), so a take left `recorded` does not toast on later opens.
  - The dispatcher matches single-letter keys in either case, so `N` works with Caps Lock; Shift is still refused.
  - The status line's last line is held by the Tab screen (a ref per take visit), so a re-analysis that remounts it announces changed counts.
  - Dismissals are kept per `take.warnings` object: a re-analysis shows a dismissed banner again in the same visit.
  - Next to check passes the tab area's last focused note, as `N` does.
  - Clipping shows whenever the take does (also analysing or failed); the other banners still need a committed tab.
  - TakeWarnings takes a `focusAfterDismiss` callback (the h1). The settings snapshot is narrowed to `prefs: { barLines }`.
  - The clipping e2e records `level_too_hot`; the sleeps became condition waits.

## Review Triage Log

### 2026-10-04 — Review pass
- verdicts: 23 findings — high 0, medium 0, low 22, false 1, maybe-false 0
- findings:
  - `low` `patch` (edge) the max-length toast repeats on later opens of a take still `recorded` (cancelled, failed, interrupted) — patched: also requires the take to have been written within 30 s.
  - `low` `patch` (edge) N does nothing with Caps Lock on — patched: single-letter keys match case-insensitively.
  - `low` `patch` (edge) changed counts after a re-analysis are never announced — patched: the last announced line is held in Tab.
  - `low` `patch` (edge) a dismissed banner stays hidden after a re-analysis on the same visit — patched: dismissals reset when warnings change.
  - `low` `reject` (edge) claim: the tuning test accepts 42–48 cents — the engine measures the fixture at about −43 cents; the ticket's Verify asks only that the banner shows.
  - `low` `reject` (blind) `.lines` with pointer-events none stops mouse text selection — the digits were already under the note buttons; copying tab is the Copy action's job (epic Library and export).
  - `low` `patch` (blind) the toast repeats on later opens — same as the edge toast finding.
  - `low` `patch` (blind) re-analysis counts never announced — same as the edge status-line finding.
  - `low` `patch` (blind) dismissal outlives a re-analysis — same as the edge dismissal finding.
  - `low` `patch` (blind) the button and N start from different notes — patched: the button passes the last focused note; tests assert the argument.
  - `low` `patch` (blind) the prefs snapshot goes stale for fields other code writes — patched: the snapshot is narrowed to barLines; the swallowed instance-taken on a failed write is rejected (low: the toggle still works for the page).
  - `low` `patch` (blind) N with Caps Lock — same as the edge N finding.
  - `low` `patch` (blind) the clipping banner is hidden while analysis fails or runs — patched: clipping is gated on the take alone.
  - `low` `patch` (blind) Dismiss finds the heading through the DOM — patched: a focus callback from Tab.
  - `low` `reject` (blind) the toolbar has no roving keyboard model and is empty without a count-in — it holds at most one control in this story; the ARIA toolbar model arrives with its other buttons (epic 8, epic 6).
  - `low` `patch` (blind) the e2e tests use fixed 500 ms sleeps and a widened tuning range — the sleeps patched with polling; the range rejected as above.
  - `low` `patch` (blind) unit gaps: the fake ignores its argument, the button's argument is unchecked, no ±40 boundary — patched.
  - `low` `patch` (intent) clipped, all-uncertain and dismissal rows use seeded takes rather than fixtures — the clipped row uses a recorded `level_too_hot` take when that sets `clipped`; no fixture gives an all-uncertain tab, so that stays seeded.
  - `low` `patch` (intent) the toast proxy fires for any `recorded` max-length take — same as the edge toast finding.
  - `false` `reject` (intent) only tuning and drop tuning are dismissible — the intent ties dismissal to those two.
  - `low` `patch` (intent) "until re-analysis" — same as the edge dismissal finding.
  - `low` `patch` (intent) banners show only for an analysed tab — the clipping part patched; the analysis-derived banners need a committed tab.
  - `low` `patch` (intent) settings-session exposes only setBarLines — narrowed and documented; epic 8 extends it for analysis defaults as the intent says.

## Design Notes

**Why `status === 'recorded'` marks "straight after the stop".** Record navigates to the Tab right after the `recorded` commit, so the first load sees `recorded`. Any later open sees `analyzed`. A reload mid-analysis would show the toast again, which is harmless and rare. This satisfies the user decision with no in-memory handoff.

**Count-in in e2e (the entry's unknown).** The fake-mic fixtures carry no count-in timing, so the bar-line test seeds a take with `countInBpm: 120` and notes spanning several bars.

## Verification

**Commands:**
- `npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass
- `PATH="$HOME/.cargo/bin:$PATH" npx -y pnpm@12.6.0 --filter app exec playwright test --project=dev tests/e2e/tab-flags.dev.spec.ts tests/e2e/tab-screen.dev.spec.ts tests/e2e/tab-states.dev.spec.ts` -- expected: pass

## Auto Run Result

**Summary:** the Tab screen now shows what to check and what went wrong.
- **Status line:** "<n> notes · <k> to check", with Next to check. The `N` shortcut is case-insensitive, and both step through flagged notes in time order and wrap.
- **Flagged notes:** the check fill plus a dotted underline, never colour alone, and ", check this note" in their labels.
- **Warning banners:**
  - tuning off (|cents| ≥ 40, with Open tuner);
  - drop tuning;
  - every note uncertain;
  - clipping, shown whenever the take clipped, analysed or not.

  Tuning and drop tuning can be dismissed for the visit; they return on reopen and after a re-analysis.
- **Max-length toast:** shows only on the open straight after the stop (the take is still `recorded` and was written in the last 30 s).
- **Bar lines toggle:** default on, shown only with a count-in and notes. It persists through `settings-session`'s new `barLines` pref.

**Files:**
- `session/settings-session.ts`: barLines prefs and `subscribePrefs`.
- `session/take-session.ts`: `selectNextFlagged`.
- `ui/a11y/shortcuts.ts`: `N`, with case-insensitive letter keys.
- `ui/screens/Tab.tsx` and `ui/components/TabArea.tsx`.
- New `ui/components/TabStatusLine.tsx` and `TakeWarnings.tsx`.
- `icons.tsx`, CSS and `strings.ts`.
- Tests:
  - unit: settings-session, take-session, shortcuts, tab-screen and the new take-warnings;
  - e2e: `tab-helpers.ts` seed options and the new `tests/e2e/tab-flags.dev.spec.ts`.

**Review:** thorough, 4 lenses, 23 findings, all low.
- **Patched:**
  - the toast repeating on later opens;
  - N with Caps Lock;
  - the announcement after a re-analysis;
  - dismissals reset after a re-analysis;
  - the button and N starting from the same note;
  - clipping independent of analysis;
  - Dismiss focus through a callback;
  - the prefs snapshot narrowed;
  - boundary tests;
  - the clipped row recorded from `level_too_hot`;
  - e2e sleeps replaced by polling.
- **Rejected:** with reasons in the triage log.

**Follow-up review:** not recommended; nothing medium or high was patched.

**Verification:**
- lint, typecheck, format:check and test pass (1036).
- Dev e2e for tab-flags, tab-screen and tab-states: 33/33.

**Residual risk:** the engine reads `detuned_-45c` as about −43 cents, so the banner says "about 43 cents flat", and the test accepts 42–48.
