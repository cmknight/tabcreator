---
epic: epic-mic-and-tuner
date: 2026-10-02
verdict: accepted-with-open-items
criteria: declared
headless: false
---

# Retrospective: Mic and tuner (epic 2)

## Epic summary

- **Epic:** `epic-mic-and-tuner` (id 2). The user selected it interactively, with no extra focus weighting.
- **Tickets:** all ten are `done` (`tickets.py status`). None is still at `built`, none is unfinished, and `pending_tickets` is empty.

| Ref | Title | Plan | Range (baseline → next baseline) | Commits |
|-----|-------|------|----------------------------------|---------|
| 2.1, 2.2, 2.4 | Tracer, fake mic, tuner core | three plans | `59b6d9c..cc4ef32` (shared baseline; the stories were built concurrently in one tree) | 5b876a7, e6b9bdb, e5700b3, cc4ef32 |
| 2.3 | Announcer and toast | story-announcer-and-toast-plan.md | `cc4ef32..8a28bf7` | cd91c52, 8a28bf7 |
| 2.5 | Mic errors and recovery | story-mic-errors-and-recovery-plan.md | `8a28bf7..230035d` | f57dbf7, 230035d |
| 2.6 | Level meter with warnings | story-level-meter-with-warnings-plan.md | `230035d..71acac3` | e864802, 17119e8, bcb0ed8, 71acac3 |
| 2.7 | Choose the microphone | story-choose-the-microphone-plan.md | `71acac3..796cf4c` | 5e06405, c4312fb, 796cf4c |
| 2.8 | Input quality warning | story-input-quality-warning-plan.md | `796cf4c..bdd8fa6` | c4ca3e9, bdd8fa6 |
| 2.9 | Tuner screen | story-tuner-screen-plan.md | `bdd8fa6..79cd8a4` | 2723eb3, eefe976, 79cd8a4 |
| 2.10 | Refactor sweep | story-refactor-sweep-plan.md | `79cd8a4..6bc5514` (HEAD; inferred, not recorded) | 17acee0, 6bc5514 |

- **Whole epic:** `59b6d9c..6bc5514`, 22 commits, 0 merges, so there is no unmeasured merge churn and no binary revisions.

**Evidence inventory**

- **Available:**
  - the epic file, with its Done when 1–4;
  - all ten entries;
  - ten plans, each with a baseline, a Review Triage Log and Verification, and Plan Change Logs where they were used;
  - `git_evidence.py` JSON per range.
- **Story files:** none. No ticket was refined.
- **Session logs:**
  - this conversation is the record for 2.8, 2.9 and 2.10;
  - no session logs were found for 2.1–2.7, so the process-lesson analysis for those stories rests only on their plans and commits.
- **Previous retrospective:** none. `epic-platform-baseline` has no `-retrospective.md` file.

## Findings

Sources: the aggregate views (two delegated derivations, then spot-checked against `6bc5514`) and the diff-scope review (`bmad-review`: adversarial, edge-case and verification-gap lenses over `59b6d9c..6bc5514`, `app/` only, weighted to ticket boundaries). Every finding below was re-checked against the file it cites. Each carries two dispositions: what to do with this instance (fix now / defer / accept), and what would prevent the next one.

### Architecture delta

- **No layering violations.** The import graph at HEAD has no `ui→audio`, `ui→storage` or `model→*` edges and no cycles (madge, before and after). No browser audio API is used outside `audio/`, and no `aria-live` outside `ui/a11y/` (grep; ESLint `eslint.config.js:74-81`). Checked and clean.
- **AD-3 store scope is outgrown and the decision is not recorded in the spine.** `recording-session.ts` writes prefs (`:19-20`, `:323-347`), although AD-3 names `settings-session` as the prefs store. It also owns tuner state (`readTuner`, `tunedStrings`: `:249-264`), which AD-3 does not list. Both are recorded only in a code comment and the epic Notes. → **Spec reconciliation (A6).** Prevent: when a story places state outside its spine store, add a spine amendment to that story's tasks.
- **AD-18 says "the single live region"; the announcer renders two** (polite and assertive, `ui/a11y/announcer.ts:53,58`). This is intended, as the file's own comment says. → **Accept; reconcile the wording (A6).**
- **`dev/` has no ESLint layer rule** (`eslint.config.js:22-37`), yet the epic added a `dev→ui` edge. → **Defer** (low).

### God-class / size growth

- **`app/src/session/recording-session.ts` is a god-class candidate.**
  - **Size:** 489 lines holding 9 concerns: store plumbing, mic lifecycle, devices and fallback, prefs, levels, input quality, tuner, re-exports, and dependency wiring.
  - **Surface:** a 9-member interface, 11 closure `let` variables, and 7 UI consumers.
  - **Growth:** every feature story except 2.3 grew it (88 → 489 lines; 2.7 alone added 203). The 2.10 sweep left it untouched.
  - **Coupling:** one `set()` (`:192-231`) must reset level, tuner and quality state on every transition.
  - **What's next:** AD-3 still routes recorder, count-in and the recovery scan into this same store.
  - → **Fix now (A1)**, before the Recording epic starts. Prevent: give a store-touching story a size and concern check in its plan (e.g. "does this add a concern to a store?").
- The `tests/unit/recording-session.test.ts` file has grown to 998 lines, matching the store. → Follows A1.
- **Not candidates:** `fake-mic.ts` (333 lines, dev-only, 4-method surface), `Tuner.tsx` (252), `mic.ts` (211). `Record.tsx` had high churn but its net change is +19, because its code moved into components.

### Duplication map

- **The 2.10 sweep dropped two items that earlier triage logs had routed to it.** Both are still in the code:
  - a second RMS-dBFS helper: `audio/tuner.ts:33 rmsDbfs` vs `audio/level-meter.ts:12 levelsDbfs` (2.6 triage: "refactor sweep scope");
  - the nested dev-page ternary in `App.tsx:44-50` (2.3 triage: "refactor sweep scope").

  → **Defer to the next sweep (A5).** Prevent: a sweep's scope step must grep every plan's triage log for "sweep" routings (A7).
- **Other duplication:**
  - The warning icon SVG is copied verbatim in `LevelMeter.tsx:30-43` and `InputQualityBanner.tsx:7-20`.
  - Banner layout is duplicated in `InputQualityBanner.module.css:3-24` vs `Settings.module.css:1-22`.
  - The 4096 window constant appears twice: `mic.ts:8` and `tuner.ts:10`.
  - Signed-number formatting with U+2212 is written four times.

  → **Defer (A5).**
- **e2e helpers:**
  - `collectErrors` is byte-identical in 10 specs (7 of them new this epic). `goLive` exists in three variants.
  - There are two getUserMedia instrumentations: `mic-helpers.ts` and the local `recordGum` in `mic-select.dev.spec.ts:44-71`.
  - The `meter` locator is redefined in 5 specs, and a MutationObserver live-region probe is written 3 times.

  → **Defer (A5).** Prevent: when a second spec needs a helper, it moves into `mic-helpers.ts`.
- **Five announce-on-transition implementations in three patterns:**
  - an in-component ref plus effect;
  - shell `subscribe` watchers (`MicErrorAnnouncer`, `MicNotices`);
  - poll-local tracking in `Tuner.tsx`.

  AD-18 says "stores emit announceable events", but only `MicNotice.seq` does. → **Defer**, and fold into A2.
- **Focus hand-off is solved four ways:** `data-focus-target` in MicGate, the closest-`section` h1 in `InputQualityBanner.tsx:55`, ToastHost's `returnTo`, and per-screen h1 `tabIndex`. → **Accept for now** (each is tested); record it as a convention candidate.

### Pattern divergence

- **Unit-test location is mixed.** `src/audio/tuner.test.ts` is colocated; every other epic unit test is in `tests/unit/`. Both styles predate the epic. → **Defer**: pick one convention (A7).
- **Shared code still uses `record.*` string keys.** MicGate is now on the Tuner but still reads `record.micSetupTitle` etc. (`MicGate.tsx:98`), although 2.6 re-keyed the shared meter to `global.*`. The mic-error keys also break AD-12's `<screen|global>.<camelCase>` shape (`strings.ts:57-87`). → **Defer (A5).**
- **The two pure machines sit in different layers.** `nextTuner` is in `audio/tuner.ts:161`; its sibling `nextWarning` is in `model/level-warnings.ts`. A UI poll constant also lives in audio/ and reaches ui/ through a session re-export (`recording-session.ts:53`). → **Accept** (the spine CAP table assigns `audio/tuner.ts`); note it for A1.
- **Small token and layout drift:**
  - Scale labels are 12px in `LevelMeter.module.css:66` but 13px in `Tuner.module.css:92`.
  - `gap: 6px` (`Tuner.module.css:125`) is off the spacing scale.
  - `InputQualityBanner` uses physical `border-left`; MicGate uses logical properties.

  → **Defer (A5).**

### Spec-to-implementation reconciliation

- **Done when 1–4 are met in the evidence;** see Acceptance verdict.
  - One gap: the production no-prompt check covers Record only. `#/tuner` is checked only in dev (`tuner.dev.spec.ts:89-98`).
  - → **Defer (A4)**: add a `#/tuner` row to `mic-setup.spec.ts`.
- **DESIGN.md:242 asks the level meter for "a current dBFS readout"; the as-built has the unit text only** (`LevelMeter.tsx:113-117`). The Tuner mockup shows one (`tuner.html` "−22 dBFS"), and no plan records the omission. → **Spec reconciliation (A6)**: build it or amend DESIGN.md.
- **US-1.3 says `fftSize 2048`; the as-built shares one 4096 analyser** (`mic.ts:8`). The epic Notes record 4096 but never name the conflict. → **A6.**
- **US-1.1 acceptance asks for track-settings evidence that processing is off; only the request constraints are verified.** The 2.1 triage rejected it, but the epic Notes don't record it. → **A6.**
- **The return-visit gate is stricter than the epic Notes decision.** It needs `micGranted` and the `granted` permission (`recording-session.ts:448-455`); the Notes say "only when … granted". → **A6**: update the Notes.
- **2.10 added `--radius-*` and `--size-control` tokens; AD-12 lists only `--color-`, `--font-` and `--space-`.** → **A6.**
- **Chip letter:** DESIGN.md says "E A D G B e"; the as-built shows "E" twice. → **Owner decision, open since 2.9 (A6).**
- **Moved out by recorded decisions:** CAP-2's "select disabled while recording" and CAP-26's "unplug mid-take keeps the audio" both go to the Recording epic (epic Notes). → **Accept.**

### Diff-scope review (cross-ticket)

1. **Same-frame announcements cancel each other.** `announce` cancels the pending rAF message on the same region (`announcer.ts:36-39`).
   - **Example:** an unplug fallback to a headset fires the 2.7 switch toast (announced by ToastHost) and the 2.8 banner announcement in one commit. Only one is spoken.
   - Tuner works around this for "All six" with `ALL_SIX_DELAY_MS`, a symptom of the same root.
   - Adversarial #5 and edge-case #4/#5. → **Fix now (A2).** Prevent: test cross-ticket announcements together.
2. **A shared `busy` boolean races between `selectMic` and `ended`.**
   - **Trigger:** a newly selected track ends during `goLive`'s `await listDevices()`. `ended` sets `busy`, and then `selectMic`'s `finally` clears it mid-fallback (`recording-session.ts:369-392`, `:408-439`).
   - **Result:** a second choice can then race the fallback. The loser's `!holds` return never closes its stream, so the mic stays captured.
   - The window is narrow but the leak is a privacy indicator.
   - Adversarial #1/#2, edge-case #1, verification-gap #6. → **Fix now (A3).**
3. **No tests where flows cross.** There is no test of a select during the unplug fallback, a track ending during a switch, or an unplug while `requesting` (`recording-session.test.ts` 545-712). → **Fix now (A3).**
4. **`set()`'s level/tuner reset on live→live switches is untested.** Every reset test passes through `error`. Moving the reset under `if (!live)` would ship green, and stale Too loud or a cross-device In tune tick would follow. → **Fix now (A4).**
5. **The quality banner on the Tuner is untested:** not that it shows, not its announcement, not that Dismiss focuses the Tuner h1 (`Tuner.tsx:74-75`). 2.8 deferred the mount to 2.9, which added no row for it. → **Fix now (A4).**
6. **Pending "All six" announced on unmount is untested.** It can also fire beside a mic-lost error when MicGate swaps the panel (`Tuner.tsx:140-144`). → **Fix now (A4)**: test it and only announce when still live.
7. **Unresolved active device names the toast "Microphone 1".** When the active id isn't listed, `findIndex(...)+1 || 1` (`MicNotices.tsx:19`) yields "Microphone 1", which may name a different device. → **Defer** (low).
8. **The Tuner silence gate and the meter's Too quiet threshold disagree.** The tuner reads down to −50 dBFS (`tuner.ts` `SILENCE_DBFS`), while Too quiet fires below −45 (`level-warnings.ts:11`). A string played around −48 dBFS shows Too quiet while the tuner reads it correctly. → **Defer** (low).
9. **At ≥ about 117 kHz AudioContext rates, `detectPitch` always returns null.** At 192 kHz, w = 1352 < tauMax = 2743 (`tuner.ts:49-51`), and no warning is shown. → **Defer** (rare hardware).
10. **Dismissing the quality warning lasts the session, across involuntary fallbacks.** → **Accept**: this is the 2.8 contract (EXPERIENCE.md:86, "hides it for the session").
11. **A failed `selectMic` leaves the error card instead of reverting.** → **Accept** (2.7 rule; rejected in 2.7 triage).
12. **The label pattern also matches wired "Headset" devices.** → **Accept**: the regex is verbatim from US-1.2.
13. **No control releases the mic, so the capture indicator stays on across screens.** → **Defer**: this is a feature. Proposed for the Settings or Recording epics.
14. **Claimed: after a no-gesture return visit the AudioContext stays suspended, so the meter is silent and the tuner dead (adversarial #3, edge-case #3).** → **Refuted by the behavior check below.**
15. **Claimed: mobile and OS audio interruption is unhandled.** → **Accept, out of target** (NFR-08: desktop Chrome).
16. **mic-select switch/unplug flakiness is masked by CI `retries: 1`.** → **Addressed** by `17acee0` (S7: 40/40 under load). The unplug test was not measured separately. → **Defer** a `--repeat-each` check of the unplug row (A4).

### Record-keeping

- The 2.5 plan has no Auto Run Result and empty Implementation Notes.
- The 2.2 plan has five unchecked task boxes at `status: done`, and its Review Triage Log sits under Verification (2.2 plan line 97).
- The 2.10 Always says the frontmatter `deferred` holds every deferral, but four live only in its Auto Run Result.
- The epic file still says `status: in-progress`, as expected; closing it is the ticketing skill's job.

→ **Process lesson (A7).**

### Process

- **Concurrent builds in one tree (2.1, 2.2 and 2.4)** narrowed 2.4's reviewed diff to the tuner files (2.4 residual) and mixed uncommitted work (2.2 residual). → **A7**: build stories one at a time, or in worktrees.
- **2.9's `bad_plan` revert was blocked** by the permission classifier (this session). It was fixed in place by user choice and re-reviewed in a follow-up pass that found no medium or high issues. → **A7**: give the build-auto workflow a non-destructive revert path (e.g. stash or branch).
- **Every dev e2e runs with `--autoplay-policy=no-user-gesture-required`** (`playwright.config.ts:48`), so no automated test exercises the real policy. The probe below did, once. → **A4**: add a production-project test with Chrome's native fake device.
- **Session logs exist for 2.8–2.10 only.** The process analysis for 2.1–2.7 is narrowed to their plans and commits.

## Behavior verification

**Exercised end to end:** the production build (`vite preview`, `dist/` from the 2.10 verification) in headless Chromium, using Chrome's native fake capture device (`--use-fake-device-for-media-stream`), not the app's dev fake mic. The probe script is `scratchpad/retro/behavior-probe.mjs`. It ran twice, once under the default policy and once under `--autoplay-policy=document-user-activation-required`.

| Step | Default policy | User-activation policy |
|------|----------------|------------------------|
| Record → Allow microphone (click) → meter max | −10 dBFS | −10 dBFS |
| Reload, no gesture → went live by itself | yes | yes |
| Meter max over 4 s after the reload | −10 dBFS | −10 dBFS |
| "Too quiet" shown after the reload | no | no |
| Console errors or warnings | none | none |

**Observed:**
- The return-visit resume works under a real autoplay policy, and the AudioContext runs without a gesture. This refutes finding 14.
- The full dev e2e suite passed at `6bc5514` (2.10 verification: 459 unit, 76 Playwright, none flaky). It covers the device, error, quality and tuner flows with the dev fake mic.

**Not exercised:**
- real microphones, Bluetooth headsets and real guitars (the open hardware deferrals);
- Safari and Firefox (not targets);
- the Tuner under the native fake device, whose beep is outside the tuner's 70–400 Hz range.

## Previous-retro follow-through

There is nothing to follow through on. The previous epic (`epic-platform-baseline`) has no retrospective file at all, not merely an empty Action items section.

## Action items

These are proposed; none were applied. The human decides what runs, and the dev loop executes it.

| # | Action | Kind | Owner | Source findings |
|---|--------|------|-------|-----------------|
| A1 | **First story of the Recording epic (user decision).** Split `recording-session.ts` before the Recording epic adds recorder, count-in and the recovery scan. Move the derivations (input quality, tuner reading and ticks, level warnings) into their own modules or a tuner store behind the same snapshot. Keep `set()` to mic-transition concerns. | Remediation (refactor story at the start of the Recording epic) | Dev (Amelia), with the architect (Winston) for the store boundary | God-class; AD-3 delta |
| A2 | Make `announce` queue polite messages, appending or flushing in order, instead of cancelling a same-frame message. Then drop Tuner's `ALL_SIX_DELAY_MS` workaround, and add a test where the switch toast and the quality banner fire together. | Remediation | Dev | Diff-scope 1, 6 |
| A3 | Serialise input transitions (allow, switch, fallback) with an owner token or a promise queue, and close any opened input that loses the race. Add interleaving tests: a select during the fallback, a track ending during a switch, an unplug while requesting. | Remediation | Dev | Diff-scope 2, 3 |
| A4 | Fill the cross-story test gaps:<br>• the `set()` reset on live→live switches;<br>• the quality banner on the Tuner, with Dismiss focusing the Tuner h1;<br>• "All six" on unmount, announced only while live;<br>• a `#/tuner` no-prompt row in `mic-setup.spec.ts`;<br>• a production-project test with the native fake device under the real autoplay policy;<br>• a `--repeat-each` stability check of the mic-select unplug row. | Remediation (tests) | Dev | Diff-scope 4, 5, 6, 16; spec Done when 1; Process |
| A5 | Next sweep:<br>• one RMS-dBFS helper;<br>• the `App.tsx` dev-page ternary;<br>• a shared `WarnIcon` and banner styles;<br>• one 4096 constant;<br>• `global.*` keys for the shared mic card;<br>• e2e helpers (`collectErrors`, `goLive`, meter locator, live-region probe) moved into `mic-helpers.ts`;<br>• scale-label size and spacing tokens;<br>• `MicNotices` "Microphone 1" fallback;<br>• Tuner silence vs Too-quiet thresholds;<br>• a `dev/` ESLint layer. | Remediation (sweep) | Dev | Duplication; pattern divergence; diff-scope 7, 8 |
| A6 | Spec reconciliations for a human to apply:<br>• AD-3: recording-session writes mic prefs and owns tuner state.<br>• AD-18 wording: two regions.<br>• AD-12: the `--radius-*` and `--size-control` families.<br>• ~~DESIGN.md:242 meter dBFS readout~~: dropped, DESIGN.md amended 2026-10-02.<br>• US-1.3 fftSize 2048 → 4096.<br>• US-1.1: request constraints as the processing-off evidence.<br>• Epic Notes: the return-visit gate needs `micGranted` too.<br>• ~~The chip letter~~: "E", DESIGN.md amended 2026-10-02. | Spec reconciliation | Architect (Winston) and UX (Sally) for DESIGN; product owner for the chip letter | Spec reconciliation; architecture delta |
| A7 | Process:<br>• A sweep's scope step greps every plan's triage log for "sweep" routings, and puts every deferral in its frontmatter.<br>• Pick one unit-test location.<br>• Build stories one at a time or in worktrees.<br>• Give bmad-build-auto a non-destructive revert for `bad_plan` (stash or branch).<br>• Finish each plan's Auto Run Result and task boxes before marking it done. | Process lesson | Product owner (workflow), with the dev | Duplication (dropped sweep items); record-keeping; process |

**Still deferred and tracked** (no action this cycle):
- The 2.8 rate re-read on call-mode drops (needs a Bluetooth headset).
- The 2.4 YIN partial dropout (needs a real guitar).
- 192 kHz tuner rates.
- The 2.5 OS-level block copy.
- The 2.3 toast action reach.
- A mic release control.
- The tuner In tune slack in the fixture.
- Main-thread pitch cost (budgets epic).

## Acceptance verdict

**Machine verdict: accepted-with-open-items.** The criteria are **declared** (the epic file's Done when 1–4).

| Done when | Evidence | Met |
|-----------|----------|-----|
| 1. On the production build, no prompt or getUserMedia call happens before Allow microphone. On the dev build with the fake mic, each error shows its message with a Try again that works without reload. | `mic-setup.spec.ts:5,20` (production, Record); `mic-errors.dev.spec.ts:142,267`; `tuner.dev.spec.ts:163`; the behavior probe (production) | Yes. Gap: the production `#/tuner` row (A4). |
| 2. With two inputs the player can switch mics, and unplugging the active one falls back with a notice. | `mic-select.dev.spec.ts:98,116,148,188`; owner real-hardware check (epic Notes, 2026-10-02) | Yes |
| 3. Too loud within 200 ms on `level_too_hot`; Too quiet after 3 s on `silence_60s`; a Bluetooth-like or < 44.1 kHz input shows its warning. | `level-meter.dev.spec.ts:90,113`; `input-quality.dev.spec.ts:61,111` | Yes. The Too loud bound is measured from the meter appearing, including the fixture's lead-in (noted). |
| 4. The tuner reads synthetic tones within ±1 cent and ticks all six strings on `open_strings`. | `tuner.test.ts` accuracy table (worst case 0.049 cents, 2.4 notes); `tuner.dev.spec.ts:85` | Yes |

- **Tickets:** all ten tickets are finished (`pending_tickets` is empty).
- **Blocking findings:** none. The open items are A1–A5, the A6 reconciliations, and the hardware deferrals.
- **Why open items:** the god-class growth (A1) and the cross-ticket announcement and race defects (A2, A3) are real. They don't break a Done-when criterion, so they make this verdict "accepted-with-open-items", not "rejected".

**Human decision (2026-10-02): accepted.** The user accepted the epic with these open items.
- **A1:** the store split becomes the first story of the Recording epic.
- **DESIGN.md meter readout:** dropped. DESIGN.md:242 now reads "the unit "dBFS" (no numeric readout)", which matches the as-built `LevelMeter`.
- **Chip letter:** both E strings show "E". DESIGN.md:262 is amended to "E A D G B E", with "Low E" and "High E" in the accessible names, matching the as-built.

## Open questions

Resolved by the user (2026-10-02): A1's timing (the first story of the Recording epic), the meter readout (dropped from DESIGN.md), and the chip letter ("E").

Still open:
- **Unverifiable here:** real-device behaviour (Bluetooth call-mode rate drops, real guitar partials, `default` device aliasing beyond the owner's one unplug test).
- **The remaining A6 spec reconciliations:** AD-3, AD-18 wording, AD-12 token families, US-1.3 fftSize, US-1.1 evidence, and the epic Notes return-visit gate. These still need a human to apply them.
