---
title: 'Level meter with warnings'
type: 'feature'
ticket: '6'
created: '2026-10-02'
status: 'built'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: true
baseline_revision: '230035d0de27c7e3d069f3281347d85b29a37bc4'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Record shows only 2.1's plain linear RMS bar: no dBFS scale, no peak, no colours, and no Too loud or Too quiet warning, so the player cannot tell whether the input is clipping or too quiet.

**Approach:** Add `audio/level-meter.ts` (peak and RMS in dBFS from the shared analyser frame) and a pure warning state machine, expose them through `recording-session`, and replace the plain bar with a reusable `LevelMeter` component per US-1.3 and the record mockup, announcing warning changes through 2.3's announcer.

## Boundaries & Constraints

**Always:** Maths: `rmsDb = 20·log10(rms)`, `peakDb = 20·log10(max|x|)`, `-Infinity` for silence, from the analyser's float time-domain frame (one 4096 frame, slice 1). Scale −60 to 0 dBFS, ticks −60, −48, −36, −24, −12, −3, 0. Fill = RMS, clipped; a peak tick holds the highest peak for 1.5 s then follows. Colour zones by position (mockup: a fixed three-zone fill clipped to the level): `--color-meter-ok` below −12, `--color-meter-warn` −12 to −3, `--color-meter-hot` above −3. Too loud: peak ≥ −1 dBFS sets it at once; it clears 2 s after the last such peak. Too quiet: RMS < −45 dBFS continuously for 3 s; clears as soon as RMS ≥ −45; Too loud wins when both apply. Copy verbatim: "Too loud — move back or lower the input", "Too quiet — move closer to the guitar", label "Input level", unit "dBFS". `role="meter"`, `aria-valuemin="-60"`, `aria-valuemax="0"`, `aria-valuenow` the rounded RMS dB clamped to the scale, `aria-valuetext` "−20 dBFS" or "−6 dBFS, too loud"; ARIA values update at most 4 times a second, the visual fill every animation frame (≥ 30 fps). Warning text in the meter (icon + text, never colour alone), line keeps its height when empty, not a live region (AD-18 lint); each warning change announced politely through `announce()`. No easing under `prefers-reduced-motion`. Decision (epic, 2026-10-02): Too quiet shows on Record before recording too (CAP-3 over EXPERIENCE.md; Source conflict logged). The store notifies only when the warning changes, never per frame.

**Never:** No `clipCount` or recording behaviour (Recording epic); no Tuner screen (2.9 mounts the component); no device select (2.7); no CPU budget gate (budgets epic); no edits to fake-mic or mic error handling.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Full-scale sine | amplitude 1 frame | peak 0 dBFS, RMS −3.01 dBFS (±0.01) | none |
| Silence | all-zero frame | peak and RMS `-Infinity`; fill empty; valuenow −60 | none |
| Too loud | peak ≥ −1 dBFS | warning "Too loud" at once; still shown 1.9 s after the last loud peak, gone at 2 s | none |
| Too quiet | RMS < −45 for 3 s | warning "Too quiet" at 3 s, not at 2.9 s; cleared when RMS ≥ −45 | none |
| Both | loud peak during quiet stretch | Too loud shown | none |
| Peak hold | peak −6 then −30 | tick stays at −6 for 1.5 s then follows | none |
| level_too_hot | dev, `?fakeMic=level_too_hot`, Allow | Too loud within 200 ms of the first clipped frame | none |
| silence_60s | dev, `?fakeMic=silence_60s`, Allow | Too quiet after 3 s (not before 2.9 s) | none |
| open_strings | dev, `?fakeMic=open_strings`, Allow | no warning for the fixture's length | none |

</intent-contract>

## Code Map

Builds on 2.1 (mic, store, plain bar) and 2.5 (`f57dbf7`, error cards, focus wrapper, shell announcer), both done. Fixtures: `level_too_hot` 5.55 s clipped, `silence_60s`, `open_strings` 6.7 s; the dev fake mic restarts its fixture per stream (2.2).

- `app/src/audio/mic.ts` -- `openInput` returns `{ analyser, readRms, close }` (4096-point analyser). Add a frame reader used by the meter (float time-domain).
- `app/src/audio/level-meter.ts` -- new: `levelsDbfs(frame): { peakDb, rmsDb }`.
- `app/src/model/level-warnings.ts` -- new pure state machine `nextWarning(state, { peakDb, rmsDb, now })` (model/: no DOM, clock passed in, AD-1).
- `app/src/session/recording-session.ts` -- `readLevel()` returns linear RMS; replace with `readLevels(now)` returning `{ peakDb, rmsDb }` and advancing the warning machine; snapshot gains `levelWarning: 'loud' | 'quiet' | null`; reset it when the mic leaves `live`.
- `app/src/ui/screens/Record.tsx` -- `LevelBar` (rAF loop, `role="meter"`, linear width) and the focus wrapper (keep its `data-focus-target` on the meter container). Replace `LevelBar` with `app/src/ui/components/LevelMeter.tsx` + `.module.css`.
- `app/src/ui/strings.ts` -- add the copy.
- Tests that read the old bar: `app/tests/e2e/mic-setup.dev.spec.ts`, `mic-errors.dev.spec.ts` (`aria-valuenow` moving, meter focus); keep them passing against the new meter.

## Tasks & Acceptance

**Execution:**
- [x] `app/src/audio/level-meter.ts`, `app/src/audio/mic.ts` -- dBFS maths and the frame reader.
- [x] `app/src/model/level-warnings.ts` -- warning machine per Boundaries.
- [x] `app/src/session/recording-session.ts` -- `readLevels(now)`, `levelWarning` in the snapshot, reset off `live`.
- [x] `app/src/ui/components/LevelMeter.tsx`, `LevelMeter.module.css`, `app/src/ui/strings.ts`, `app/src/ui/screens/Record.tsx` -- the meter per Boundaries; Record mounts it in place of `LevelBar`; announce warning changes.
- [x] `app/tests/unit/level-meter.test.ts`, `level-warnings.test.ts`, `recording-session.test.ts` -- matrix rows Full-scale sine to Peak hold with injected clocks.
- [x] `app/tests/e2e/level-meter.dev.spec.ts` -- level_too_hot, silence_60s and open_strings rows; ≥ 30 visual updates in 1 s (count fill style changes); the warning announced once; axe with no serious or critical violations. Update older specs only where they read the removed bar.

**Acceptance Criteria:**
- Given `prefers-reduced-motion: reduce`, when the meter updates, then no CSS transition applies to the fill or peak tick.
- Given the full verification, when it runs, then lint (layer rules, aria-live ban), stylelint (no colour literals) and every existing mic spec pass.

## Implementation Notes

- `MicInput.readFrame()` returns the analyser's shared float frame; `readRms()` is kept (unused by the store now). The store's `openInput` dependency picks `readFrame` instead of `readRms`.
- Peak hold lives in `model/level-warnings.ts` as `nextPeakHold` (ui/ may not import audio/, and the matrix wants it unit-tested).
- `levelWarning` is always present on the snapshot (`null` off `live`); every mic transition resets the warning machine.
- ARIA values are written only when the rounded value or warning changes, and at most every 250 ms, so the first change after a steady stretch shows at once (the 2.1 "meter moving within 1 s" check depends on it).
- Only a newly shown warning is announced (polite); clearing is not announced, as no copy exists for it; `aria-valuetext` drops the suffix.
- The fill (50 ms linear) and peak tick (100 ms ease-out) have short transitions, removed under `prefers-reduced-motion: reduce`.
- `record.inputLevel` moved to `global.inputLevel`, since the meter is shared with the Tuner (2.9).

## Plan Change Log

## Review Triage Log

### 2026-10-02 — Review pass
- verdicts: 22 findings — high 0, medium 7, low 12, false 3, maybe-false 0
- findings:
  - `medium` `patch` (verif) visual fill and peak tick untested — e2e asserts the clip-path on silence and the tick on open_strings.
  - `medium` `patch` (verif, other) stale quiet timer and warning after leaving Record — warning state resets after a read gap.
  - `low` `patch` (verif, other) `readRms` has no caller — removed.
  - `medium` `patch` (edge) old quietSince survives a read gap — same gap reset.
  - `medium` `patch` (edge) stale warning shown on remount, never announced — same gap reset clears it.
  - `low` `reject` (edge) NaN samples poison the levels — AnalyserNode float data does not contain NaN.
  - `medium` `patch` (blind) stale warning timers after reads stop — same gap reset.
  - `medium` `patch` (blind) peak tick steps down in 1.5 s holds instead of following — follows frame by frame after expiry.
  - `low` `reject` (blind) clearing a warning is not announced — no approved copy; value text drops the suffix.
  - `low` `patch` (blind) `readRms` dead code — removed.
  - `low` `reject` (blind) −3 and 0 scale labels can overlap on narrow screens — v1 targets desktop Chrome, where the track is wide.
  - `low` `reject` (blind) duplicated dB formatting and an inline warning type — cosmetic.
  - `low` `patch` (blind) focus lands on an unnamed wrapper — the labelled meter is now the focus target.
  - `low` `patch` (blind) peak tick untested — covered by the e2e fill and tick assertions.
  - `false` `reject` (blind) Too quiet fires 3 s after the mic opens before playing — required by CAP-3 and Done-when 3 on silence_60s (decision 2026-10-02).
  - `medium` `patch` (intent) warning behaviour depends on where the meter is mounted — gap reset makes it independent of mount history.
  - `low` `reject` (intent) the 200 ms bound is measured from the meter appearing — the page cannot see the first clipped frame; the bound includes the fixture's lead-in.
  - `false` `reject` (intent) colour does not follow the warning state — the record mockup specifies fixed zones clipped to the level.
  - `low` `reject` (intent) 30 fps counted as DOM writes — writes per animation frame are the rendered updates.
  - `low` `patch` (intent) axe not run in the no-warning state — added to the open_strings test.
  - `false` `reject` (intent) reduced motion handled only as CSS transitions — there is no value smoothing to remove.
  - `low` `reject` (intent) a second dBFS helper beside tuner.ts — refactor sweep scope.

## Design Notes

Per-frame flow, so the store stays quiet:

```ts
// LevelMeter rAF tick
const { peakDb, rmsDb } = recordingSession.readLevels(performance.now()); // advances warnings; notifies only on change
drawFill(rmsDb); drawPeak(peakHold(peakDb, now)); maybeUpdateAria(rmsDb, now); // ≤ 4/s
```

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` -- expected: all exit 0 (`~/.cargo/bin` on PATH)
- `grep -rlE '__test|UiTestPage|StorageTestPage|fakeMic' app/dist` -- expected: no output

## Auto Run Result

- **Summary:** Record has a real level meter.
  - Peak and RMS are computed in dBFS from the shared analyser (`audio/level-meter.ts`).
  - The bar runs from −60 to 0 dBFS, with an RMS fill clipped over fixed ok/warn/hot zones and a 1.5 s peak-hold tick that then follows the peak.
  - Warnings show as icon plus text and are announced politely: Too loud (peak ≥ −1 dBFS, clears 2 s after the last loud peak) and Too quiet (RMS < −45 dBFS for 3 s).
  - The meter has `role="meter"` with value text, updated at most 4 times a second. The fill updates every frame, with no transitions under reduced motion.
  - The warning state resets after a gap in reads, so leaving and returning never shows a stale warning.
- **Files changed:**
  - `app/src/audio/level-meter.ts` (new), `app/src/audio/mic.ts`: `readFrame` added, `readRms` removed.
  - `app/src/model/level-warnings.ts` (new): warning and peak-hold state machines.
  - `app/src/session/recording-session.ts`: `readLevels(now)`, `levelWarning`, the gap reset.
  - `app/src/ui/components/LevelMeter.tsx`, `.module.css` (new), `app/src/ui/screens/Record.tsx`, `app/src/ui/strings.ts`: the meter and its copy.
  - Tests: `app/tests/unit/{level-meter,level-warnings,recording-session,mic}.test.ts`, `app/tests/e2e/level-meter.dev.spec.ts`, `mic-errors.dev.spec.ts`.
  - Commits: `e864802` (build) and `17119e8` (review fixes).
- **Review:** 22 findings (medium 7, low 12, false 3); 5 fixes applied, nothing deferred. Fixes:
  - the read-gap reset (one entry covering five findings);
  - a following peak tick;
  - e2e checks of the fill and tick;
  - focus on the labelled meter;
  - removal of the `readRms` dead code.

  Rejections and their reasons are in the Review Triage Log.
- **Follow-up review recommended:** true. Three medium entries were patched. Unverified risks:
  - the 500 ms read-gap reset and the first frame drawn from a layout effect, in a real backgrounded Chrome tab;
  - the follow-after-hold peak tick's look with real guitar input.
- **Verification:**
  - The full plan command exited 0: 53 Playwright tests, with all unit tests passing.
  - `app/dist` has no dev-only strings.
- **Residual risks:**
  - The 200 ms Too-loud bound is measured from the meter appearing, including the fixture's 300 ms lead-in.
  - The −3 and 0 scale labels can crowd on very narrow screens.
