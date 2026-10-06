---
title: 'Recovered take metadata from its compressed copy (DS2)'
type: 'bugfix'
ticket: '8'
created: '2026-10-06'
status: 'built'
baseline_revision: 'b9213c246d7b87676c4aeb1c8e3993ad06bda158'
route: 'oneshot'
route_source: 'auto'
review: 'quick'
review_source: 'auto'
lenses_ran: ['quick']
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** When recovery rebuilds an unfinished take that already has a whole compressed copy, it stores `durationMs` and `clipped` measured from the raw file. After raw append failures or an early storage-full, the raw file is shorter than the compressed audio the take keeps. The Library (6.1) shows that wrong duration (deferred item DS2).

**Approach:**
- In `session/recording-recovery.ts` `rebuild`, when the take keeps a compressed copy (found before the encode, or saved meanwhile), decode it with `audio/decode.ts` `decodeTakeAudio` (a new injected `decode` dep).
- Measure the duration and clipping from the decoded samples.
- If the decode fails or yields no samples, keep today's raw-based values.
- Takes with only a raw file, which recovery encodes itself, are unchanged.

</intent-contract>

## Implementation Notes

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass, including new recovery tests (a raw file shorter than its compressed copy stores the copy's duration and clipping; a decode failure falls back to raw; a raw-only take is unchanged).
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test --project=dev tests/e2e/recovery.dev.spec.ts tests/e2e/decode.dev.spec.ts` -- expected: pass.

## Review Triage Log

### 2026-10-06 — Review pass
- verdicts: 4 findings — high 0, medium 0, low 4, false 0, maybe-false 0
- findings:
  - `[low]` `[patch]` (quick) The handover-after-each-await test doesn't cover the new decode await — a test now hands over during the decode: nothing is patched and nothing navigates.
  - `[low]` `[patch]` (quick) The "saved meanwhile" branch is untested — a test is added: a copy saved during the encode is decoded for the duration.
  - `[low]` `[patch]` (quick) Clipping from a lossy decode can flag takes a normal stop would not — clipping now counts the raw samples plus only the decoded copy past them; a test is added.
  - `[low]` `[patch]` (quick) The module header doesn't describe the DS2 behaviour — a paragraph is added.

## Auto Run Result

**Status:** built, 2026-10-06.

**Summary:**
- **Duration:** when recovery rebuilds a take that keeps a compressed copy (found before the encode, or saved meanwhile), it decodes the copy through `audio/decode.ts` and stores its length as `durationMs`. That length can exceed the raw file after raw append failures or an early storage-full.
- **Clipping:** it counts the raw samples plus only the decoded copy past them.
- **Fallbacks:** an undecodable copy keeps the raw-based values; raw-only takes are unchanged.

**Files:**
- `app/src/session/recording-recovery.ts`: the `decode` dep, measurement and header.
- `app/src/session/recording-session.ts`: wires `decodeTakeAudio`.
- Tests: `app/tests/unit/recording-recovery.test.ts` (6 DS2 tests); `recording-take.test.ts` (fakes gain `decode`).

**Review:** quick, 4 findings, all low and patched.

**Follow-up review: not recommended.**

**Verification:**
- lint, typecheck, format:check and test pass (1588).
- The recovery and decode dev e2e pass (8).
