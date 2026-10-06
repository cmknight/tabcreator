---
title: 'Recovered take metadata from its compressed copy (DS2)'
type: 'bugfix'
ticket: '8'
created: '2026-10-06'
status: 'draft'
route: 'oneshot'
route_source: 'auto'
review: ''
review_source: ''
lenses_ran: []
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
