---
title: 'Tuner screen'
type: 'feature'
ticket: '9'
created: '2026-10-02'
status: done
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: 'bdd8fa65254392ecb8c59c3d5ee0161d07eb4a22'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** `#/tuner` is an empty heading. The player cannot tune before recording (CAP-4, US-2.1), although the pitch core (2.4) and every mic piece (2.1, 2.5–2.8) exist.

**Approach:** Build the Tuner screen per mockups/tuner.html. Every 50 ms it reads a pitch from recording-session's single analyser through a pure tuner state machine: median-smoothed string and cents, a needle, In tune after 500 ms, and six string chips ticked for the page session. It reuses the setup and error cards, the meter, the select and the quality banner, and links Record ("Tune first") and Tuner ("Done — go to Record") both ways.

## Boundaries & Constraints

**Always:**
- **Readings.** The UI never touches the AnalyserNode (AD-2). `recordingSession.readTuner(now)` reads the live input's frame and runs `detectPitch` at the analyser's context sample rate (`analyser.context.sampleRate`). It then advances a pure machine `nextTuner(state, hz | null, now)` in `audio/tuner.ts`, the same way `readLevels` works.
- **No live input.** When the mic is not live, `readTuner` returns no reading. A gap of more than 500 ms between reads restarts the machine; ticked strings are kept.
- **The machine.**
  - Each pitch is pushed into a 5-estimate median history. The reading is `nearestString(median)`.
  - A null frame (silence or no pitch) clears the history and the In tune timer, but keeps the last reading on screen for up to 3 s (mockup (a)). After 3 s with no pitch, it shows the no-pitch state.
  - In tune = |cents| ≤ 3 on the same string for 500 ms continuously. Any reading over 3 cents, a string change, or a null frame restarts the timer. Reaching it ticks that string.
- **Ticked strings.** They live in the recording-session snapshot (`tunedStrings`, page session, memory only). The store notifies only when the set grows, never per poll.
- **Display, top to bottom.**
  1. Quality banner (2.8).
  2. h1 "Tuner".
  3. Panel:
     - String name in display type: E A D G B E. The no-pitch state shows a muted "—" with "Play a single open string".
     - Needle track from −50 to +50 cents, with ticks and labels −50 −25 0 +25 +50. The needle is in primary, clamped to the ends, and hidden in the no-pitch state.
     - Cents readout, signed and rounded, with U+2212 for minus: "+12 cents", "−1 cents", "0 cents".
     - Beside the cents: "♯ Sharp — tune down" when sharp, "♭ Flat — tune up" when flat. While In tune, a success check plus "In tune" replaces the direction text.
     - Six chips, low E to high E, labelled E A D G B E. A ticked chip fills with success colour and gets a check badge. Each chip has an accessible name: "Low E string, in tune" or "Low E string, not yet tuned", then "A string", …, "High E string".
     - With all six ticked, a success line "All six strings in tune".
  4. Inputs row: `LevelMeter`, then `MicSelect`.
  5. "Done — go to Record": an `<a href="#/record">` styled as the primary button.
- **Mic card states.** When the mic is not live, the 2.1/2.5 setup card and error cards replace the panel and the inputs row, as on Record, with the same Allow / Try again behaviour, `resume()` on mount, and focus handling.
- **Record.** Record gets a "Tune first" link to `#/tuner`, at the right end of a row with its h1 (mockup record.html `rec-head`).
- **Strings and tokens.** All text goes verbatim in `ui/strings.ts`. Use theme tokens only, with no transition under `prefers-reduced-motion`.
- **Accessibility.**
  - No `aria-live` on the screen (AD-18). The needle is `role="img"` with an `aria-label` such as "Tuning needle, −50 to +50 cents: +12 cents" (or "No pitch detected").
  - Announce politely through `announce`, each once per occurrence:
    - "<Name> string in tune" when a string enters In tune;
    - "All six strings in tune" when the sixth ticks.
- **Polling.** Runs at 50 ms only while the Tuner is mounted and live.

**Never:**
- No engine or wasm involvement.
- No change to the tuner core's constants or to `detectPitch`, `median`, `nearestString` or `pushEstimate`.
- No second analyser or AudioContext.
- No persistence of ticked strings.
- No recording controls.
- No changes to `audio/fake-mic.ts`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First visit | `#/tuner`, no grant | setup card; no getUserMedia before Allow | none |
| Error | `failNext('NotAllowedError')`, Allow | 2.5 denied card on Tuner; Try again recovers | per 2.5 |
| Steady in-tune tone | pitch 0 cents for 499 ms / 500 ms | no In tune / In tune and chip ticked | none |
| Off by 12 cents | +12 cents | "+12 cents", "♯ Sharp — tune down", needle right of centre | none |
| Flat | −7 cents | "−7 cents", "♭ Flat — tune up" | none |
| Beyond range | +80 cents | needle clamped at +50; readout "+80 cents" | none |
| Jitter across 3 | in tune then one reading at 4 cents | In tune clears; timer restarts | none |
| Dropout | null frames < 3 s | last reading stays; In tune cleared | none |
| No signal | null for ≥ 3 s | "—" + "Play a single open string", no needle, ticks kept | none |
| String change | A then D readings | timer restarts on D | none |
| Leave and return | ticks, go to Library, back | ticks kept | none |
| open_strings | `?fakeMic=open_strings`, Allow on Tuner | all six chips ticked; In tune never shown before 500 ms of in-tune readings | none |

</intent-contract>

## Code Map

Builds on 2.1–2.8 (`bdd8fa6`).
- `app/src/audio/tuner.ts` -- pure core: `detectPitch(frame, sampleRate)`, `pushEstimate`, `median`, `nearestString(hz) → { string, targetHz, cents }`, `StringNo` (1 = high e … 6 = low E). Add the pure machine (`TunerState`, `INITIAL_TUNER_STATE`, `nextTuner`, constants `IN_TUNE_CENTS = 3`, `IN_TUNE_MS = 500`, `NO_PITCH_HOLD_MS = 3000`, `TUNER_POLL_MS = 50`). Update the header comment, which says the screen owns the timing; it now lives here, pure, driven by the store.
- `app/src/session/recording-session.ts` -- `readLevels(now)` is the pattern: gap reset (`READ_GAP_MS`), `input.readFrame()` (a reused buffer: read it and use it synchronously), notify only on change. Add `readTuner(now)` and snapshot `tunedStrings: readonly StringNo[]`. `OpenedInput` already includes `analyser`.
- `app/src/ui/screens/Record.tsx` -- `MicSetupCard`, `MicIcon` and the view-swap focus logic (`FOCUS_TARGET`, `focusInside`) are local. Move them into a shared `ui/components/` module that both screens use, with no behaviour change on Record. `Record.module.css` holds the card and `.primary` styles; move the shared rules with them.
- `app/src/ui/components/{LevelMeter,MicSelect,InputQualityBanner}.tsx` -- store-driven, no props; mount as-is. InputQualityBanner focuses the enclosing `section`'s h1 on Dismiss, so the Tuner h1 needs `tabIndex={-1}` inside that section.
- `app/src/ui/screens/Tuner.tsx` -- currently just the h1; `strings['tuner.title']`.
- `app/src/ui/a11y/announcer.ts` -- `announce(text)`.
- Tests: `app/src/audio/tuner.test.ts` (colocated; node env), `app/tests/unit/recording-session.test.ts` (fake deps), `app/tests/e2e/mic-helpers.ts` (`countGetUserMedia`, `expectNoSeriousAxe`), existing `mic-*.dev.spec.ts` for Record flows. Fake mic: `?fakeMic=open_strings` plays six plucks (low E → high e), each 900 ms, 1 s apart, starting when the stream opens.

## Tasks & Acceptance

**Execution:**
- [x] `app/src/audio/tuner.ts`, `app/src/audio/tuner.test.ts` -- the machine and the matrix's timing rows with a fake clock (499/500 ms, jitter, dropout, 3 s no-pitch, string change).
- [x] `app/src/session/recording-session.ts`, `app/tests/unit/recording-session.test.ts` -- `readTuner`, `tunedStrings`, gap reset, not-live behaviour, notify only on a new tick.
- [x] `app/src/ui/components/` (shared mic card + focus swap), `app/src/ui/screens/Record.tsx`, `Record.module.css` -- extraction and the "Tune first" link.
- [x] `app/src/ui/screens/Tuner.tsx`, `Tuner.module.css`, `app/src/ui/strings.ts` -- the screen, 50 ms poll, announcements.
- [x] `app/tests/e2e/tuner.dev.spec.ts` -- open_strings from the Tuner ticks all six chips; In tune shows only after ≥ 500 ms of in-tune readings (timestamp it in the page, e.g. a MutationObserver); axe passes live and after all six; setup card with no getUserMedia before Allow; Tune first / Done links navigate.

**Acceptance Criteria:**
- Given the dev build on `?fakeMic=open_strings#/tuner`, when Allow is clicked, then all six chips tick, In tune never appears before 500 ms of in-tune readings, and axe reports no serious or critical violations.
- Given Record, when "Tune first" is chosen, then the Tuner opens; given the Tuner, when "Done — go to Record" is chosen, then Record opens with the mic still live.
- Given the full verification, when it runs, then every existing spec still passes and `app/dist` has no dev-only strings.

## Implementation Notes

- Shared mic area is `ui/components/MicGate.tsx` (+ `MicGate.module.css`): it owns `resume()` on mount, the setup/error card and the view-swap focus logic, and renders its children only while live. Record and Tuner both use it. `.primary` moved to `ui/components/buttons.module.css`, shared by the card buttons and the Tuner's Done link.
- `TUNER_POLL_MS`, `TunerReading` and `TunerDisplay` reach the UI through `session/recording-session.ts` re-exports (ui/ may not import audio/).
- The sixth string's "<Name> string in tune" and "All six strings in tune" would land in the same poll; the shared announcer keeps only the latest polite message within a frame, so the all-six announcement is deferred 1 s.
- The tuner e2e timestamps readout changes with a MutationObserver (exposed as `data-string`/`data-cents` on the readout) and allows 40 ms render jitter against the 500 ms rule. Axe on the live Tuner runs in the Tune-first test, not during the open_strings plucks, so it does not delay renders mid-measurement.
- Pre-existing, unrelated: `mic-select.dev.spec.ts` (switch, unplug) is flaky under `--repeat-each` load on the baseline too.

## Plan Change Log

### 2026-10-02 — Review loop 1 (fixed in place, user-approved)
- **Trigger:** blind review: after a note fades, the held reading keeps showing a direction, so a string that was In tune at +1.4 cents shows "♯ Sharp — tune down" for up to 3 s.
- **Amended:** Design Notes (held readings), and the review fixes listed there.
- **Known-bad state avoided:** the tuner telling the player to detune an in-tune string on every decay.
- **KEEP:** everything in the current tree (it passed full verification): the pure `nextTuner` machine, `readTuner`/`tunedStrings` in recording-session, `MicGate` extraction, the Tuner screen and its tests. The user chose to fix in place instead of reverting; attempt 1 is saved at `_bmad-output/implementation-artifacts/story-2-9-tuner-screen-attempt-1.patch`.

## Design Notes

- **Held readings.** While the last reading is only being held (the latest frame had no pitch), the screen shows the string, needle and cents but no direction words and no In tune. `TunerDisplay` gets `held: boolean` (true when `reading` is kept from an earlier frame).
- **Re-render on whole cents.** The panel's skip-identical check also compares the rounded cents, so the readout never shows a stale whole-cent value.
- **All six announcement.** If the panel unmounts while "All six strings in tune" is still pending, announce it in the cleanup.
- **Tests to add or fix:**
  - e2e: the polite region receives "Low E string in tune" during open_strings, and "All six strings in tune" after the sixth tick. Scope the visible "All six" text check to the panel, so the hidden region doesn't make it ambiguous.
  - e2e "ticks are kept": assert the ticked set at once on return, with a short timeout, so a re-tick can't satisfy it.
  - Machine unit: a pitch change from one string to another reads the new string within 300 ms of 50 ms polls, and a steady in-tune tone stays In tune on every poll after 500 ms.
  - Store unit: the gap test reads within 500 ms after the gap, so the post-gap timing is really exercised.
  - Component: a held reading shows no direction and no In tune.

## Review Triage Log

### 2026-10-02 — Review pass
- verdicts: 26 findings — high 0, medium 1, low 17, false 8, maybe-false 0
- findings:
  - `low` `patch` (verif) the Tuner's announcements are never asserted — e2e polite-region checks added (Design Notes).
  - `low` `patch` (verif) the visible "All six" text check would become ambiguous once the region holds it — scoped to the panel.
  - `low` `patch` (verif) a pending "All six" announcement is lost on unmount — announced in cleanup.
  - `low` `patch` (edge) the skip-identical check compares 0.1 cents, so a whole-cent change can go unrendered — rounded cents compared too.
  - `low` `patch` (edge) "All six" lost on unmount within 1 s — grouped with the cleanup fix.
  - `low` `patch` (edge) the store gap test's 700 ms second gap makes its assertion trivial — the read moves within 500 ms of the last.
  - `low` `patch` (intent) needle settle within 300 ms is not tested — machine unit test added.
  - `low` `patch` (intent) no-flicker on a steady tone is not tested — machine unit test added.
  - `low` `reject` (intent) e2e allows 40 ms of jitter on the 500 ms rule — render jitter; the exact boundary is tested on the machine.
  - `false` `reject` (intent) axe never runs on the live Tuner — it runs live in the Tune first test.
  - `low` `reject` (intent) only the denied error is exercised on the Tuner — the other codes share MicGate, covered by Record's specs.
  - `false` `reject` (intent) "0 cents" before In tune shows no direction — no direction at 0 is correct.
  - `false` `reject` (intent) the MicGate extraction goes beyond the ticket — the plan named it.
  - `false` `reject` (intent) the ticket's unknown is resolved without a decision record — the epic notes already record the decision (readings from recording-session's analyser).
  - `medium` `bad_plan` (blind) a held reading after a fade shows "♯ Sharp — tune down" for an in-tune string — Design Notes amended (held readings carry `held`, no direction or In tune); fixed in place at the user's choice.
  - `low` `reject` (blind) no hysteresis at ±3 cents; re-entry re-announces — the contract's rule ("each once per occurrence").
  - `low` `reject` (blind) the rounded value can read "+3" while In tune — the contract specifies rounded cents and a ±3 raw rule; cosmetic.
  - `false` `reject` (blind) "1 cents" plural — verbatim from the mockup ("−1 cents").
  - `low` `patch` (blind) the "All six" announcement can be lost — grouped with the cleanup fix.
  - `low` `reject` (blind) the screen tests cover only sharp/flat — In tune, no-pitch and chips are covered by e2e; announcements are now added.
  - `low` `reject` (blind) the e2e timing check is lenient after dropouts — the machine tests check the timer restart exactly.
  - `low` `patch` (blind) "ticks are kept" can pass on a re-tick — asserted at once on return.
  - `false` `reject` (blind) ticked chip contrast fails in dark — dark surface #1D1B18 on success #5CC06A is about 8:1.
  - `false` `reject` (blind) ticks can never be cleared — "ticked for the session" is the ticket's wording.
  - `low` `reject` (blind) `tuneEvery` returns `unknown` — test ergonomics only.
  - `false` `reject` (blind) the plan is missing from the diff, and so is the ticket status — the plan is the claims file, and status is set at finalize.

### 2026-10-02 — Review pass (follow-up)
- verdicts: 31 findings — high 0, medium 0, low 26, false 5, maybe-false 0
- findings:
  - `low` `patch` (verif) the "All six after High E" check passes when "High E string in tune" is lost (indexOf -1) — the test now requires all six string announcements.
  - `low` `reject` (verif) `sameDisplay` dedupe is not pinned at 0.1 cents — a render optimisation; it needs fake-timer component tests the suite lacks.
  - `low` `reject` (verif, other) the all-six announcement on unmount is untested — rare path; low.
  - `low` `reject` (intent) settling is tested on the machine, not on screen — carried reasoning: the render adds one poll plus a 50 ms transition.
  - `low` `reject` (intent) In tune timing and no-flicker are checked at the machine, with only a lower bound in e2e — carried: the e2e allows 40 ms of jitter on the 500 ms rule.
  - `low` `reject` (intent) no axe run is guaranteed to cover the In tune state — it adds only a check icon and success text, both in passing contrast.
  - `low` `reject` (intent) signed cents and direction words are tested with a stubbed reading — carried: the screen tests cover only sharp and flat.
  - `low` `reject` (intent) nothing checks the real 50 ms poll rate — the store and machine are driven at 50 ms; low.
  - `low` `reject` (intent) the banner and select on the Tuner are untested there — store-driven components, tested on Record.
  - `false` `reject` (intent) Record's card behaviour after the MicGate refactor is unprotected — mic-errors.dev.spec.ts focus assertions cover it (confirmed by the verification lens).
  - `false` `reject` (intent) the ticket's unknown is resolved by widening recording-session — carried: the decision is in the epic notes.
  - `low` `reject` (blind) "+3 cents" can mean In tune or Sharp — carried: the rounded value can read "+3" while In tune.
  - `false` `reject` (blind) "Sharp — tune down" inside ±3 before 500 ms invites over-correction — tuning from +2 toward 0 improves the tuning; the direction is accurate.
  - `low` `patch` (blind) a held reading looks live — dimmed with a `held` class.
  - `low` `reject` (blind) every re-entry into In tune announces again — carried: no hysteresis; the contract's rule.
  - `low` `patch` (blind) "ticks are kept" can flake when a new tick lands between capture and leaving — subset check instead of equality.
  - `low` `reject` (blind) the e2e bounds In tune only from below — the 15 s chip timeout and the machine tests bound it from above.
  - `low` `reject` (blind) TunerPanel's logic has thin unit coverage — carried: the screen tests cover only sharp and flat.
  - `low` `reject` (blind) MicGate has no direct tests — covered by e2e on both screens.
  - `low` `patch` (blind) after Try again on the Tuner, focus lands on the meter below the panel — the panel is the first focus target.
  - `false` `reject` (blind) `.primary` and the new links have no focus style — theme.css has a global `:focus-visible` outline; the missing hover style is cosmetic.
  - `low` `reject` (blind) both E strings show "E" — the contract specifies "E A D G B E"; DESIGN.md's lowercase "e" is flagged to the user.
  - `low` `reject` (blind) YIN runs on the main thread every 50 ms, and the needle animates `left` — US-2.1 mandates main-thread YIN; CPU budgets belong to the budgets epic.
  - `low` `reject` (blind) constants-restating test, `TUNER_POLL_MS` in audio/, "1 cents" — hygiene; "1 cents" is carried (verbatim from the mockup).
  - `low` `reject` (edge) readout "+3" Sharp between 3 and 3.5 — carried (same as the blind row).
  - `low` `reject` (edge) during a device switch `readTuner` returns null and flashes no-pitch — brief and rare; a new input restarts the tuner anyway.
  - `low` `reject` (edge) a read during goLive's await advances the machine before set() resets it — milliseconds of discarded progress; harmless.
  - `low` `reject` (edge) re-entering within 500 ms while In tune announces again — rare; consistent with once per occurrence.
  - `low` `reject` (edge) all-six can be announced alongside a mic-lost error on unmount — needs the mic lost within 1 s of the sixth tick; rare.
  - `low` `patch` (edge) a hidden tab throttles polling past 500 ms, so every poll resets while detection runs — the poll is skipped when `document.hidden`.
  - `false` `reject` (edge, claim) the e2e accepts In tune at 460 ms — carried: the exact boundary is tested on the machine.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` (repo root, `~/.cargo/bin` on PATH) -- expected: all exit 0
- `grep -rlE '__test|UiTestPage|StorageTestPage|fakeMic' app/dist` -- expected: no output

## Auto Run Result

- **Summary:** `#/tuner` is a working tuner (US-2.1, mockups/tuner.html).
  - recording-session's `readTuner(now)` runs `detectPitch` on the shared analyser every 50 ms and advances a pure machine (`nextTuner`).
  - The screen shows the string, a ±50-cent needle, signed cents with "♯ Sharp — tune down" / "♭ Flat — tune up", In tune after 500 ms within ±3 cents, and six chips ticked for the page session.
  - A held reading (after a note fades, up to 3 s) shows no advice; after that the no-pitch state shows.
  - The setup and error cards moved into a shared `MicGate` used by Record and Tuner. Record gains "Tune first"; Tuner has "Done — go to Record".
  - Announcements go through the shared announcer.
- **Files changed:**
  - `app/src/audio/tuner.ts`: `nextTuner` machine and constants.
  - `app/src/session/recording-session.ts`: `readTuner`, `TunerDisplay`, `tunedStrings`.
  - `app/src/ui/components/MicGate.tsx`, `.module.css`, `buttons.module.css`: shared mic cards, focus swap and the primary button.
  - `app/src/ui/screens/Record.tsx`, `.module.css`: uses MicGate; "Tune first".
  - `app/src/ui/screens/Tuner.tsx`, `.module.css`, `app/src/ui/strings.ts`: the screen and its text.
  - Tests: `app/src/audio/tuner.test.ts`, `app/tests/unit/{recording-session.test.ts,tuner-screen.test.tsx}`, `app/tests/e2e/tuner.dev.spec.ts`.
- **Review:** 26 findings (medium 1, low 17, false 8).
  - The medium was routed `bad_plan`: the held reading after a fade advised "Sharp — tune down" for an in-tune string. The revert was blocked by the permission classifier, so at the user's choice the plan was amended and the fix applied in place; attempt 1 is saved at `_bmad-output/implementation-artifacts/story-2-9-tuner-screen-attempt-1.patch`.
  - 10 low entries patched: announcement e2e checks, the "All six" announcement on unmount, whole-cent re-render, the "ticks kept" test, the store gap test, and settle and no-flicker machine tests.
  - Nothing deferred. Rejections and reasons are in the Review Triage Log.
- **Follow-up review recommended:** true. Patched by verdict: high 0, medium 1, low 10. The `bad_plan` loopback would normally run a fresh review pass. It was fixed in place instead, so the `held` change and the new announcement and cleanup paths have not had an independent review.
- **Verification:**
  - The full plan command exited 0 after the fixes: 452 unit tests and 74 Playwright tests, none flaky.
  - `app/dist` has no dev-only strings.
  - An earlier run had one retry pass on `mic-select` "switch". The implementer saw the same failure on the untouched baseline under load.
- **Residual risks:**
  - open_strings leaves about 250 ms of slack per pluck for In tune, so a heavily loaded machine can miss a tick (about 1 in 30 under repeated parallel runs).
  - The e2e allows 40 ms of render jitter on the 500 ms rule.
  - Chips use "E A D G B E", following the plan; DESIGN.md shows a lowercase high "e".

### Follow-up pass (2026-10-02)

- **Summary:** an independent re-review of the whole story diff, including the in-place held-reading fix from loop 1.
- **Review:** 31 findings (low 26, false 5); none high or medium. Five low entries were patched:
  - the e2e now requires all six "<name> string in tune" announcements before the ordering check;
  - a held reading is drawn in the muted colour;
  - "ticks are kept" checks a subset, not equality;
  - after Try again, focus lands on the tuner panel instead of the meter below it;
  - polling is skipped in a hidden tab.

  Nothing was deferred. Rejections and their reasons are in the follow-up Review Triage Log.
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 0, low 5; the work has converged.
- **Verification:**
  - The full plan command exited 0: 453 unit tests and 74 Playwright tests, none flaky.
  - `app/dist` has no dev-only strings.
- **Residual risks:**
  - Both E strings show "E" (plan); DESIGN.md uses a lowercase "e" for high E.
  - The needle-dedupe resolution is untested.
  - Pitch detection runs on the main thread, with no measured cost (budgets epic).
