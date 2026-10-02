---
title: 'Refactor sweep'
type: 'refactor'
ticket: '6'
created: '2026-10-02'
status: done
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: 'bbd5962bfe9b78f86fb9959228879baa564006b0'
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      S8: a real Rust panic in the wasm engine has never been shown to surface as a catchable worker error with the same instance serving later requests (US-0.2 panic AC).
    evidence: |-
      Story 1.2 tests the panic path only with a JS throw in a fake engine (deferred-work.md entry from story 1.2). Owner: US-4.5, where analysis in the app owns real-wasm error paths.
    location: >-
      app/src/engine/engine-worker.ts; engine crate
    severity: medium
  - summary: >-
      S9: a raw file locked by an open sync access handle survives deleteTake.
    evidence: |-
      Story 1.3 build notes. The OPFS worker keeps the handle open until close, so removeEntry on the locked file fails or is skipped. Owner: US-3.2 (start-up orphan scan cleans leftovers).
    location: >-
      app/src/storage/opfs-worker.ts; app/src/storage/audio-store.ts deleteRaw
    severity: low
  - summary: >-
      S10: reopening a raw writer for a take appends after the existing data rather than starting fresh.
    evidence: |-
      Story 1.3 build notes; createOpfsHandler append writes at getSize(). Owner: US-3.2, whose recovery flow defines reopen semantics.
    location: >-
      app/src/storage/opfs-worker.ts
    severity: low
  - summary: >-
      S11: two legato_slurs pull-off notes carry a strong 2nd harmonic that may mislead pitch detection.
    evidence: |-
      Story 1.4 build notes. Owner: US-8.4, whose accuracy benchmark decides whether the fixture is fit or needs regenerating.
    location: >-
      testdata/synth/legato_slurs*; tools fixture generator
    severity: low
  - summary: >-
      S12: if the GitHub API call in the head-of-main check fails, the deploy job fails instead of deploying or skipping.
    evidence: |-
      Story 1.5 residual risk. Owner: US-8.1 (offline/PWA deploy hardening).
    location: >-
      .github/workflows/ci.yml deploy job
    severity: low
---

<intent-contract>

## Intent

**Problem:** Stories 1–5 left named follow-ups in their build records (`## Auto Run Result`, Implementation Notes) and deferred review findings (plan `deferred:` lists, `_bmad-output/implementation-artifacts/deferred-work.md`). Some are closed by events since, some are code paths patched in review but never tested, and some belong to later stories.

**Approach:** Take every named item as the sweep's scope and give each one a disposition: close it with cleanup code or tests, close it on recorded evidence, or defer it explicitly to the story that owns it. Cleanup only: no new features or behaviour.

## Boundaries & Constraints

**Always:** Every scope item below ends closed or deferred, recorded in `## Auto Run Result`. Refactors keep observable behaviour identical; existing tests stay green unchanged except where a test is extended. Deferrals go into this plan's `deferred:` frontmatter with the owning story named.

**Never:** No feature work, no changes to `model/types.ts`, no CSP string change, no new dependencies, no edits to other stories' plans or to existing `deferred-work.md` entries (append-only).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| OPFS close, flush throws | open writer; `flush()` throws on close | handle still closed; take removed from open set; error reported | close reply is an error |
| RawWriter close retry | first `close()` request rejects | `close()` rejects; a second `close()` sends the request again and resolves | `storage-failed` first time |
| Fake mic, no gesture | `AudioContext.resume()` never settles, state stays `suspended` | `getUserMedia` rejects `NotAllowedError` after the timeout; context closed; next call retries | DOMException |
| Fake mic, retry succeeds | after the above, resume resolves and state is `running` | next `getUserMedia` resolves with a stream | none |

</intent-contract>

## Code Map

Scope, collected from the five plans and `deferred-work.md` (commit `bbd5962`):

| # | Item (source) | Disposition |
|---|---|---|
| S1 | 1.3: worker `close()` try/finally has no test | close: extract handler, unit test |
| S2 | 1.3: `RawWriter.close()` retry has no test | close: unit test |
| S3 | 1.3: narrowed ESLint dev-import selector unverified | close on evidence: `app/src/lint-rules.test.ts` has the alternate-branch rejection case |
| S4 | 1.4: fake mic `NotAllowedError` timeout has no test | close: unit test |
| S5 | 1.4 deferred: fixture WAV bytes may differ on CI | close on evidence: CI run 36958117778 fixtures job passed on GitHub |
| S6 | 1.5 deferred: workers run without CSP on Pages | close on evidence: owner accepted, epic Decision 2026-10-02, spine AD-13 limitation |
| S7 | 1.5: head-of-main check and `deploy-pages` never ran | close on evidence: run 36958117778 deploy job succeeded (`current=true`), site live |
| S8 | 1.2 deferred-work: real Rust panic → catchable, instance keeps serving | defer to US-4.5 (analysis in the app owns real-wasm error paths) |
| S9 | 1.3: raw file locked by an open writer survives `deleteTake` | defer to US-3.2 (start-up orphan scan) |
| S10 | 1.3: reopening a raw writer appends after existing data | defer to US-3.2 (recovery defines reopen semantics) |
| S11 | 1.4: two `legato_slurs` pull-offs have a strong 2nd harmonic | defer to US-8.4 (accuracy benchmark decides fixture fitness) |
| S12 | 1.5: GitHub API failure fails the deploy job | defer to US-8.1 (offline/PWA deploy hardening) |

Code for S1, S2, S4:
- `app/src/storage/opfs-worker.ts` -- module-level `handles` map and `open/append/close`, `self.onmessage` at top level. Mirror `app/src/engine/engine-worker.ts`: export a factory (e.g. `createOpfsHandler(getDirectory)`) and bootstrap only when `WorkerGlobalScope` exists, so tests import it with fake handles.
- `app/src/storage/audio-store.ts` -- `RawWriter.close()` resets `closed` on rejection; `createAudioStore({ createWorker })` already accepts a fake worker (`app/tests/unit/audio-store.test.ts`).
- `app/src/audio/fake-mic.ts` -- `RESUME_TIMEOUT_MS`, `Promise.race(ctx.resume(), timeout)`, rejects `NotAllowedError`, closes the context, resets the cache.

## Tasks & Acceptance

**Execution:**
- [x] `app/src/storage/opfs-worker.ts`, `app/tsconfig.worker.json` (if needed) -- extract the handler factory with injectable directory access; keep message protocol and behaviour.
- [x] `app/tests/unit/opfs-worker.test.ts` -- fake sync handles: open/append/close round-trip, append failure truncates back, close with throwing `flush()` still calls `close()` and frees the take.
- [x] `app/tests/unit/audio-store.test.ts` -- RawWriter close retry row.
- [x] `app/tests/unit/fake-mic.test.ts` -- jsdom with stubbed `AudioContext`, `fetch`, `navigator.mediaDevices` and fake timers: no-gesture row and retry row.
- [x] this plan's `deferred:` -- S8–S12 with owner and evidence.

**Acceptance Criteria:**
- Given the full verification, when it runs, then it exits 0 with the new tests included and no existing test changed except extensions.
- Given `## Auto Run Result`, when read, then S1–S12 each show closed (with test or evidence) or deferred (with owning story).

## Implementation Notes

- `opfs-worker.ts` now exports `createOpfsHandler(getDirectory, post)`, which owns the handle map and the in-order queue and returns a per-message function whose promise settles once the reply is posted. The worker bootstraps only when `WorkerGlobalScope` exists, as in `engine-worker.ts`. `SyncAccessHandle` and `OpfsRoot` are structural so the file also typechecks under the DOM lib that `tsconfig.node.json` uses for tests; no `tsconfig.worker.json` change was needed.
- `fake-mic.ts`: `RESUME_TIMEOUT_MS` is now exported so the test advances exactly to the timeout; no behaviour change.
- `fake-mic.test.ts` fakes only `setTimeout`/`clearTimeout` and polls with `setImmediate` (bounded by real `Date`) until `resume()` is called, because the lazy `?url` fixture import does real I/O whose first transform can take a while.

## Plan Change Log

## Review Triage Log

### 2026-10-02 — Review pass
- verdicts: 18 findings — high 0, medium 0, low 11, false 7, maybe-false 0
- findings:
  - `false` `reject` (edge) retried close resolves `done` though the flush failed — every `append` flushes before replying (`opfs-worker.ts` append), so nothing unflushed remains at close.
  - `false` `reject` (edge) a throwing `post` leaves the queue rejected — replies are plain `{type, reqId, name, message}` objects that cannot fail structured clone.
  - `low` `reject` (edge) a `close()` error masks the flush error — needs two failures in one call; fix adds error juggling.
  - `false` `reject` (blind) close retry reports false success — as above.
  - `false` `reject` (blind) one failed `post` stalls the worker — as above.
  - `low` `reject` (blind) `as unknown as Promise<OpfsRoot>` skips the structural check — the real API is used by the e2e raw round-trip; tightening is cosmetic.
  - `false` `reject` (blind) worker bootstrap untested — `storage.dev.spec.ts` drives a real open/append/close round-trip through it in CI.
  - `low` `reject` (blind) short-write, flush-after-write and rollback-failure branches untested — extra coverage beyond the sweep's named items.
  - `low` `reject` (blind) failed `open` untested — extra coverage beyond scope.
  - `low` `reject` (blind) fake-mic unit suite covers only the timeout path — the other paths are covered by the six dev-project Playwright specs.
  - `low` `reject` (blind) timer clearance not asserted — a leftover 2 s timer only resolves a settled race.
  - `low` `reject` (blind) `until` deadline equals the test timeout — failure still reports, only less specifically.
  - `false` `reject` (intent) dispositions are not in the patch — the review diff excluded `_bmad-output`; the plan records every disposition and is committed.
  - `low` `reject` (intent) some residual risks (quota simulated, 30 MB fixtures, `CI=1 pnpm e2e` needs `dist`) have no disposition — accepted trade-offs recorded in their own plans; fix would edit this build's plan.
  - `low` `reject` (intent) scope not agreed with the owner — the auto workflow sets scope from the ticket's named sources.
  - `low` `reject` (intent) no GitHub CI run covers this commit yet — the local equivalent passed; the next push runs it.
  - `false` `reject` (intent) evidence closures rely on runs outside the change — the ticket allows closing on recorded evidence.
  - `low` `reject` (intent) unit tests use fakes, not the browser surface — the browser paths stay covered by the existing e2e specs.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` -- expected: all exit 0
- `grep -n "alternate\|DEV ? null" app/src/lint-rules.test.ts` -- expected: the alternate-branch case exists (S3 evidence)

## Auto Run Result

- **Summary:** all twelve scope items are dispositioned: S1, S2, S4 closed with new unit tests (S1 after extracting the OPFS worker handler); S3, S5, S6, S7 closed on recorded evidence; S8 to S12 deferred to their owning stories in `deferred:`. No behaviour change.
- **Files changed:**
  - `app/src/storage/opfs-worker.ts`: handler extracted into `createOpfsHandler`; worker-scope bootstrap; same message protocol.
  - `app/src/audio/fake-mic.ts`: `RESUME_TIMEOUT_MS` exported.
  - `app/tests/unit/opfs-worker.test.ts` (new), `app/tests/unit/fake-mic.test.ts` (new), `app/tests/unit/audio-store.test.ts` (one test added).
- **Scope dispositions:**
  - S1 closed: `opfs-worker.test.ts` "closes the handle and frees the take when flush throws on close" (handle closed, error reply, append then fails `InvalidStateError`, reopen creates a fresh handle); plus round-trip, not-open append, truncate-on-failed-append and ordering tests.
  - S2 closed: `audio-store.test.ts` "lets close() be retried after the close request fails" (first close rejects `storage-failed`, second resends and resolves, third sends nothing).
  - S3 closed on evidence: `app/src/lint-rules.test.ts:91` "rejects src/App.tsx loading dev/ in the alternate branch of the DEV guard" (`import.meta.env.DEV ? null : import(...)`).
  - S4 closed: `fake-mic.test.ts` covers both matrix rows: no settle before `RESUME_TIMEOUT_MS`, then `NotAllowedError`, context closed, source not started; the next call builds a new context, starts it and resolves with a stream.
  - S5 closed on evidence: CI run 36958117778 (head `aeddc58`) `fixtures` job succeeded on GitHub.
  - S6 closed on evidence: epic Decision (user approved, 2026-10-02) and spine AD-13 "Accepted limitation (2026-10-02)".
  - S7 closed on evidence: run 36958117778 `deploy` job succeeded; the "Deploy to GitHub Pages" step (gated on `current=true`) ran; https://cmknight.github.io/tabcreator/ returns 200.
  - S8 deferred to US-4.5; S9 and S10 to US-3.2; S11 to US-8.4; S12 to US-8.1.
- **Review:** 18 findings (low 11, false 7); no patches, nothing deferred. Every rejection and its reason is in the Review Triage Log.
- **Follow-up review recommended:** false. No entries were patched.
- **Verification:**
  - The full plan command exited 0: 13 Vitest files / 157 tests, 16 Playwright tests (run with `~/.cargo/bin` on `PATH` so `wasm-pack` resolves).
  - `grep -n "alternate\|DEV ? null" app/src/lint-rules.test.ts` matches lines 91 and 95.
  - No existing test was changed; `audio-store.test.ts` only gained a test.
- **Residual risks:** the fake-mic test depends on the lazy fixture import finishing within 5 s of real time; it is the only real I/O in that test.
