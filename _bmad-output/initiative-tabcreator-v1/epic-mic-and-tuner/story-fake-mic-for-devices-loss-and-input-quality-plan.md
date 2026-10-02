---
title: 'Fake mic for devices, loss and input quality'
type: 'feature'
ticket: '2'
created: '2026-10-02'
status: done
baseline_revision: '59b6d9cc0ceb9d520565a4eebed773e2ebcc92d3'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      The mic-setup dev spec comment still says the fixture plays once; every stream now plays it from the start.
    evidence: |-
      Story 2.2 made each getUserMedia stream start its fixture at 0. The comment near "Re-enter straight away (the fixture plays once)" predates that; the test does not depend on it. The file belongs to concurrent story 2.1.
    location: >-
      app/tests/e2e/mic-setup.dev.spec.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** The dev fake mic serves one device, ignores `deviceId`, plays its fixture once across all streams, and has no way to simulate device loss, revoked access, getUserMedia failures or low-quality inputs, so later stories cover mic errors (2.5), mic choice (2.7) and the quality warning (2.8) with no way to test them.

**Approach:** Extend `installFakeMic` to take a list of fixtures (one device each), honour `deviceId` constraints, start the fixture fresh for each stream, and return a controls object (`unplug`, `revoke`, `failNext`, `configure`) that `main.tsx` exposes as `window.__fakeMic` in dev builds only.

## Boundaries & Constraints

**Always:** Fake mic code stays only in `app/src/audio/fake-mic.ts` plus the `import.meta.env.DEV` branch in `main.tsx`; the production bundle still has no `fakeMic`, `testdata` or `.wav`. A plain `?fakeMic=<one fixture>` keeps today's behaviour (one device labelled `Fake mic: <fixture>`, id `fake-mic-<fixture>`). The NotAllowedError-without-gesture plus retry behaviour stays. A track that the app stops itself does not fire `ended`.

**Never:** No app/UI/session code changes beyond `main.tsx`. No faking of `navigator.permissions` (story 2.5's area). No re-plug hook. No URL syntax for overrides (overrides go through `configure`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Two devices | `?fakeMic=open_strings,silence_60s` | enumerateDevices lists 2 audioinputs in URL order, distinct deviceId/groupId; default (no deviceId) = first | — |
| Duplicates / unknowns | `?fakeMic=a,a,nope` | unknown names dropped, duplicates collapsed; all unknown → no devices | getUserMedia → `NotFoundError` |
| deviceId exact | `{audio:{deviceId:{exact:id}}}` | stream from that device; string[] accepted | unknown/unplugged id → `OverconstrainedError` with `constraint` `deviceId` |
| deviceId ideal | bare string, string[] or `{ideal}` | that device if listed, else first listed | none listed → `NotFoundError` |
| Unplug | `__fakeMic.unplug(id)` | device leaves the list; each of its live tracks gets `readyState` `ended` and an `ended` event; then one `devicechange` on `navigator.mediaDevices` | unknown id → throws `Error` |
| Revoke | `__fakeMic.revoke()` | every live track ends (as unplug); devices stay listed; later calls work normally | — |
| Inject failure | `__fakeMic.failNext('NotReadableError', msg?)` | next getUserMedia only rejects with `DOMException` of that name; the call after succeeds | — |
| Overrides | `__fakeMic.configure(id, {sampleRate:16000, label:'AirPods Pro'})` | later streams' `track.getSettings()` reports `sampleRate` 16000 and `deviceId`; `track.label` and enumerateDevices label are `AirPods Pro`; label change fires `devicechange` | unknown id → throws `Error` |
| Restart per stream | stream 2 opened after stream 1 has run past the fixture's end | stream 2 hears the fixture from its start | — |

</intent-contract>

## Code Map

- `app/src/audio/fake-mic.ts` -- whole implementation. Reuse `FIXTURES` glob, `RESUME_TIMEOUT_MS` race and the NotAllowedError/retry logic. Today one shared `AudioContext` plays the fixture once and every stream clones its track; change it to one context per sample rate (cached, cleared on start failure), the decoded buffer cached per fixture+rate, and per stream a new `BufferSourceNode` → `MediaStreamAudioDestinationNode` started at 0. Patch each returned track instance: `getSettings()` adds `deviceId`, `groupId`, `sampleRate`, `channelCount: 1`; `label` getter returns the device label; `stop()` also stops/disconnects the source and drops the track from the live set. Ending a track = native `stop()` + `dispatchEvent(new Event('ended'))`. Use `new OverconstrainedError('deviceId', msg)` when the constructor exists, else a `DOMException` named `OverconstrainedError` with a `constraint` property.
- `app/src/main.tsx:14-20` -- split `fakeMic` on `,` (trim, drop empty) and assign the returned controls to `window.__fakeMic`; keep it inside the DEV branch.
- `app/tests/unit/fake-mic.test.ts` -- jsdom stubs (`FakeAudioContext`, `FakeMediaStream`). Update stubs for per-stream sources/destinations and patchable tracks (EventTarget with `stop`, `getSettings`, `readyState`); keep the existing start-up test passing.
- `app/tests/e2e/fake-mic.dev.spec.ts` -- `open`, `capture`, `tryGetUserMedia` helpers to reuse; the existing tests must stay green. The single-device label `Fake mic: open_strings` is asserted.
- `testdata/README.md` -- the "plays once, from the first getUserMedia call" paragraph is now wrong.
- `.github/workflows/ci.yml:95-106` -- the production bundle check (read only).

## Tasks & Acceptance

**Execution:**
- [ ] `app/src/audio/fake-mic.ts` -- change the signature to `installFakeMic(fixtures: string[]): FakeMicControls`, export the `FakeMicControls` type, implement the matrix, update the header doc -- the core of the story.
- [ ] `app/src/main.tsx` -- parse the list and expose `window.__fakeMic` (declare the global type in fake-mic.ts) -- so specs can drive the hooks.
- [ ] `app/tests/unit/fake-mic.test.ts` -- adapt the stubs; add unit tests for list parsing (dedupe/unknown), the deviceId exact/ideal/unknown cases, failNext being one-shot, and unplug/revoke ending tracks without ending tracks the app stopped itself.
- [ ] `app/tests/e2e/fake-mic.dev.spec.ts` -- add dev specs: two listed devices; unplug fires devicechange and ends the track (`readyState` + `ended` event) and drops the device; revoke ends the track while the device stays listed; failNext NotReadableError then a success; configure 16000/`AirPods` shows in getSettings, track.label and enumerateDevices; on `bend_up` (5.9 s), a second stream opened 6.2 s after the first captures > −40 dBFS in its first 1.5 s.
- [ ] `testdata/README.md` -- describe the list form, per-stream restart and the `window.__fakeMic` hooks briefly.

**Acceptance Criteria:**
- Given the dev server with `?fakeMic=open_strings,silence_60s`, when a spec calls enumerateDevices and the hooks, then every matrix row behaves as stated.
- Given `pnpm build`, when the CI grep for `fakeMic|testdata` and the `.wav` find run over `app/dist`, then neither finds anything.
- Given the existing fake-mic dev and unit specs, when run, then they pass unchanged except for the `installFakeMic` call signature.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

Hooks go on `window.__fakeMic` (double underscore like other test-only globals) and are reset by reload; specs call them through `page.evaluate`. `revoke` only ends tracks. A spec that wants the next request denied adds `failNext('NotAllowedError')`, which keeps the hooks orthogonal. `configure` applies to streams opened afterwards; live streams keep their settings.

## Verification

**Commands:**
- `cd app && pnpm lint && pnpm typecheck && pnpm test && pnpm format:check` -- expected: all pass
- `cd app && pnpm exec playwright test --project=dev` -- expected: all fake-mic and storage dev specs pass
- `cd app && pnpm build && ! grep -rE 'fakeMic|testdata' dist && [ -z "$(find dist -name '*.wav')" ]` -- expected: exit 0

### 2026-10-02 — Review pass
- verdicts: 28 findings — high 0, medium 4, low 17, false 7, maybe-false 0
- findings:
  - `[medium]` `[patch]` (blind) unplug during a pending getUserMedia resolves a live, never-ended track for an unlisted device — pickDevice runs before `await prepare`, nothing re-checks; fix: re-check `device.plugged` after the await and reject as pickDevice would, plus a unit test.
  - `[low]` `[patch]` (blind) configure(sampleRate) during a pending open makes getSettings report the new rate while audio runs on the old context — fix: report `ctx.sampleRate`.
  - `[low]` `[reject]` (blind) cloned tracks escape the patched label/settings/live set — real, but no consumer clones (mic.ts does not); the fix adds clone interception.
  - `[false]` `[reject]` (blind) revoke does not deny later calls — the intent defines revoke as "track ends, device stays listed"; denial is modelled per call with failNext('NotAllowedError').
  - `[low]` `[reject]` (blind) no replug hook — not in the intent; adds public surface.
  - `[low]` `[reject]` (blind) no blank-labels-before-permission state — not in the intent; adds an option.
  - `[low]` `[reject]` (blind) ended/devicechange dispatched synchronously — real but specs await between steps; async dispatch adds complexity for no named failing consumer.
  - `[low]` `[reject]` (blind) AudioContexts never closed — one per distinct rate; specs use at most two; closing adds lifecycle logic.
  - `[low]` `[reject]` (blind) failNext('OverconstrainedError') lacks `constraint` — unlikely use; needs a branch.
  - `[low]` `[reject]` (blind) main.tsx list parsing untested for empty/whitespace entries — the comma path is covered by the two-device e2e specs; edge spellings are not used.
  - `[low]` `[reject]` (blind) unit gaps for decode-failure retry and cleanup races — retry is covered by the e2e fixture-load-failure spec; the unplug race gets a test with its patch.
  - `[low]` `[reject]` (blind) restart e2e is slow (≈8 s) and tied to bend_up's length — the generator is deterministic, so the length is fixed; acceptable runtime.
  - `[low]` `[reject]` (blind) README omits throw-on-unknown-id and exact vs ideal details — the source doc comments state them; the README summary is enough.
  - `[medium]` `[patch]` (edge) revoke/unplug while getUserMedia awaits prepare opens a never-ended track — same root cause as the first row; patched by the post-await plugged check (a revoke race resolving is consistent with later calls working).
  - `[low]` `[patch]` (edge) configure sampleRate mid-open misreports the rate — same as the second row; patched.
  - `[false]` `[reject]` (edge) invalid sampleRate in configure — getUserMedia then rejects loudly with the AudioContext's NotSupportedError; correct loud failure.
  - `[low]` `[reject]` (edge) a cached context later suspended keeps a resolved running promise — specs never suspend the fake contexts; guard adds branches.
  - `[false]` `[reject]` (edge) destination stream with no audio track after start — MediaStreamAudioDestinationNode always carries one audio track; the throw is unreachable.
  - `[low]` `[reject]` (edge) clone escapes the fake — same as the clone row above.
  - `[medium]` `[patch]` (edge) unplugged exact id during an in-flight open still yields a stream — same root cause as the first row; patched.
  - `[low]` `[reject]` (edge) the existing start-up unit assertion changed beyond the call signature — real (tracks are now EventTargets, so the check maps `kind`); the fix would edit this plan's claim.
  - `[medium]` `[patch]` (verification-gap) unplug during a pending getUserMedia leaves an orphan track — same root cause as the first row; patched.
  - `[low]` `[defer]` (verification-gap) stale "the fixture plays once" comment in app/tests/e2e/mic-setup.dev.spec.ts — real, caused by per-stream restart, but the file belongs to concurrent story 2.1 (owner asked others not to touch it); deferred and owner notified.
  - `[false]` `[reject]` (intent) the app's mic code is never driven through the hooks — the intent is test support verified by fake-mic dev specs; slices 5, 7 and 8 drive the app.
  - `[false]` `[reject]` (intent) "reporting those settings" proves little — the intent asks for reported settings, and the audio really runs on a 16 kHz context (unit-asserted).
  - `[false]` `[reject]` (intent) revoke follows the narrow reading — the intent's parenthetical defines it; see the revoke row.
  - `[low]` `[reject]` (intent) restart check does not prove sample 0 — the unit test asserts `start(0)` on a new source per stream.
  - `[false]` `[reject]` (intent) bundle check not demonstrated — it was run in verification (`vite build`, grep and .wav find over dist found nothing).

## Auto Run Result

- **Summary:** the dev fake mic now serves `?fakeMic=a,b` as one device per fixture and honours `deviceId` (`exact` → `OverconstrainedError`, bare or `ideal` → fallback). Each stream plays its fixture from the start. `window.__fakeMic` exposes `unplug`, `revoke`, `failNext` and `configure` (sample rate and label) in dev builds only.
- **Files changed:**
  - `app/src/audio/fake-mic.ts`: multi-device fake mic, per-stream sources, patched tracks and the control hooks.
  - `app/src/main.tsx`: parses the fixture list and assigns `window.__fakeMic`, inside the DEV branch.
  - `app/tests/unit/fake-mic.test.ts`: stubs updated; 10 new tests (list, deviceId, restart, hooks, unplug during a pending open).
  - `app/tests/e2e/fake-mic.dev.spec.ts`: 6 new dev specs, one per Verify item.
  - `testdata/README.md`: documents the list form, per-stream restart and the hooks.
- **Review findings:** 28 in total.
  - **Patched (2 entries):** the unplug during a pending open (medium; four rows share this root cause) and the stale sample rate in `getSettings` (low; two rows).
  - **Deferred (1):** the stale comment in `mic-setup.dev.spec.ts`. That file belongs to concurrent story 2.1.
  - **Rejected:** every other row, each with its reason in the triage log above.
- **Follow-up review recommended:** false. Patched at entry verdict: high 0, medium 1, low 1.
- **Verification:** run through `npm run` and `node_modules/.bin`, because pnpm is not installed. All of the following passed:
  - lint, typecheck, vitest (297) and format:check;
  - Playwright `--project=dev`, 18/18, with the web servers started by hand because the config's local build step calls pnpm;
  - `vite build`, with no `fakeMic`/`testdata` match and no `.wav` in `dist`.
- **Residual risks:**
  - A `configure` label change during a pending open still reaches the new track. This is harmless.
  - Cloned tracks are not patched.
  - `revoke` ends tracks only; later calls succeed unless `failNext` is used.
  - The working tree also holds uncommitted work from concurrent builds of 2.1 and 2.4. This run commits only its own paths.
