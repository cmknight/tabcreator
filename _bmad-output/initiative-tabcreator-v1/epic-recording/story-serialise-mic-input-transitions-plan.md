---
title: 'Serialise mic input transitions'
type: 'bugfix'
ticket: '2'
created: '2026-10-02'
status: 'built'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '343612b80cd40aca6ab5fc79f6e703c75ad8ae6c'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** In `recording-session.ts`, `selectMic` and the ended-track fallback share one `busy` boolean. When a newly selected track ends during `goLive`'s device listing, `ended()` sets `busy`. Then `selectMic`'s `finally` clears it while the fallback still runs. A second choice can then race the fallback. The losing path returns through `!holds(opened)` without closing its opened stream, so the mic stays captured.

There's a second fault: `ended()` judges "unplugged" from `snapshot.activeDeviceId`, which is empty while requesting. An unplug during the first open therefore shows the lost card instead of falling back. These defects come from epic 2's retrospective (A3, diff-scope findings 2, 3 and 7). Recording is about to add more transitions on top of this code.

**Approach:**
- Run every input transition (allow, switch, ended fallback) through one serialised queue in the store.
- Make each path close any input it opened but no longer holds.
- Judge an ended track by its own device.
- Stabilise the mic-select e2e unplug row under repeated runs (retro A4).

## Boundaries & Constraints

**Always:**
- **One queue.** Allow, switch and the ended handling run one at a time through a single serialised path; no shared boolean is set or cleared by more than one flow.
- **Switch while busy.** A `selectMic` that arrives while any transition runs is ignored, as now (story 2.7's rule).
- **Ended track.** A track ending is never dropped. Its handling runs after the transition in progress.
- **Allow.** `allowMic` keeps its guard: a no-op while requesting or live.
- **Close what you don't hold.** Any transition that opened an input which is no longer the store's input closes it before returning (stops its tracks and closes its context), unless that input is already closed.
- **Which device ended.** The ended handling judges the ended input's own device:
  - its listed id as resolved when it went live, if known;
  - else its track `deviceId`, when that is a real id (not Chrome's `default` or `communications`);
  - else the device is unresolved, which counts as not unplugged and shows the lost card (story 2.7's rule).
- **Refresh.** `refreshDevices` uses the input only when no transition is running, as now.
- **No other change.** Every existing recording-session test passes unchanged in intent, the public `RecordingSession` API and snapshot are unchanged, and nothing under `app/src/ui/` changes.

**Never:**
- No recorder, count-in or recording behaviour.
- No change to the 2.7 rules beyond the ended-device resolution above: an unplug with another device left falls back with a notice; a revoke or the only device gone shows the lost card.
- No change to `audio/fake-mic.ts` hooks.
- No new dependencies.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Select during fallback | live on A; unplug A; `selectMic('c')` before the fallback's default open resolves | the choice is ignored; afterwards exactly one open input (the default B) and `activeDeviceId` is B | none |
| Track ends during a switch | live on A; `selectMic('b')`; B's track ends while the post-switch device list is pending; then `selectMic('c')` | B's end is handled after the switch; exactly one open input at rest, matching `activeDeviceId`; no stream left unclosed | none |
| Unplug while requesting | `allowMic` on A with B also listed; A unplugged before live | the fallback opens B with the `switched` notice; exactly one open input = B | none |
| Revoke while requesting | as above but revoke (devices stay listed) | lost card (`mic-lost`); zero open inputs | `mic-lost` |
| Unresolved device | ended input reports `default` and no listed match | lost card, as in 2.7 | `mic-lost` |
| Concurrent switches | two `selectMic` calls back to back | the second is ignored, as now | none |
| Existing suite | all current tests | pass | none |

</intent-contract>

## Code Map

- **`app/src/session/recording-session.ts`** (407 lines; story 3.1 split out the watches):
  - `busy` (L133) is set and cleared in `selectMic` (L287-309) and `ended` (L317-357);
  - `holds()` (L239) and `goLive()` (L223-237) assign `input = opened` and bump `listSeq`;
  - `allowMic` (L267-285);
  - `refreshDevices` (L208-221) reads `busy`;
  - `activeId()` / `activeDevice()` resolve the listed id by `deviceId`, then `groupId` (audio/mic.ts);
  - `set()` calls the watch `transition()`s, which must stay one notify per transition.
- **`app/src/session/input-derivation.ts`:** `OpenedInput` (has `deviceId`, `groupId`, `close()`).
- **`app/tests/unit/recording-session.test.ts`:**
  - `setup()` / `devicesSetup` fakes;
  - the pending-promise pattern in "a choice while a switch runs is ignored";
  - the fake input `close` spies.

  Add the matrix tests here; each asserts the count of unclosed fake inputs.
- **`app/tests/e2e/mic-select.dev.spec.ts`:** the unplug rows (around `:188`, `:204`). `recordGum` already waits for `window.__fakeMic` (story 2.10).

## Tasks & Acceptance

**Execution:**
- [x] `app/tests/unit/recording-session.test.ts`: the matrix rows, written first against the current code (the race rows should fail), each asserting the open-input count and `activeDeviceId`.
- [x] `app/src/session/recording-session.ts`: the queue, close-what-you-don't-hold, and ended-device resolution; remove `busy`; update the header comment.
- [x] `app/tests/e2e/mic-select.dev.spec.ts`: make the unplug rows wait on real conditions (the notice or the card, plus the gUM log) so they pass repeated runs.

**Acceptance Criteria:**
- Given the unit suite, when it runs, then every matrix row passes and every pre-existing test passes unchanged in intent.
- Given `mic-select.dev.spec.ts`, when it runs with `--repeat-each=10 --workers=4 --retries=0` on the dev project, then every run passes.
- Given the full verification, when it runs, then it exits 0.

## Implementation Notes

- The queue (`enqueue` / `advance`) marks itself idle, or starts the next transition, before it settles the finished transition's promise. A caller that awaits `allowMic()` or `selectMic()` therefore sees the queue as it now is, and an immediate next `selectMic` is not ignored as busy. A transition starts synchronously when the queue is idle, so `requesting` and the pending switch choice still notify within the call.
- `allowMic` and `selectMic` apply their guards when called. `allow` checks its guard again when it starts, because a queued Allow may follow a transition that went live.
- `holds()` closes the input it no longer holds. A `WeakSet` of closed inputs makes the close idempotent, and `goLive` removes a reopened input from that set, because the unit fake returns the same object for every open.
- `goLive` records each input's resolved listed id in a `WeakMap` when the input goes live. `endedDeviceId` reads that id first, then the track's real id.
- A track that ends during a transition is still set live by that transition, and its queued handling then closes it and falls back or shows the lost card. The UI can show `live` on the dead input for one notify before the fallback.
- Unit matrix: on the old code, "track ends during a switch" and "unplug while requesting" failed. The other new rows passed on the old code. "Concurrent switches" is covered by the existing "a choice while a switch runs is ignored" test.

## Plan Change Log

## Review Triage Log

### 2026-10-02 — Review pass
- verdicts: 22 findings — high 0, medium 0, low 19, false 3, maybe-false 0
- findings:
  - `low` `patch` (blind) the `selectMic` interface JSDoc still says "while another switch runs" — reworded to "any transition".
  - `low` `patch` (blind) the `void enqueue(...)` ended callback leaves a rejection unhandled — `.catch` added.
  - `low` `patch` (blind) a task that throws synchronously wedges the queue with `running` stuck — `enqueue` starts the task in try/catch, so the task still starts within the call and the queue still advances.
  - `low` `reject` (blind) `closed.delete(opened)` exists for a test fake that reuses one object — production `openInput` returns a fresh object per stream; low.
  - `low` `reject` (blind) new branches untested (allow re-check, enqueue rejection, `communications`, await-then-switch) — low; the core races are tested.
  - `low` `reject` (blind) a switch whose new track dies still saves that `micDeviceId` — it self-heals: the next open's `requestPreferred` falls back to the default and clears it (2.7).
  - `low` `reject` (blind) the window of `live` with no input is wider — brief; recorded in Implementation Notes as a risk.
  - `low` `reject` (blind) the e2e only-device row still uses a fixed 300 ms wait — a negative check needs a bound; it passed 90/90 under repeated runs.
  - `false` `reject` (blind) no evidence the verification ran — the full command exited 0 and the repeat run passed 90/90 on my side.
  - `low` `reject` (blind) the race tests do not assert the notice or close-exactly-once — close is idempotent through the `closed` set; low.
  - `low` `reject` (edge) a dead input briefly committed live, with prefs saved — grouped with the `micDeviceId` row (self-heals).
  - `low` `reject` (edge) a never-settling task (an unanswered permission prompt) blocks the queue — the same as before: no input exists to end, and the switch is ignored while requesting.
  - `low` `patch` (edge) `ended` rejection unhandled — grouped with the `.catch` fix.
  - `low` `reject` (edge) a device omitted from both the go-live and the end-time list, then revoked, looks unplugged — needs the device to be unlisted twice while others remain; the refresh-resolution patch narrows it further.
  - `low` `reject` (edge, claim) the lost-card row sleeps a fixed 300 ms — grouped with the blind row.
  - `low` `patch` (verif) the `resolvedIds` (Chrome `default` by `groupId`) branch is never exercised by an ended-track test — test added.
  - `low` `patch` (verif, other) `resolvedIds` is frozen at go-live and ignores a later `devicechange` resolution — `refreshDevices` updates it; test added.
  - `low` `reject` (intent) the invariant is proved on fakes, not in the browser — unit tests by design; the e2e covers the plain unplug path with `liveBefore: 0`.
  - `low` `patch` (intent) `activeDeviceId` matching is checked only against one-to-one fakes — grouped with the `resolvedIds` test.
  - `low` `reject` (intent) some race windows are untested (a track ending during the switch's `requestMic`, an unplug while getUserMedia is pending) — no new input exists in those windows to leak.
  - `false` `reject` (intent) A4 has no repeat-run artifact — run on my side: 90/90 at `--repeat-each=10 --workers=4 --retries=0`.
  - `false` `reject` (intent) scope beyond the ticket (ended judged by its own device, unplug while requesting now falls back, refresh holds off during allow) — the plan's contract and Verify require these; retro finding 7.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` (repo root, `~/.cargo/bin` on PATH) -- expected: all exit 0
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'cd app && pnpm exec playwright test tests/e2e/mic-select.dev.spec.ts --project=dev --repeat-each=10 --workers=4 --retries=0'` (`~/.cargo/bin` on PATH) -- expected: all passed
- `git diff --stat <baseline_revision> -- app/src/ui` -- expected: no output

## Auto Run Result

- **Summary:** `recording-session.ts` runs allow, switch and ended-track handling through one serialised queue (`enqueue` / `advance`), replacing the shared `busy` boolean.
  - A switch is ignored while any transition runs.
  - An ended track's handling is queued, never dropped.
  - Any input a transition opened but no longer holds is closed exactly once.
  - An ended input is judged by its own device: the listed id resolved at go-live or at a later refresh, else its real track id, else unresolved (the lost card).
  - An unplug while requesting now falls back instead of showing the lost card.
  - The mic-select unplug e2e rows wait on the getUserMedia log.
- **Files changed:**
  - `app/src/session/recording-session.ts`: the queue, `release`, `holds`, `endedDeviceId`, refresh resolution and JSDoc.
  - `app/tests/unit/recording-session.test.ts`: the serialised-transitions block, including two Chrome-`default`/groupId tests.
  - `app/tests/e2e/mic-select.dev.spec.ts`.
- **Review:** 22 findings (low 19, false 3); nothing high or medium.
  - Five low entries were patched:
    - the JSDoc;
    - the `.catch` on the ended callback;
    - the synchronous-throw guard (try/catch, so tasks still start within the call);
    - the refresh-time resolution;
    - the groupId-resolution tests.
  - Nothing deferred. Rejections are in the Review Triage Log.
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 0, low 5.
- **Verification:**
  - The full plan command exited 0: 487 unit tests, 76 Playwright tests, none flaky.
  - `mic-select.dev.spec.ts` passed 90/90 at `--repeat-each=10 --workers=4 --retries=0`.
  - `app/src/ui` is unchanged.
- **Residual risks:**
  - A track that ends mid-transition is committed `live` for one notify before its queued handling runs.
  - A switch to a device that dies at once saves it as `micDeviceId` until the next open clears it.
