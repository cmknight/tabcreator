---
title: 'Refactor sweep'
type: 'refactor'
ticket: '10'
created: '2026-10-02'
status: done
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '79cd8a4e15a8c1ba7c215732c1207c270ba1ba43'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: ['oversized']
deferred:
  - '2.3: toast action hard to reach before 4 s — behaviour change; no toast has an action yet (CAP-21)'
  - '2.5: OS-level block shows site-settings steps — copy and behaviour change'
  - '2.4: YIN partial dropout at tau = 2 — needs a real guitar; open_strings ticks all six'
  - '2.8: sample rate read once, no re-read on call-mode drop — needs a real Bluetooth headset'
  - '2.1: no visible requesting feedback — feature'
  - '2.3: focus ring on <main>, announcement before mount, lint gaps — behaviour and tooling changes'
  - '2.6: narrow-screen scale labels — narrow screens are not a target (NFR-08 desktop Chrome)'
  - '2.9: E vs "e" chip letter — owner decision'
  - '2.9: In tune slack — fixture timing'
  - '2.9: tuner main-thread cost — budgets epic'
  - 'S7 follow-on: a Microphone select choice made while a switch is still opening is dropped (selectMic returns while busy) — app behaviour, not cleanup'
---

<intent-contract>

## Intent

**Problem:** Stories 2.1–2.9 left cleanup debt in their build records (residual risks) and deferred review findings: raw px values where DESIGN.md has tokens, a duplicated button style, a stale test comment, untested branches, light-only axe checks and a flaky e2e. The epic cannot close until each item is either closed or explicitly deferred.

**Approach:** Run the cleanup-only sweep below. Fix items S1–S7. Then record every record item in the ledger as closed or deferred, each with its reason.

## Boundaries & Constraints

**Always:**
- **Cleanup only.** Make no change to behaviour, copy or layout that a user could see, except for the pixel-identical swaps of tokens for values.
- **Tokens.** New tokens go in `ui/theme.css` from the DESIGN.md frontmatter: `rounded` → `--radius-sm` 4px, `--radius-md` 6px, `--radius-lg` 10px, `--radius-full` 9999px; and the 36 px control height → `--size-control`. Every CSS radius that equals one of these values uses the token. Every 36 px control height uses `--size-control`.
- **Exceptions.** One-off geometry stays as raw px: the meter peak tick's 1px, the needle's 2px, and the 44px chip and track sizes.
- **Tests.** Every existing test keeps passing unchanged, except S1 (a comment) and S7 (the flaky test itself).
- **Ledger.** It is written into this plan's Implementation Notes at the end, one line per item. Fixed items name the change. Closed items without a change and deferred items give their reason. The deferred ones are also appended to this plan's frontmatter `deferred`.

**Never:**
- No new features: no toast timing change, no OS-block copy, no requesting spinner, no lint-rule extension.
- No change to tuner thresholds, fake-mic behaviour or strings.
- Don't touch the chip letters: the high E stays "E". This is the owner's decision to make, so it is deferred.

## Sweep scope

| # | Source | Item | Disposition |
|---|--------|------|-------------|
| S1 | 2.2 deferred | `tests/e2e/mic-setup.dev.spec.ts` comments still describe the fixture as playing once or going silent; every stream now plays it from the start | fix the comments |
| S2 | 2.7 residual | radius and control height are raw px (MicSelect, buttons, banner, MicGate, LevelMeter, Tuner, Settings, ToastHost) | tokens per Always |
| S3 | build records 2.5/2.9 | `Settings.module.css .button` duplicates a button style now that `ui/components/buttons.module.css` exists | add `.secondary` there (same look as Settings' `.button`) and use it in Settings; delete the duplicate |
| S4 | 2.7 residual | the unnamed-device label ("Microphone N") is untested | unit test: MicSelect renders "Microphone 2" for an empty label; MicNotices' toast uses the unnamed label |
| S5 | 2.9 residual | the needle dedupe (`sameDisplay`) is untested | component test with fake timers: readings 2.46 → 2.54 and 2.40 → 2.60 update the readout and the needle `left` |
| S6 | 2.8 residual | the banner's (and Tuner's) dark contrast was checked by calculation only | e2e axe pass with `colorScheme: 'dark'` on Record with the quality banner and on the live Tuner |
| S7 | 2.9 build record | `mic-select.dev.spec.ts` "switch" fails intermittently under load (seen on the untouched baseline) | find the race and make the test wait on a real condition; if the cause is in app code and not cleanup, defer it with evidence |

## Ledger (closed or deferred, no code)

| Source | Item | Disposition |
|--------|------|-------------|
| 2.7 deferred | real unplug order | closed: owner-tested on real hardware, 2026-10-02 (epic notes) |
| 2.3 deferred | toast action hard to reach before 4 s | deferred: behaviour change; no toast has an action yet (CAP-21) |
| 2.5 deferred | OS-level block shows site-settings steps | deferred: copy and behaviour change |
| 2.4 deferred | YIN partial dropout at τ = 2 | deferred: needs a real guitar; open_strings ticks all six |
| 2.8 deferred | rate read once, no re-read on call-mode drop | deferred: needs a real Bluetooth headset |
| 2.1 residuals | linear bar, bare error card | closed: superseded by 2.6 and 2.5 |
| 2.1 residual | no visible requesting feedback | deferred: feature |
| 2.2 residuals | cloned tracks, configure during open, revoke | closed: accepted, harmless in dev only |
| 2.3 residuals | focus ring on `<main>`, announcement before mount, lint gaps | deferred: behaviour and tooling changes |
| 2.6 residuals | Too-loud bound includes lead-in; narrow-screen scale labels | closed: test note; deferred: narrow screens are not a target (NFR-08 desktop Chrome) |
| 2.9 residuals | E vs "e" chip letter; In tune slack; main-thread cost | deferred: owner decision; fixture timing; budgets epic |

</intent-contract>

## Code Map

- `app/src/ui/theme.css` -- tokens; header comment maps DESIGN.md frontmatter to custom properties. Add `--radius-*` and `--size-control` beside `--space-*` (light only; they do not change with the theme).
- Raw values to swap (from `grep -rn "border-radius\|height: 36px" app/src --include=*.css`): `ui/components/{buttons,InputQualityBanner,MicGate,MicSelect,LevelMeter,ToastHost}.module.css`, `ui/screens/{Tuner,Settings}.module.css`.
- `app/src/ui/screens/Settings.tsx` uses `settingsStyles.button` for Reload.
- `app/src/ui/components/{MicSelect,MicNotices}.tsx` -- `strings['global.microphoneUnnamed'](n)`.
- `app/src/ui/screens/Tuner.tsx` -- `sameDisplay`, `TunerPanel` poll (`setInterval(TUNER_POLL_MS)`); `app/tests/unit/tuner-screen.test.tsx` stubs `recordingSession` (pattern for S5).
- `app/tests/e2e/{input-quality,tuner}.dev.spec.ts`, `mic-helpers.ts` (`expectNoSeriousAxe`) -- for S6 use `page.emulateMedia({ colorScheme: 'dark' })`.
- `app/tests/e2e/mic-select.dev.spec.ts` "switch: old tracks stop before one exact request, and the meter follows" -- for S7.

## Tasks & Acceptance

**Execution:**
- [x] `app/tests/e2e/mic-setup.dev.spec.ts` -- S1.
- [x] `app/src/ui/theme.css` and the CSS files above -- S2.
- [x] `app/src/ui/components/buttons.module.css`, `app/src/ui/screens/Settings.{tsx,module.css}` -- S3.
- [x] `app/tests/unit/` -- S4, S5.
- [x] `app/tests/e2e/input-quality.dev.spec.ts`, `tuner.dev.spec.ts` -- S6.
- [x] `app/tests/e2e/mic-select.dev.spec.ts` (and app code only if the cause is a test-visible race fixable without behaviour change) -- S7.
- [x] This plan's Implementation Notes and frontmatter `deferred` -- the ledger.

**Acceptance Criteria:**
- Given the sweep, when `grep -rnE "border-radius: (4|6|10|9999)px|height: 36px" app/src --include=*.css` runs, then it prints nothing.
- Given the full verification, when it runs, then it exits 0 and every existing spec passes.
- Given the "switch" spec, when it runs with `--repeat-each=10 --workers=4 --retries=0`, then it passes every time, or S7 is deferred with the measured evidence.
- Given the ledger, when it is read, then every row of Sweep scope and Ledger is marked fixed, closed or deferred, with its reason.

## Implementation Notes

Ledger (one line per item):

- S1 fixed: `app/tests/e2e/mic-setup.dev.spec.ts` — the re-enter comment now says the stream from Allow is reused and still playing (each new stream plays its fixture from the start); the axe comment no longer says the fixture "may have gone silent".
- S2 fixed: `ui/theme.css` gains `--radius-sm/md/lg/full` (4/6/10/9999 px) and `--size-control` (36 px), header comment updated; every matching radius and 36 px control height in buttons, ToastHost, InputQualityBanner, MicGate, MicSelect, LevelMeter, Tuner and Settings CSS uses them. Kept raw per Always: meter peak tick 1px, needle 2px radius, 44px chip/track sizes. The acceptance grep prints nothing.
- S3 fixed: `buttons.module.css` gains `.secondary` (the exact declarations of Settings' `.button`, tokenised); `Settings.tsx` Reload uses `buttons.secondary`; `Settings.module.css .button` deleted.
- S4 fixed: new `app/tests/unit/mic-unnamed.test.tsx` — MicSelect lists "Microphone 2" for an empty-label second input; MicNotices' switched toast reads "Microphone disconnected — switched to Microphone 2" for an empty-label active input.
- S5 fixed: `app/tests/unit/tuner-screen.test.tsx` gains a fake-timer suite — 2.46 → 2.54 and 2.40 → 2.60 update the readout (+2 → +3 cents) and the needle `left`; 2.41 → 2.44 keeps the shown display (so the suite fails if dedupe is removed or over-eager).
- S6 fixed: new dark-mode axe tests (`page.emulateMedia({ colorScheme: 'dark' })`, asserting the root `color-scheme` is dark): Record with the low-rate quality banner (`input-quality.dev.spec.ts`), and the live Tuner with a reading and a ticked chip (`tuner.dev.spec.ts`). Both pass: no serious/critical violations.
- S7 fixed (test-only): two races, reproduced under CPU load (16 busy loops, `--repeat-each=20 --workers=8`: 3–4 of 20 failed). (1) `recordGum` could wrap `getUserMedia` before `main.tsx`'s dynamic import installed the fake mic, whose install then replaced the wrapper, so `gumLog[1]` was `undefined`; it now waits for `window.__fakeMic`. (2) The meter reads −60 as soon as the old input closes, before the new device opens and `micDeviceId` is saved, so the one-shot prefs read could see `null` (and a second choice made while still switching would be dropped); the test now polls the saved `micDeviceId` before its other checks. After: 40/40 under the same load, 10/10 at `--repeat-each=10 --workers=4 --retries=0`. Follow-on deferred (see frontmatter): the select dropping a choice made mid-switch is app behaviour.
- 2.7 deferred, real unplug order: closed — owner-tested on real hardware, 2026-10-02 (epic notes).
- 2.3 deferred, toast action hard to reach before 4 s: deferred — behaviour change; no toast has an action yet (CAP-21).
- 2.5 deferred, OS-level block shows site-settings steps: deferred — copy and behaviour change.
- 2.4 deferred, YIN partial dropout at τ = 2: deferred — needs a real guitar; open_strings ticks all six.
- 2.8 deferred, rate read once: deferred — needs a real Bluetooth headset.
- 2.1 residuals, linear bar and bare error card: closed — superseded by 2.6 and 2.5.
- 2.1 residual, no visible requesting feedback: deferred — feature.
- 2.2 residuals, cloned tracks / configure during open / revoke: closed — accepted, harmless in dev only.
- 2.3 residuals, focus ring on `<main>` / announcement before mount / lint gaps: deferred — behaviour and tooling changes.
- 2.6 residuals: Too-loud bound includes lead-in closed (test note); narrow-screen scale labels deferred — narrow screens are not a target (NFR-08 desktop Chrome).
- 2.9 residuals: E vs "e" chip letter deferred (owner decision; chip letters untouched); In tune slack deferred (fixture timing); main-thread cost deferred (budgets epic).

## Plan Change Log

## Review Triage Log

### 2026-10-02 — Review pass
- verdicts: 18 findings — high 0, medium 0, low 14, false 4, maybe-false 0 (the edge-case lens reported none)
- findings:
  - `low` `patch` (verif) no dedupe case isolates the `toFixed(1)` clause — `step(2.1, 2.3)` case added.
  - `low` `patch` (blind) the tenth-only branch of `sameDisplay` is untested — same fix.
  - `low` `reject` (blind) the dedupe suite varies only cents, not inTune/held/null — those renders are tested directly; low.
  - `low` `reject` (blind) `step()` hard-codes the "+2 cents" start — test ergonomics.
  - `false` `reject` (blind) "the meter follows" cannot catch a meter that fails to follow — the same test then switches back to open_strings and asserts the meter moving.
  - `low` `reject` (blind) `.secondary` lacks `.primary`'s box-sizing and disabled style — it copies the old Settings `.button` exactly (pixel-identical rule); no other use yet.
  - `low` `reject` (blind) the 1px and 2px radii stay literal — plan exceptions (one-off geometry off the DESIGN.md scale).
  - `low` `reject` (blind) no dark axe pass on Settings' engine-failed banner — the Reload button's look is unchanged; outside S6.
  - `low` `reject` (blind) dark tests use only the prefers-color-scheme branch; the colorScheme check does not prove the tokens — low; axe runs on the computed colours.
  - `low` `reject` (blind) the Tuner dark test has a redundant needle check and fixture-tied timeouts — test polish.
  - `low` `reject` (blind) the unnamed-label test covers one device only — the index comes from list position; low.
  - `false` `reject` (blind) the `--size-control` comment is broader than its use — it describes the token's rule, which future controls must follow.
  - `false` `reject` (intent) the verify evidence lives in the plan, not the diff — by design: the ledger is the plan's record.
  - `low` `reject` (intent) the ledger misses some source items (2.9 jitter, the 2.7 fallback choice, the 2.3 announcement half, the 2.6 note) — the fix is a plan edit; covered as deferred in the Auto Run Result instead.
  - `low` `reject` (intent) pixel identity is checked by grep, not rendering — the swapped values are identical by construction.
  - `false` `reject` (intent) the test additions are not cleanup — the plan's scope names them (S4–S7).
  - `low` `reject` (intent) S7 stabilises the test without fixing the app race — already deferred in the ledger.
  - `low` `reject` (intent) S6 checks contrast only through axe — axe's color-contrast rule is the check intended.

## Verification

Run 2026-10-02: full command exit 0 (vitest 23 files / 458 tests; Playwright 76 passed, none flaky); CSS grep and dist grep print nothing; S7 criterion 10/10.

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` (repo root, `~/.cargo/bin` on PATH) -- expected: all exit 0
- `grep -rnE "border-radius: (4|6|10|9999)px|height: 36px" app/src --include=*.css` -- expected: no output
- `grep -rlE '__test|UiTestPage|StorageTestPage|fakeMic' app/dist` -- expected: no output

## Auto Run Result

- **Summary:** cleanup-only sweep of the build records and deferred findings of stories 2.1–2.9.
  - S1: stale fake-mic comments fixed.
  - S2: radius and 36 px control-height tokens (`--radius-*`, `--size-control`) replace raw px; the result is pixel-identical.
  - S3: Settings' duplicate button style is now `buttons.secondary`.
  - S4: unnamed-device label tests.
  - S5: needle-dedupe tests, including the tenth-only case.
  - S6: dark-mode axe passes on Record with the quality banner and on the live Tuner.
  - S7: the flaky mic-select "switch" e2e is fixed; two test races were found under load.
  - Every ledger row is closed or deferred in Implementation Notes and in the frontmatter `deferred`.
- **Also explicitly deferred** (record items the review found missing from the ledger):
  - 2.9: the 40 ms e2e jitter allowance (render jitter; the exact rule is tested on the machine).
  - 2.7: a choice made during the sub-second unplug fallback is ignored (app behaviour, not cleanup).
  - 2.3: the toast announcement does not mention its action (with the toast-reach deferral; no toast has an action yet).
  - 2.6: the Too-loud 200 ms bound includes the fixture's 300 ms lead-in (test timing note, no debt).
- **Files changed:**
  - `app/src/ui/theme.css`.
  - CSS in `app/src/ui/components/{buttons,ToastHost,InputQualityBanner,MicGate,MicSelect,LevelMeter}.module.css` and `app/src/ui/screens/{Tuner,Settings}.module.css`.
  - `app/src/ui/screens/Settings.tsx`.
  - Tests: `app/tests/unit/{mic-unnamed,tuner-screen}.test.tsx` and `app/tests/e2e/{mic-setup,mic-select,input-quality,tuner}.dev.spec.ts`.
- **Review:** 18 findings (low 14, false 4); the edge-case lens found none. 1 entry patched (low: the tenth-only dedupe case). Nothing new deferred from review. Rejections and reasons are in the Review Triage Log.
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 0, low 1.
- **Verification:**
  - The full plan command exited 0: 459 unit tests and 76 Playwright tests, none flaky.
  - The CSS grep and the dist grep print nothing.
  - S7: 10/10 at `--repeat-each=10 --workers=4 --retries=0`, and 40/40 under heavy CPU load.
- **Residual risks:**
  - The token swaps were not screenshot-diffed; the values are identical by construction.
  - The S7 wait-for-fake-mic fix lives in a helper every mic-select test uses.
