---
title: 'Mic errors and recovery'
type: 'feature'
ticket: '5'
created: '2026-10-02'
status: 'built'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '8a28bf7ff705588af16d946fe91245c750fa8030'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/EXPERIENCE.md'
warnings: ['oversized']
deferred:
  - summary: >-
      An OS-level mic block (for example macOS privacy settings) reaches the app as NotAllowedError and shows the site-settings steps, which cannot fix it.
    evidence: |-
      mic.ts maps NotAllowedError to mic-denied by name only. Chrome reports a system-level block with the same name (message "Permission denied by system") while the site permission is granted. Needs a copy decision for an OS-block card (or a step added to the denied card); candidate owner US-8.3 (Chrome support) or a copy edit before epic 2 closes.
    location: >-
      app/src/audio/mic.ts
    severity: medium
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** After 2.1 a failed or lost microphone shows the bare setup card with no explanation, a returning player must click Allow microphone every visit, and a revoked or vanished mic leaves the meter live at zero.

**Approach:** Map every `getUserMedia` failure to its AD-10 code and show it in the setup card with a message, numbered recovery steps and a Try again that needs no reload; show "Microphone access was lost" when the live track ends; on return, re-request only when the Permissions API says the mic is granted; announce each error through 2.3's announcer.

## Boundaries & Constraints

**Always:** Codes: `NotAllowedError`, `SecurityError` → `mic-denied`; `NotFoundError`, `OverconstrainedError` → `mic-no-device`; `NotReadableError`, `AbortError` → `mic-in-use`; anything else → `mic-failed`; live track `ended` → `mic-lost`. The mapping lives in `audio/mic.ts` (AD-2, AD-10). `navigator.permissions.query({ name: 'microphone' })` is called only in `audio/`; a rejection or any state but `granted` shows the setup card. Error card per EXPERIENCE.md State Patterns and the record mockup (c): danger edge, mic-off icon, h2, one sentence, numbered steps, Try again; the card stays in place. Try again calls the same request path, never reloads, never retries by itself. The error h2 is announced assertively through `announce()` from `ui/a11y/announcer.ts`; the card has no `role="alert"` or `aria-live` (AD-18, lint). On `mic-lost` the store closes the input before showing the card. Copy verbatim in `ui/strings.ts`; colours only from theme tokens.

**Never:** No device fallback or unplug toast when other devices remain (story 2.7 refines `ended` handling then); no recording behaviour (Recording epic); no meter changes (2.6); no edits to `audio/fake-mic.ts` (2.2's hooks: `window.__fakeMic.failNext(name)`, `revoke()`, `unplug(id)`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Denied | `failNext('NotAllowedError')`, click Allow | denied card with its steps; announced assertively | `mic-denied` |
| No device | `failNext('NotFoundError')` | no-device card | `mic-no-device` |
| In use | `failNext('NotReadableError')` | in-use card | `mic-in-use` |
| Failed | `failNext('TypeError')` | failed card | `mic-failed` |
| Try again | any error card, next request succeeds | live bar, one new `getUserMedia` call, no reload | none |
| No loop | error card left alone | no further `getUserMedia` calls | none |
| Revoke | live, `revoke()` | lost card; input closed; Try again recovers | `mic-lost` |
| Only device unplugged | live, `unplug(<the one device>)` | lost card | `mic-lost` |
| Return, granted | `micGranted` true, permission `granted`, open Record | live without clicking; one `getUserMedia` call | none |
| Return, not granted | `micGranted` true, permission `prompt` or `denied`, or query rejects | setup card; zero calls before the click | none |
| Production | production build, open Record | zero `getUserMedia` calls before Allow microphone | none |

**Decision (user, 2026-10-02): error card copy, verbatim:**
- **Denied** (mockup, verbatim): "Microphone access is blocked" / "Chrome is blocking the microphone for this site. To allow it:" / 1 "Click the site settings icon at the left end of the address bar." 2 "Turn on Microphone." 3 "Come back here and choose Try again."
- **No device:** "No microphone found" / "Chrome can't find a microphone. To fix it:" / 1 "Plug in a microphone or headset, or turn on your built-in mic." 2 "If your computer has a mic mute switch or key, turn it off." 3 "Come back here and choose Try again."
- **In use:** "Your microphone is busy" / "Another app or tab is using the microphone. To free it:" / 1 "Close apps that use the mic, such as video calls." 2 "Close other browser tabs that are using the microphone." 3 "Come back here and choose Try again."
- **Failed:** "The microphone didn't start" / "Something went wrong opening the microphone. To fix it:" / 1 "Unplug the microphone and plug it back in." 2 "Check it works in your computer's sound settings." 3 "Come back here and choose Try again."
- **Lost:** "Microphone access was lost" (EXPERIENCE) / "The microphone stopped or access was turned off. To get it back:" / 1 "Check the microphone is still plugged in." 2 "Check Microphone is still allowed in the site settings icon at the left end of the address bar." 3 "Choose Try again."

</frozen-after-approval>

## Code Map

Builds on 2.1 (`e5700b3`), 2.2 (`e6b9bdb`), 2.3 (`cd91c52`), all done.
- `app/src/audio/mic.ts` -- `requestMic` currently wraps every rejection as `AppError('mic-failed')`; add the code map and `micPermission(): Promise<'granted' | 'prompt' | 'denied' | 'unknown'>`; expose the track's `ended` to the caller (e.g. `openInput` takes an `onEnded` callback).
- `app/src/session/recording-session.ts` -- states `setup | requesting | live | error`, `errorCode`; keeps `AppError` codes from `audio/`. Add `mic-lost` on track end (close input), and `resume()` that checks `micGranted` (via `loadPrefs`) and `micPermission()` before calling the existing request path.
- `app/src/ui/screens/Record.tsx`, `Record.module.css` -- `MicSetupCard` renders setup only; add the error variant and call `recordingSession.resume()` on mount.
- `app/src/ui/strings.ts` -- add the copy from the decision below.
- `app/src/ui/a11y/announcer.ts` -- `announce(message, 'assertive')`.
- Tests to extend: `app/tests/unit/mic.test.ts`, `recording-session.test.ts`, `app/tests/e2e/mic-setup.dev.spec.ts` / `mic-setup.spec.ts` (prod), `mic-helpers.ts` (getUserMedia counter).

## Tasks & Acceptance

**Execution:**
- [x] `app/src/audio/mic.ts` -- error code map, `micPermission()`, track-ended callback.
- [x] `app/src/session/recording-session.ts` -- `mic-lost` on ended (close input first), `resume()`, Try again reuses `allowMic`.
- [x] `app/src/ui/screens/Record.tsx`, `Record.module.css`, `app/src/ui/strings.ts` -- error card variant per mockup (c) for the five codes; announce the h2 assertively on entering an error state; call `resume()` on mount.
- [x] `app/tests/unit/mic.test.ts`, `recording-session.test.ts` -- code map rows, `micPermission` states and rejection, ended → `mic-lost` with input closed, `resume()` branches.
- [x] `app/tests/e2e/mic-errors.dev.spec.ts` -- Denied through Only device unplugged rows and both Return rows (grant the permission with Playwright `context.grantPermissions(['microphone'])` for the granted row); axe on an error card with no serious or critical violations.
- [x] `app/tests/e2e/mic-setup.spec.ts` -- Production row stays green with `resume()` in place.

**Acceptance Criteria:**
- Given any error card, when the player follows its steps and chooses Try again, then the mic opens without a page reload.
- Given a screen reader, when an error card appears, then its heading is announced once through the single assertive region.

## Implementation Notes

## Plan Change Log

## Review Triage Log

### 2026-10-02 — Review pass
- verdicts: 28 findings — high 0, medium 7, low 19, false 2, maybe-false 0
- findings:
  - `low` `reject` (intent) only some mapped names run end to end — every name is unit-tested; the e2e covers one per code.
  - `low` `reject` (intent) a muted but not ended track is not treated as lost — Chrome ends the track on revoke and unplug; mute is not loss.
  - `false` `reject` (intent) a second gate (micGranted) beyond the Permissions API — the approved plan matrix requires both.
  - `medium` `patch` (intent) a loss on another screen is announced late — announcing moved to a shell-level component.
  - `false` `reject` (intent) no-reload and no-loop tested only at page level — the page is the surface the intent names; unit tests cover the 10 s wait.
  - `low` `patch` (intent) production row not re-checked with resume() — production spec covers a returning, non-granted player.
  - `low` `patch` (verif) error card staying in place during a pending retry untested — e2e holds getUserMedia pending and checks the card.
  - `low` `patch` (verif) repeated same-code failure announcement untested — e2e checks two announcements.
  - `medium` `patch` (edge) focus lost on card swaps — focus moves to the new heading or the level bar.
  - `medium` `patch` (edge) disabling the focused Try again drops focus — aria-disabled during the retry.
  - `medium` `defer` (edge) OS-level mic block (e.g. macOS privacy) arrives as NotAllowedError and shows site-settings steps that cannot fix it — needs a copy decision; deferred.
  - `low` `reject` (edge) SecurityError mapped to denied — the site is served over HTTPS with no blocking permissions policy.
  - `low` `reject` (edge) a track already ended at openInput writes micGranted and flashes live — rare; the lost card follows at once.
  - `medium` `patch` (edge) loss on another screen announced late — same shell-level fix.
  - `low` `patch` (edge) Permissions stub leaks between unit tests — original descriptor restored.
  - `low` `patch` (edge, claim) announce-on-error only while Record is mounted — same shell-level fix.
  - `medium` `patch` (blind) focus lost on every card swap — same focus fix.
  - `low` `reject` (blind) no progress text during retry and no success announcement — the card stays with Try again disabled and the meter appears; low value.
  - `medium` `patch` (blind) mic lost on another screen is silent — same shell-level fix.
  - `low` `patch` (blind) a Try again that fails again is untested — same-code test added.
  - `low` `reject` (blind) automatic resume that fails is untested — it shows the same error card through the same path.
  - `low` `patch` (blind) production returning-user check missing — added.
  - `low` `reject` (blind) micGranted never cleared — the resume gate also requires a granted permission.
  - `low` `reject` (blind) duplicate names and an unreachable fallback in Record — cosmetic.
  - `low` `patch` (blind) module-level announced state — removed with the shell-level announcer.
  - `low` `reject` (blind) openInput detach path and dead-stream flicker untested — rare; covered in spirit by the ended tests.
  - `low` `reject` (blind) e2e writes the prefs key literally — a prefs migration would fail it loudly.
  - `low` `patch` (blind) raw px spacing in the card's step list — tokens.

## Design Notes

Error card copy is keyed by code so 2.9's Tuner reuses the card:

```ts
'record.micError.<code>.title' | '.body' | '.step1' | '.step2' | '.step3'
```

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` -- expected: all exit 0 (`~/.cargo/bin` on PATH)
- `grep -rlE '__test|UiTestPage|StorageTestPage|fakeMic' app/dist` -- expected: no output
