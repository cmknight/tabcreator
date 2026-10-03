---
title: 'Recording-time mic touch points'
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
baseline_revision: 'c63a4a24362deb79bbafb343cf3513a423b8202c'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** Three epic 2 touch points owned here are still open:
- clipping during a take is not recorded, so the Tab screen cannot warn about it (US-1.3 clipCount, AD-14 `clipped`);
- the Microphone select stays usable while recording (CAP-2);
- Record is simply absent when the mic is unavailable, instead of disabled with a reason (EXPERIENCE.md Record button row).

**Approach:**
- Count clipped samples in the recorder worklet and save `clipped` at stop.
- Disable the select from the count-in until the take is saved, with its reason.
- Render Record disabled, with a reason, whenever the mic is not live.

## Boundaries & Constraints

**Always:**
- **Clip threshold.** A captured sample with |x| ≥ 10^(−1/20) (−1 dBFS) counts as clipped. This is the same threshold as the meter's Too loud (`model/level-warnings.ts` `TOO_LOUD_PEAK_DB`), so a flagged take is one the meter warned about. The threshold is a named constant shared with, or derived from, that one.
- **Clip counting.** Only samples inside the captured range (start frame to stop frame) count. The worklet reports its counts to the main thread with each chunk (or at stop). The store keeps the total in memory for the take as `clipCount`. The stop patch adds `clipped: clipCount > 0` (owned by recording-session, AD-14), and it is set on every saved take, user or max-length.
- **Microphone select while busy.**
  - From the count-in through `stopping` (any non-idle recording state), the select is `disabled`.
  - It carries the reason "Can't change the microphone while recording" in two ways:
    - as a tooltip (`title`) on its field wrapper;
    - as text tied to the select with `aria-describedby`.
  - It re-enables when idle. The store's existing no-op for `selectMic` while recording stays.
- **Record without a live mic.**
  - While the mic is not live (setup, requesting or error), Record shows outside `MicGate`.
  - It is `aria-disabled` (not `disabled`, so it stays focusable), labelled "Record".
  - Its `aria-describedby` points to the mic card's heading, so the card's own text ("TabCreator needs your microphone", "Microphone access is blocked", …) is the reason.
  - Clicking it, and Space, do nothing. Space is already guarded on mic live.
- **Copy and tokens.** All new text in `ui/strings.ts`; theme tokens only.

**Never:**
- No Tab-screen clipping banner (Tab epic).
- No change to the meter warnings.
- No failure stops (story 3.9).
- No change to device switching rules beyond disabling the select while busy.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Clipped take | `?fakeMic=level_too_hot`, record ~2 s, stop | take saved with `clipped: true` | none |
| Clean take | `?fakeMic=open_strings`, record ~2 s, stop | `clipped: false` | none |
| Clip outside range | clipping only before the start frame | not counted (unit, fake worklet input) | none |
| Select busy | two devices; count-in or recording | select `disabled`, wrapper `title` and described-by text "Can't change the microphone while recording" | none |
| Select idle again | after the take is saved | select enabled | none |
| Record, no mic | setup card (first visit) | Record visible, `aria-disabled="true"`, described by the card heading; click does nothing; Space does nothing | none |
| Record, error | mic error card (e.g. denied) | same, described by the error card heading | none |
| Record, live | mic live | Record enabled, as before | none |

</intent-contract>

## Code Map

- **`app/src/audio/recorder-worklet.ts`:** `process()` copies frames `from..to` into 1 s chunks and posts `chunk`, `started` and `stopped`. Add the clip count over the copied frames.
  - The worklet imports nothing, so put the threshold value in the start message, or duplicate the constant with a comment naming its source.
- **`app/src/audio/recorder.ts`:** `startCapture` relays chunks to `onChunk`; extend it to relay clip counts. **`app/src/audio/mic.ts`:** `MicInput.capture`.
- **`app/src/model/level-warnings.ts`:** `TOO_LOUD_PEAK_DB = -1`. **`app/src/model/types.ts`:** `Take.clipped?`, owned by recording-session.
- **`app/src/session/recording-session.ts`:** the take's samples counter, `finishTake` and its stop patch, the `recording` state.
- **UI:**
  - `app/src/ui/components/MicSelect.tsx`: the select with its `<label>`, hidden at one device or none.
  - `app/src/ui/components/RecordButton.tsx`: rendered inside `MicGate`.
  - `app/src/ui/components/MicGate.tsx`: children render only while live; the setup and error cards carry `h2#mic-setup-title`.
  - `app/src/ui/screens/Record.tsx`.
  - `app/src/ui/a11y/shortcuts.ts`: `recordToggle` already requires the mic live.
- **Tests:**
  - `app/tests/unit/recording-take.test.ts` (fake capture);
  - `app/tests/e2e/record.dev.spec.ts` (`readSaved` reads the take);
  - the e2e fake mic devices `?fakeMic=a,b`;
  - fixtures `level_too_hot` (clipped) and `open_strings`.

## Tasks & Acceptance

**Execution:**
- [ ] `app/src/audio/recorder-worklet.ts`, `app/src/audio/recorder.ts`, `app/src/audio/mic.ts`: the clip count.
- [ ] `app/src/session/recording-session.ts`: `clipCount` and `clipped` in the stop patch.
- [ ] `app/src/ui/components/MicSelect.tsx`, `RecordButton.tsx`, `MicGate.tsx` or `Record.tsx`, and `strings.ts`: the disabled select, and Record when not live.
- [ ] `app/tests/unit/`: the clip-count rows (including outside the range) and `clipped` in the patch.
- [ ] `app/tests/e2e/record.dev.spec.ts`: the Clipped-take, Clean-take, Select-busy and Select-idle-again rows, and the Record no-mic and error rows; axe on the setup card with the disabled Record.

**Acceptance Criteria:**
- Given the dev build, when a take is recorded from `level_too_hot`, then it is saved with `clipped: true`; from `open_strings`, with `clipped: false`.
- Given two inputs while recording, when the select is inspected, then it is disabled with its reason.
- Given the full verification, when it runs, then it exits 0.

## Implementation Notes

## Plan Change Log

## Review Triage Log

### 2026-10-02 — Review pass
- verdicts: 16 findings — high 0, medium 0, low 13, false 3, maybe-false 0 (the verification-gap lens reported none)
- findings:
  - `low` `patch` (edge) focus on the disabled outer Record drops to body when the mic goes live (two instances swap) — one RecordButton instance in both states.
  - `false` `reject` (blind) the whole Record screen re-renders on every meter tick — the store notifies only when the level warning changes, not per frame.
  - `low` `patch` (blind) Record swaps between two instances and resets its state — grouped with the single-instance fix.
  - `low` `reject` (blind) the `.visuallyHidden` CSS is duplicated — a sweep item (retro A5 class).
  - `low` `reject` (blind) sighted keyboard and touch users never see the disabled select's reason — EXPERIENCE.md specifies a tooltip; also exposed to screen readers.
  - `low` `patch` (blind) the worklet fails open if `clipLevel` is missing — test added that the start message carries `CLIP_LEVEL`.
  - `low` `patch` (blind) the count-in path's clip wiring is untested — test added.
  - `low` `reject` (blind) abandoned or recovered takes get no `clipped` — recovery (3.11) can derive it from the raw chunks; low.
  - `low` `patch` (blind) Space on the focused disabled Record button is untested — e2e row added.
  - `low` `patch` (blind) two edited doc comments overrun the line width — rewrapped.
  - `low` `reject` (blind) RecordButton imports a DOM id constant from MicGate — small coupling; low.
  - `low` `reject` (blind) worklet unit gaps (no channel, a clip on the chunk boundary) — low.
  - `false` `reject` (intent) the Verify cannot tell −1 dBFS from full scale — the plan settled −1 dBFS (matches Too loud); both fixtures agree.
  - `low` `reject` (intent) `clipCount` is not kept after the take for US-3.1's summary — AD-14 persists the boolean; the Tab epic reads `clipped`.
  - `low` `reject` (intent) the select is also disabled on the Tuner while a take runs, untested — intended (the take uses that input).
  - `false` `reject` (intent) `aria-disabled`, the heading as reason, the button outside the card, Space already guarded, the old "no Record" test reversed — all per the plan contract.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` (repo root, `~/.cargo/bin` on PATH) -- expected: all exit 0

## Auto Run Result

- **Summary:**
  - **Clip counting:** the recorder worklet counts captured samples at or above −1 dBFS (`CLIP_LEVEL`, derived from the meter's Too loud threshold and sent in the start message). The store sums them per take and saves `clipped: clipCount > 0` on every saved take.
  - **Microphone select:** disabled from the count-in until the take is saved. Its reason, "Can't change the microphone while recording", is a wrapper tooltip and an `aria-describedby` text.
  - **Record without a live mic:** one RecordButton, the same element in every mic state, is shown on the setup and error cards. It is `aria-disabled`, described by the card heading, and a click or Space does nothing.
- **Files changed:**
  - **Audio:** `app/src/audio/{recorder-worklet,recorder,mic}.ts`.
  - **Model:** `app/src/model/level-warnings.ts`.
  - **Store:** `app/src/session/recording-session.ts`.
  - **UI:** `app/src/ui/components/{MicSelect,RecordButton,MicGate}.*`, `app/src/ui/screens/Record.tsx`, `app/src/ui/strings.ts`.
  - **Tests:** `app/tests/unit/{recorder-worklet,recorder,recording-take}.test.ts`, `app/tests/e2e/record.dev.spec.ts`.
- **Review:** 16 findings (low 13, false 3); the verification-gap lens found none.
  - Patched:
    - a single Record instance (focus survives the mic going live);
    - tests for the start message's `clipLevel`, count-in clip wiring, and Space on the focused disabled button;
    - comment wrapping.
  - The e2e clicks on the `aria-disabled` button now use `force: true` (fixed during verification).
  - Nothing deferred.
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 0, low 5.
- **Verification:** the full plan command exited 0: 605 unit tests, 102 Playwright tests, none flaky. `level_too_hot` saves `clipped: true` and `open_strings` saves `false`.
- **Residual risks:**
  - The disabled select's reason is not visible to sighted keyboard or touch users (tooltip per EXPERIENCE.md).
  - Recovered or abandoned takes have no `clipped` until story 3.11.
