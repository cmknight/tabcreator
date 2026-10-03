---
title: 'Queue announcements'
type: 'bugfix'
ticket: '3'
created: '2026-10-02'
status: 'built'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '1da379c8646fbbc409b9481c1eb58af9e2883c70'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: []
deferred:
  - summary: >-
      The polite announcement queue has no cap, coalescing or expiry, so a source announcing faster than the 500 ms drain, or a hidden tab pausing rAF, can back up stale messages that are spoken late or in a burst.
    evidence: |-
      Unverified (maybe-false, medium if true). announcer.ts queues every polite message and plays one per ANNOUNCE_GAP_MS after a rAF. Settle by measuring real announce rates (a level hovering at a warning threshold, an In tune wobble, a hidden-tab unplug); if a backlog forms, cap the queue, drop a message identical to the last queued one, or expire old entries.
    location: >-
      app/src/ui/a11y/announcer.ts listener/next
    severity: medium (unverified)
  - summary: >-
      ANNOUNCE_GAP_MS is 500 ms, shorter than speaking a typical message; a screen reader that does not buffer polite changes may still cut one message off with the next.
    evidence: |-
      Unverified (maybe-false, medium if true). Tests check region text, not speech. Settle with NVDA, JAWS and VoiceOver on a two-message burst (e.g. switch toast plus quality warning); if a message is cut, lengthen or scale the gap.
    location: >-
      app/src/ui/a11y/announcer.ts ANNOUNCE_GAP_MS
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** `ui/a11y/announcer.ts` cancels a pending polite message when another arrives in the same frame, so only the last is spoken (epic 2 retrospective A2). Two cases lose a message today:
- an unplug fallback onto a headset fires the "switched" toast and the quality-banner announcement together;
- the Tuner works around it with a 1 s delay (`ALL_SIX_DELAY_MS`) and an announce-on-unmount path.

Recording will add start, stop, warning and failure announcements on top. Retro A4 also left two Tuner tests unwritten.

**Approach:** Make the polite region a first-in, first-out queue: every message announced is spoken in order, each shown for at least a minimum gap. The assertive region keeps "latest wins". Then remove the Tuner workaround, and add the A4 Tuner tests.

## Boundaries & Constraints

**Always:**
- **Polite queue.** Every polite message is spoken in the order announced, including several in one frame. Each is written to the region on its own and stays at least `ANNOUNCE_GAP_MS` (a named constant, 500 ms) before the next one replaces it.
- **Repeats.** A repeat of the current text is still announced again, by clearing the region and then setting it on the next frame, as now.
- **Assertive.** It keeps its current behaviour: the latest message replaces any pending one. Story 3.6 relies on this so count-in beats don't lag.
- **Before mount.** A message announced before the `Announcer` mounts is still dropped.
- **Unmount.** Unmounting cancels pending timers and frames.
- **Interface.** The `announce(message, politeness)` signature, the two regions and their roles and attributes, and the AD-18 rule (no other live regions) stay as they are.
- **Tuner.**
  - Remove `ALL_SIX_DELAY_MS` and the pending "All six" logic from `TunerPanel`, including its cleanup announce.
  - When the sixth string ticks, announce the string's "… string in tune" and then "All six strings in tune" in the same poll.
- **Retro A4 e2e tests:**
  - On `#/tuner` with a 16 kHz input, the quality banner shows above the Tuner h1, its warning reaches the polite region, and keyboard Dismiss focuses the Tuner h1.
  - "All six strings in tune" is spoken even when the player leaves the Tuner right after the sixth tick.
- **Existing tests.** Every e2e test that reads the polite region keeps passing, unchanged or only adjusted to wait for its message.

**Never:**
- No change to which texts are announced, or when, anywhere else.
- No new live region.
- No change to toast timing.
- No recording features.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Same frame | `announce('A')`, `announce('B')` in one frame (polite) | region shows A, then B ≥ 500 ms later; both observed | none |
| Repeat | `announce('A')` twice, far apart | A announced twice (clear, then set) | none |
| Burst then idle | three messages, then none | all three in order; the region keeps the last text | none |
| Assertive | two assertive in one frame | only the second is shown | none |
| Unmount mid-queue | unmount with messages pending | no timer or frame fires afterwards; no error | none |
| Switch toast + banner | fallback onto a headset-labelled device (dev fake mic) | the polite region receives the "switched" text and the quality warning, both, in order | none |
| Sixth tick | Tuner open_strings reaches six ticks | "High E string in tune" then "All six strings in tune" in the polite log | none |

</intent-contract>

## Code Map

- **`app/src/ui/a11y/announcer.ts`:** `announce` broadcasts to listeners. `Announcer` keeps a `pending` rAF per politeness, clears, then sets on the next frame, and renders the regions with `createElement`. Unit tests live in `app/tests/unit/announcer.test.ts`, which uses fake timers.
- **`app/src/ui/screens/Tuner.tsx`:** `ALL_SIX_DELAY_MS` (L23-26), the `allSixAt` handling in the poll (L113-143), and the cleanup announce (L143).
- **`app/src/ui/components/InputQualityBanner.tsx`:**
  - it announces when shown;
  - Dismiss focuses the closest `section`'s h1;
  - the Tuner h1 has `tabIndex={-1}` (`Tuner.tsx`).
- **E2e specs that read `[aria-live="polite"]`:**
  - `app/tests/e2e/input-quality.dev.spec.ts`;
  - `tuner.dev.spec.ts` (the MutationObserver polite log in `watchReadout`);
  - `level-meter.dev.spec.ts` (`probe`);
  - `a11y-plumbing.dev.spec.ts`.
- **Fake mic hooks:**
  - `window.__fakeMic.configure(id, { sampleRate, label })` applies to later streams, and a label change fires `devicechange`;
  - `unplug(id)`;
  - `?fakeMic=a,b`.

## Tasks & Acceptance

**Execution:**
- [x] `app/src/ui/a11y/announcer.ts` and `app/tests/unit/announcer.test.ts`: the polite queue with `ANNOUNCE_GAP_MS`; unit tests for the matrix rows Same frame, Repeat, Burst, Assertive and Unmount.
- [x] `app/src/ui/screens/Tuner.tsx`: remove the All-six delay and the unmount path; announce both in the same poll.
- [x] `app/tests/e2e/`:
  - the switch-toast-plus-banner test (input-quality or mic-select spec);
  - the Tuner banner and Dismiss focus test;
  - the leave-right-after-six test;
  - adjust any polite-region assertion that now needs to wait.

**Acceptance Criteria:**
- Given the dev build, when the switch toast and the quality banner announce together, then both texts reach the polite region in order.
- Given the Tuner on open_strings, when all six tick, then the polite log has every "<name> string in tune" and then "All six strings in tune".
- Given the full verification, when it runs, then it exits 0.

## Implementation Notes

- Polite queue: `next()` clears the region, sets the head message on the next frame, then holds it `ANNOUNCE_GAP_MS` before taking the next one; idle once the queue is empty, so a later repeat clears and sets at once.
- Both regions now commit the clear with `flushSync` inside the frame callback before setting the text. Without it, a clear (from a timer or effect) and the frame's set could be batched into one render under load, so a repeat of the current text changed nothing in the DOM; the queue made this show up as a flake in `input-quality` "returning to Record … announces it again" (1 in 64 runs at 8 workers; 0 in 128 after the fix).
- Switch toast + banner: both are announced in one commit, the banner's effect first (it precedes the shell's toast host in the tree), so the e2e asserts the polite log holds `[warning, switched]` in that order.
- Unit tests sample the region text in 1 ms steps (MutationObserver callbacks do not run under fake timers); the existing repeat test now waits out the gap before repeating.

## Plan Change Log

## Review Triage Log

### 2026-10-02 — Review pass
- verdicts: 22 findings — high 0, medium 0, low 12, false 1, maybe-false 9
- findings:
  - `maybe-false` `defer` (blind) the polite queue has no cap, coalescing or expiry, so a fast source backs up with stale messages — settle by measuring real announce rates (level warning at a threshold, In tune wobble) against the 2-per-second drain (medium if true).
  - `maybe-false` `defer` (blind) a hidden tab pauses rAF, so the queue stalls and bursts on return — same root as the unbounded queue; settle as above (medium if true).
  - `maybe-false` `defer` (blind) 500 ms is shorter than speaking a typical message, so a screen reader that does not buffer polite changes can still cut one off — settle with NVDA, JAWS and VoiceOver on a two-message burst (medium if true).
  - `low` `reject` (blind) assertive messages do not pause the polite queue — screen readers give assertive priority; low.
  - `low` `reject` (blind) repeats are no longer collapsed, so StrictMode double effects are spoken twice — StrictMode double-invokes effects in dev only.
  - `low` `reject` (blind) `flushSync` in `fill` is redundant on the polite path — cheap; it keeps one code path for both regions.
  - `low` `reject` (blind) the polite-log e2e helper is duplicated across specs — the A5 sweep owns e2e helper consolidation.
  - `low` `reject` (blind) the headset test depends on the announce order — the plan's "in order" is announce order, which the test pins on purpose.
  - `false` `reject` (blind) the Tuner 16 kHz test is out of scope — it is retro A4's item, named in the ticket.
  - `low` `reject` (blind) unit gaps (announce during hold, assertive during hold, remount) — low.
  - `low` `reject` (blind) the unmount test's `console.error` spy and `getTimerCount` dependency — test polish.
  - `maybe-false` `defer` (blind) 500 ms is not justified anywhere — grouped with the gap-length deferral.
  - `maybe-false` `defer` (edge) the queue grows without bound — grouped with the unbounded-queue deferral.
  - `maybe-false` `defer` (edge) a hidden tab leaves `busy` true and bursts on return — grouped.
  - `maybe-false` `defer` (edge) queued messages go stale before they are dequeued — grouped.
  - `low` `patch` (verif) the `flushSync` clear is never exercised, so removing it passes every test — same-`act` repeat tests added for both regions.
  - `maybe-false` `defer` (verif, other) a sustained burst backs up — grouped with the unbounded-queue deferral.
  - `low` `reject` (intent) an All six queued just before the mic is lost is still spoken beside the mic-lost error — needs the mic lost within one gap of the sixth tick; rare.
  - `maybe-false` `defer` (intent) "spoken" is checked as region text, not speech — grouped with the gap-length deferral.
  - `low` `reject` (intent) the toast-plus-banner order follows announce order, not the ticket's wording — announce order is the defined order.
  - `low` `reject` (intent) the rewritten Tuner assertion no longer pins High E immediately before All six — the leave-early test pins it.
  - `low` `reject` (intent) `flushSync` touches the assertive region and polite messages are now up to 500 ms later — the repeat fix applies to both; the delay is inherent to the queue the ticket asks for.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` (repo root, `~/.cargo/bin` on PATH) -- expected: all exit 0
- `grep -n "ALL_SIX_DELAY_MS" app/src/ui/screens/Tuner.tsx` -- expected: no output

## Auto Run Result

- **Summary:** the polite live region is now a first-in, first-out queue. Every message is spoken in announce order, each held for at least `ANNOUNCE_GAP_MS` (500 ms).
  - The assertive region keeps "latest wins".
  - Both regions commit the clear with `flushSync` before refilling, so a repeat of the current text is always announced again. This fixed a pre-existing 1-in-64 flake.
  - The Tuner's `ALL_SIX_DELAY_MS` and its announce-on-unmount path are gone; "All six strings in tune" is announced in the same poll as the sixth string.
- **Files changed:**
  - `app/src/ui/a11y/announcer.ts`;
  - `app/src/ui/screens/Tuner.tsx`;
  - tests: `app/tests/unit/announcer.test.ts` and `app/tests/e2e/{input-quality,tuner}.dev.spec.ts`. The new tests cover the switch toast plus banner, the Tuner banner and Dismiss focus, and leaving right after six ticks.
- **Review:** 22 findings (low 12, false 1, maybe-false 9).
  - One low entry patched: same-`act` repeat tests that fail without `flushSync`.
  - Two items deferred (maybe-false, medium if true):
    - the polite queue has no cap or expiry, so it could back up stale messages or burst after a hidden tab;
    - the 500 ms gap against real screen-reader speech.
  - Rejections are in the Review Triage Log.
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 0, low 1.
- **Verification:**
  - The full plan command exited 0 before the test-only patch: 491 unit tests, 79 Playwright tests, none flaky.
  - After the patch, format, lint, typecheck and the unit suite passed.
  - `ALL_SIX_DELAY_MS` is gone from Tuner.tsx.
- **Residual risks:**
  - The two deferred items need real screen readers and real announce rates.
  - Polite messages that arrive together are now up to 500 ms apart.
