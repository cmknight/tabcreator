---
title: 'Input quality warning'
type: 'feature'
ticket: '8'
created: '2026-10-02'
status: done
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '796cf4c86a4b484b5a37bdc9add06cdf88e3cc23'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: ['oversized']
deferred:
  - summary: >-
      The input quality rate is read once when the input opens, so a live input that drops to a call-mode rate without a devicechange keeps a stale "fine" verdict.
    evidence: |-
      Unverified (maybe-false, medium if true). trackDevice reads getSettings().sampleRate once in openInput; refreshDevices re-checks only the label. Settle in real Chrome with a Bluetooth headset that switches A2DP to HFP while live: check whether a devicechange fires or the track ends and reopens; if neither, re-read the track settings on refresh.
    location: >-
      app/src/audio/mic.ts trackDevice; app/src/session/recording-session.ts refreshDevices
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** A Bluetooth headset in call mode or any input below 44.1 kHz ruins pitch accuracy, and the player gets no sign of it (CAP-26, FR-23, US-1.2).

**Approach:** While live, derive an input-quality flag from the active input's actual sample rate and label, and show the warning banner from the mockup (record.html (e)) above the Record heading as a reusable component, with a Dismiss that hides it for the rest of the page session.

## Boundaries & Constraints

**Always:** The warning shows when the mic is `live` and the live track's `getSettings().sampleRate` is below 44 100, or the active input's label matches `/airpods|bluetooth|hands-free|headset|buds/i` (label: the listed active device's label, else the track label). An unknown sample rate (setting absent) does not trigger it by itself. The rule is a pure function in `model/` with unit tests. The flag lives in the recording-session snapshot and is recomputed on every live transition and on a `devicechange` refresh (a label change). Dismiss is session-wide and in memory only (the store), not in prefs: after Dismiss no quality banner shows again until reload, whatever device is chosen; a reload shows it again while the condition holds. Text verbatim in `ui/strings.ts`: "This microphone may be a Bluetooth headset in call mode — accuracy will be poor. Use the built-in or a wired mic.", button "Dismiss" with accessible name "Dismiss Bluetooth warning for this session". Banner style per DESIGN.md `banner-warning`: `--color-check-bg` fill, `--color-text`, 4 px `--color-warning` left edge, warning icon, text, then a text Dismiss button at the end; theme tokens only. The banner is not a live region (AD-18): when it appears, the component announces the text politely through `announce` (as `LevelMeter` does). The component (`ui/components/InputQualityBanner.tsx`) reads the store itself, so the Tuner can mount it with no props.

**Never:** No Tuner mount (2.9). No changes to `audio/fake-mic.ts`. No persistence of the dismissal. No recording-time behaviour. No new AudioContext rate logic (do not force or read a 44.1 kHz context; the track setting is the source).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Normal input | `?fakeMic=open_strings`, live (48 kHz) | no banner | none |
| Low rate | `configure(id,{sampleRate:16000})` before Allow, live | banner shown above the h1 | none |
| Headset label | `configure(id,{label:'AirPods Pro'})` before Allow, live | banner shown | none |
| Rate exactly 44 100 | track reports 44100 | no banner | none |
| Rate unknown | no `sampleRate` in settings, normal label | no banner | none |
| Dismiss | banner shown, click Dismiss | banner gone; stays gone after switching to another poor device | none |
| Reload | after Dismiss, reload with grant | banner shown again | none |
| Switch away | two devices, poor one active, switch to the good one | banner gone | none |
| Label changes live | `configure` relabels the active device to "Headset" | banner shown after the `devicechange` refresh | none |
| Not live | setup or error card | no banner | none |

</intent-contract>

## Code Map

Builds on 2.1–2.7 (`796cf4c`).
- `app/src/audio/mic.ts` -- `MicInput` and `trackDevice(stream)` read `getSettings()`; add `sampleRate: number | null` from the track settings. `openInput` keeps its default `new AudioContext()`.
- `app/src/session/recording-session.ts` -- `OpenedInput` Pick list (add `sampleRate`), `set()` builds every snapshot for mic transitions, `refreshDevices()` for devicechange, `activeDevice(input, devices)` for the listed label. Add snapshot fields `inputQualityPoor: boolean` (false unless live) and `inputQualityDismissed: boolean`, plus `dismissInputQuality()` on the interface. Keep the "notify only on change" rule.
- `app/src/model/` -- new `input-quality.ts`: `isPoorInput({ sampleRate, label }): boolean` and the exported pattern/threshold (`model/level-warnings.ts` is the style reference).
- `app/src/ui/components/LevelMeter.tsx` -- polite `announce` on a new warning via a ref (pattern to copy); `MicSelect.tsx` -- a store-reading reusable component.
- `app/src/ui/screens/Record.tsx` -- render `<InputQualityBanner />` first inside the section, before the h1 (mockup order); only while live.
- `app/src/ui/screens/Settings.module.css` -- `.bannerError` layout to mirror (flex, gap, padding tokens); do not edit it.
- `app/src/ui/strings.ts` -- add `global.inputQualityWarning`, `global.dismiss`, `global.inputQualityDismissLabel`.
- Tests: `app/tests/unit/recording-session.test.ts` (fake deps: `openInput` returns an `OpenedInput`; add `sampleRate`), new `app/tests/unit/input-quality.test.ts`, new `app/tests/e2e/input-quality.dev.spec.ts` (reuse `mic-helpers.ts`; `window.__fakeMic.configure(id, { sampleRate, label })` applies to streams opened afterwards and a label change fires `devicechange`; fake ids `fake-mic-<fixture>`).

## Tasks & Acceptance

**Execution:**
- [x] `app/src/model/input-quality.ts`, `app/tests/unit/input-quality.test.ts` -- the rule and its boundaries (44 100, null rate, each pattern word, case).
- [x] `app/src/audio/mic.ts` -- `sampleRate` on `MicInput`.
- [x] `app/src/session/recording-session.ts`, `app/tests/unit/recording-session.test.ts` -- snapshot flag, dismissal, recompute on live set and refresh; matrix rows with fakes.
- [x] `app/src/ui/components/InputQualityBanner.tsx`, `.module.css`, `app/src/ui/screens/Record.tsx`, `app/src/ui/strings.ts` -- the banner, polite announce on appearance, Dismiss.
- [x] `app/tests/e2e/input-quality.dev.spec.ts` -- Normal, Low rate, Headset label, Dismiss + switch, Reload rows; axe with the banner shown.

**Acceptance Criteria:**
- Given the dev build with `?fakeMic=open_strings`, when the device is configured to 16 kHz or labelled "AirPods Pro" before Allow, then the banner shows on Record; unconfigured it does not; Dismiss hides it until reload.
- Given the full verification, when it runs, then every existing spec still passes and `app/dist` has no dev-only strings.

## Implementation Notes

- `MicInput.sampleRate` is null unless the track reports a positive number.
- Label for the rule: the listed active device's label, else (unlisted or empty) the track label.
- During a device switch (no input open yet) `inputQualityPoor` keeps its last value, so a poor → poor switch does not flash or re-announce the banner; it is recomputed once the new input opens.
- `InputQualityBanner` is rendered unconditionally first in Record's section and returns null unless live, poor and not dismissed. It announces its text politely each time it appears, including on mount while showing (e.g. returning to Record), since the store state alone does not say whether the player heard it.
- Dismiss uses `--color-text`, not `--color-text-muted`: muted on `--color-check-bg` is 4.39:1 in dark (below 4.5).
- e2e configures the fake device after the app renders (the fake mic is installed by an awaited dynamic import) and reloads with `page.reload()` on `#/library` (a hash-only `goto` does not reload), then re-configures and enters Record.

## Plan Change Log

## Review Triage Log

### 2026-10-02 — Review pass
- verdicts: 23 findings — high 0, medium 1, low 14, false 4, maybe-false 4
- findings:
  - `medium` `patch` (blind) Dismiss unmounts the focused button, so focus falls to body — focus moves to the screen's h1 (tabIndex -1) before dismissing; e2e asserts it.
  - `low` `reject` (blind) the text blames Bluetooth when only the rate is low — the sentence is verbatim from US-1.2 / EXPERIENCE.md.
  - `low` `reject` (blind) the pattern misses "Hands Free", "Handsfree", HFP — the regex is verbatim from US-1.2.
  - `low` `reject` (blind) a wired USB headset at 48 kHz still matches "headset" — the spec's rule; Dismiss covers it.
  - `low` `patch` (blind) the `sampleRate > 0` guard is untested — 0 and non-number cases added to mic.test.ts.
  - `low` `reject` (blind) no test of 2.7's unplug fallback landing on a poor input — same `set()` recompute path as the tested switch.
  - `low` `reject` (blind) a failed switch is untested for the flag — a failure sets `error`, which forces the flag false.
  - `low` `patch` (blind) announce on remount untested — e2e added: Library → Record re-announces.
  - `low` `reject` (blind) negative e2e checks use fixed waits — same as 2.7's accepted pattern; test polish.
  - `low` `patch` (blind) banner CSS: redundant `margin-inline-start`, physical `border-left`, no wrap — redundant margin deleted; `border-left` matches Settings' banner; desktop-only target, no wrap needed.
  - `low` `patch` (edge) focus falls to body on Dismiss — grouped with the focus fix.
  - `maybe-false` `defer` (edge) a call-mode rate drop with no devicechange is never re-read — settle in real Chrome with a Bluetooth headset that switches A2DP→HFP while live (medium if true).
  - `maybe-false` `defer` (edge) refreshDevices re-checks the label against a cached rate — same root as above; deferred with it.
  - `low` `reject` (edge) "Hands Free" with a space is missed — the regex is verbatim from US-1.2.
  - `low` `reject` (edge) a matching track label is ignored when the listed label is fine — Chrome's track label is the device label; unlikely.
  - `low` `patch` (verif) `sampleRate: 0` / non-number untested — grouped with the mic.test.ts cases.
  - `low` `patch` (verif) announce on remount untested — grouped with the e2e remount test.
  - `false` `reject` (intent) the banner is not mounted on Tuner — the ticket says "reusable on Tuner"; the Tuner mount is story 2.9.
  - `maybe-false` `reject` (intent) only the track's sampleRate is read, not the AudioContext rate — Chrome reports `sampleRate` in audio track settings, and the app's AudioContext runs at the output rate, not the input's, so it could not tell a low input; if Chrome did not report it, only the label rule would fire (low).
  - `maybe-false` `reject` (intent) the reload e2e reloads on #/library, not #/record — the fake mic's config is lost on reload; the store resets the same way on any page load (low if true).
  - `false` `reject` (intent) the banner has no `role="status"` unlike the mockup — AD-18 forbids per-screen live regions; it announces through the announcer.
  - `false` `reject` (intent) the banner is gated on `live` — "the active input" only exists while live.
  - `false` `reject` (intent) Dismiss → navigate → return without reload is not exercised — the dismissal lives in the module-singleton store, which navigation does not reset; unit tests cover it across transitions.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` (repo root, `~/.cargo/bin` on PATH) -- expected: all exit 0
- `grep -rlE '__test|UiTestPage|StorageTestPage|fakeMic' app/dist` -- expected: no output

## Auto Run Result

- **Summary:** Record shows the input quality warning banner while live when the track reports a sample rate below 44 100 Hz or the active input's label matches `/airpods|bluetooth|hands-free|headset|buds/i`.
  - The rule is pure (`model/input-quality.ts`). The store recomputes it on every live transition and on `devicechange`.
  - Dismiss hides it for the page session (memory only) and moves focus to the Record heading.
  - The banner is store-driven with no props, so the Tuner can mount it in 2.9. It announces politely through the shared announcer each time it appears.
- **Files changed:**
  - `app/src/model/input-quality.ts`: the rule.
  - `app/src/audio/mic.ts`: `MicInput.sampleRate` from the track settings.
  - `app/src/session/recording-session.ts`: `inputQualityPoor`, `inputQualityDismissed`, `dismissInputQuality()`.
  - `app/src/ui/components/InputQualityBanner.tsx`, `.module.css`: the banner.
  - `app/src/ui/screens/Record.tsx`: banner above the h1; h1 focusable for Dismiss.
  - `app/src/ui/strings.ts`: warning text, Dismiss and its accessible name.
  - Tests: `app/tests/unit/{input-quality,mic,recording-session}.test.ts`, `app/tests/e2e/input-quality.dev.spec.ts`.
- **Review:** 23 findings (medium 1, low 14, false 4, maybe-false 4). Patched: 1 medium (focus after Dismiss) and 3 lows (rate-guard tests, remount announce e2e, a redundant CSS line). 1 item deferred (maybe-false, medium if true): a live call-mode rate drop with no `devicechange` is not re-read. Rejections and reasons are in the Review Triage Log.
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 1, low 3.
- **Verification:** the full plan command exited 0 after the patches (424 unit tests, 70 Playwright tests); `app/dist` has no dev-only strings.
- **Residual risks:**
  - Real Chrome's reporting of `sampleRate` and A2DP→HFP switching is unexercised (deferred item).
  - Banner dark-mode contrast was checked by calculation only.
