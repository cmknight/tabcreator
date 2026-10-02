---
title: 'Choose the microphone'
type: 'feature'
ticket: '7'
created: '2026-10-02'
status: done
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: true
baseline_revision: '71acac3d269c57e1115ce8b16919cb537a0b3be4'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: ['oversized']
deferred:
  - summary: >-
      On real hardware a mic unplug may fire the track's ended event before enumerateDevices drops the device, so the store shows the lost card instead of switching to the default with the toast.
    evidence: |-
      Unverified (maybe-false, medium if true). ended() reads the device list immediately; the dev fake mic removes the device before ending the track, so neither unit nor e2e tests can see the real order. Also unexercised: Chrome's `default` device alias. Settle by unplugging a USB mic in real Chrome with a second input present; if the lost card shows, re-check on the next devicechange (or after a short wait) before deciding.
    location: >-
      app/src/session/recording-session.ts ended()
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** The app always opens the browser's default microphone. A player with an audio interface or several mics cannot choose one, the choice is not remembered, and unplugging the active mic shows the lost card even when another input is still there.

**Approach:** List the audio inputs in a Microphone select on Record (reusable on Tuner), open the chosen one, remember it in `micDeviceId`, refresh on `devicechange`, and when the active device is unplugged while another remains, switch to the default input with a toast instead of the lost card.

## Boundaries & Constraints

**Always:** Only `audio/` calls `enumerateDevices` and listens for `devicechange` (AD-2). The list holds `audioinput` devices with a real id: Chrome's `default` and `communications` pseudo-entries are left out; the select is hidden when the list has one device or none. Each option's text is the device label; the selected option is the device the live track reports (`getSettings().deviceId`). Choosing a device closes the old input (stops its tracks) before requesting the new one with `deviceId: { exact }`, then saves `micDeviceId` through `updatePrefs`. Opening the mic (Allow, Try again, return-visit resume) uses the saved `micDeviceId`; if that device is missing (`mic-no-device` from an exact request), it requests the default instead and clears `micDeviceId`. When the live track ends: if its device is no longer listed and at least one device remains, open the default input and show the toast "Microphone disconnected — switched to <label>" (label of the newly active device); otherwise keep 2.5's lost card. The toast goes through 2.3's `showToast` from one shell-level component that watches the store (stores emit, UI shows; AD-3, AD-18). Label "Microphone" and the toast text verbatim in `ui/strings.ts`. The select is a reusable component (`ui/components/MicSelect.tsx`) with a proper `<label>`.

**Never:** No disabled-while-recording state or recording-time unplug handling (Recording epic touch points). No input-quality banner (2.8). No Tuner mount (2.9). No changes to `audio/fake-mic.ts` (2.2's hooks: `?fakeMic=a,b`, ids `fake-mic-<fixture>`, `unplug(id)`, `revoke()`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| One device | `?fakeMic=open_strings`, live | no select shown | none |
| Two devices | `?fakeMic=open_strings,silence_60s`, live | select with both labels; the active one selected | none |
| Switch | choose the other device | old tracks stopped before the new request (one new `getUserMedia` with that exact id); meter reading changes (open_strings moves, silence_60s shows −60) | none |
| Remember | switch, then reload with the permission granted | the chosen device is live again without choosing | none |
| Saved device gone | saved id not listed, open the mic | default opened, `micDeviceId` cleared | none |
| Unplug active, other remains | live on device A, `unplug(A)` | default (B) opened; toast "Microphone disconnected — switched to Fake mic: silence_60s"; no lost card | none |
| Unplug only device | one device, `unplug` it | 2.5's lost card, no toast | `mic-lost` |
| Revoke | `revoke()` (devices stay listed) | 2.5's lost card | `mic-lost` |
| Device list changes | `devicechange` while live | list refreshed | none |

</intent-contract>

## Code Map

Builds on 2.1, 2.2, 2.3, 2.5, 2.6 (`71acac3`, all done and pushed).
- `app/src/audio/mic.ts` -- `requestMic(deviceId?)` builds `{ exact }` when given; `micErrorCode` maps `OverconstrainedError` to `mic-no-device`; `openInput(stream, onEnded)` reports `mic-lost` once. Add `listMics(): Promise<{ deviceId, label }[]>`, `onDeviceChange(cb) → unsubscribe`, and the active device id from the input (track settings).
- `app/src/session/recording-session.ts` -- `allowMic`, `resume` (Permissions gate), `lost()` (closes input, `mic-lost`), `readLevels`, gap reset. Snapshot `{ mic, errorCode?, levelWarning }`. Extend with `devices`, `activeDeviceId`, `notice?: { kind: 'switched'; label: string; seq: number }`; add `selectMic(id)`; route ended through the fallback rule; read/write `micDeviceId` via the injected `loadPrefs`/`updatePrefs`.
- `app/src/ui/components/MicErrorAnnouncer.tsx` -- shell-level store watcher pattern to copy for `MicNotices.tsx` (toast on each new `notice.seq`).
- `app/src/ui/screens/Record.tsx` -- live view renders `LevelMeter`; add `MicSelect` above it (mockup order: Microphone field, then meter).
- `app/src/storage/prefs.ts` -- `updatePrefs`, `Prefs.micDeviceId: string | null`.
- Tests: `app/tests/unit/{mic,recording-session}.test.ts`, `app/tests/e2e/mic-*.dev.spec.ts` (helpers for gum counting and fake-mic hooks).

## Tasks & Acceptance

**Execution:**
- [x] `app/src/audio/mic.ts` -- `listMics`, `onDeviceChange`, active device id.
- [x] `app/src/session/recording-session.ts` -- device list and active id in the snapshot, `selectMic`, saved-device open with default fallback, ended → switched-or-lost, `notice` with a sequence number.
- [x] `app/src/ui/components/MicSelect.tsx`, `.module.css`, `MicNotices.tsx`, `app/src/App.tsx`, `app/src/ui/screens/Record.tsx`, `app/src/ui/strings.ts` -- the select (hidden at ≤ 1 device) and the shell toast watcher.
- [x] `app/tests/unit/mic.test.ts`, `recording-session.test.ts` -- list filtering, every matrix row with fakes.
- [x] `app/tests/e2e/mic-select.dev.spec.ts` -- One device to Revoke rows in the dev project; axe with the select shown.

**Acceptance Criteria:**
- Given the full verification, when it runs, then every existing mic, meter and error spec still passes.

## Implementation Notes

## Plan Change Log

## Review Triage Log

### 2026-10-02 — Review pass
- verdicts: 33 findings — high 0, medium 5, low 25, false 1, maybe-false 2
- findings:
  - `low` `reject` (intent) Tuner reuse rests on a docstring — Tuner mount is story 2.9.
  - `maybe-false` `defer` (intent) Chrome's real `default` alias and unplug order are not exercised — deferred with the real-hardware timing item.
  - `low` `reject` (intent) devicechange refresh tested only via a label change — the refresh path is the same for any change.
  - `low` `reject` (intent) micDeviceId kept after a live unplug — deliberate: the device may return; the open path clears a missing id.
  - `false` `reject` (intent) the toast is shell-level and fires on any screen — intended (stores emit, UI shows).
  - `low` `reject` (intent) reload without a grant covered only by a unit test — same open path as Try again.
  - `low` `reject` (edge) ended() can clear the shared busy flag mid-switch — selectMic then returns early through its input check.
  - `medium` `patch` (edge) activeDeviceId cannot be cleared to null — set() now distinguishes "not given" from null.
  - `medium` `patch` (edge) an unresolved active id makes a revoke look like an unplug — unresolved ids count as not unplugged.
  - `low` `patch` (edge) activeDeviceId may hold an id with no option — same fixes plus the placeholder option.
  - `medium` `patch` (edge) the select cannot pick its first device when the active id is not listed — disabled placeholder option.
  - `low` `patch` (edge) a failed fallback is always reported as mic-lost — the rejection's code is kept.
  - `low` `reject` (edge) selectMic with an unknown id closes the working input — the UI offers only listed ids.
  - `low` `reject` (edge) "Microphone N" numbering follows list position — browsers give labels after permission; rare.
  - `low` `patch` (edge, claim) a null deviceId sends a real unplug to the lost card — now the explicit rule for unresolved ids.
  - `medium` `patch` (blind) activeDeviceId cannot return to null — same fix.
  - `medium` `patch` (blind) a revoke can be mistaken for an unplug — same fix.
  - `maybe-false` `defer` (blind) on real hardware `ended` may fire before the device list drops the unplugged device, showing the lost card instead of switching — the fake mic removes the device first; settle on real hardware (medium if true).
  - `low` `patch` (blind) the toast can read "switched to " with no label — falls back to the unnamed-device string.
  - `low` `reject` (blind) choosing a stale option leaves an error card — the plan's rule; Try again recovers.
  - `low` `reject` (blind) a choice made during the unplug fallback is ignored — a sub-second window.
  - `low` `patch` (blind) the keeps-saved-device test cannot fail — now starts with a saved device.
  - `low` `reject` (blind) unnamed-device label and MicSelect untested — rare; needs a fake-mic fixture change outside scope.
  - `low` `reject` (blind) refresh during a switch untested — guarded by the list sequence counter.
  - `low` `reject` (blind) saved-device handling differs between startup and live unplug — deliberate (see intent row).
  - `low` `patch` (blind) select CSS: padding for a missing custom arrow, raw px — fixed.
  - `low` `patch` (blind) overlong header comment in mic.ts — wrapped.
  - `low` `reject` (blind) notice kept in the snapshot — seq is the trigger; documented.
  - `low` `reject` (blind) e2e negative checks use fixed waits — pass now; tightening is test polish.
  - `low` `patch` (verif) concurrent selectMic untested — concurrent-switch unit test added.
  - `low` `patch` (verif) keeps-saved-device test cannot see a clear — same test fix.
  - `low` `reject` (verif) "Microphone N" label untested — as above.
  - `low` `reject` (verif, other) shared busy flag — as above.

## Design Notes

Ended-track rule, so an unplug and a revoke stay distinct with 2.2's hooks (unplug ends the track then fires `devicechange`; revoke ends tracks and keeps devices listed):

```ts
onEnded → const devices = await listMics();
  if (!devices.some(d => d.deviceId === endedId) && devices.length > 0) → open default, notice 'switched'
  else → lost('mic-lost')
```

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` -- expected: all exit 0 (`~/.cargo/bin` on PATH)
- `grep -rlE '__test|UiTestPage|StorageTestPage|fakeMic' app/dist` -- expected: no output

## Auto Run Result

- **Summary:** Record has a Microphone select, hidden when there is one device.
  - It lists real audio inputs only; Chrome's `default` and `communications` entries are left out.
  - Choosing a device stops the old tracks, then makes one exact request, and saves `micDeviceId` only on success.
  - Opening the mic uses the saved device and falls back to the default (clearing the saved id) when it is missing.
  - The list refreshes on `devicechange` while live.
  - Unplugging the active device while another remains switches to the default, with the toast "Microphone disconnected — switched to <label>". Unplugging the only device, a revoke, or an unresolved active id shows 2.5's lost card.
- **Files changed:**
  - `app/src/audio/mic.ts`: `listMics`, `onDeviceChange`, active device resolution by id or group.
  - `app/src/session/recording-session.ts`: devices, `activeDeviceId`, `notice`, `selectMic`, preferred-device open, ended → switch or lost.
  - `app/src/ui/components/MicSelect.tsx`, `.module.css`, `MicNotices.tsx`, `app/src/App.tsx`, `app/src/ui/screens/Record.tsx`, `app/src/ui/strings.ts`: the select and the toast watcher.
  - Tests: `app/tests/unit/{mic,recording-session}.test.ts`, `app/tests/e2e/mic-select.dev.spec.ts`.
- **Review:** 33 findings (medium 5, low 25, false 1, maybe-false 2). 8 fixes applied:
  - `activeDeviceId` can clear to null;
  - an unresolved id counts as not unplugged;
  - a placeholder option when no listed device is active;
  - an unnamed-device label in the toast;
  - the real error code on a failed fallback;
  - the concurrent-switch and keeps-saved tests;
  - select CSS;
  - a comment wrap.

  1 item deferred (maybe-false, medium if true): on real hardware, the order of unplug and the device-list update. Rejections and their reasons are in the Review Triage Log.
- **Follow-up review recommended:** true. Three medium entries were patched. The specific unverified risk is real Chrome unplug behaviour (the order of the ended event and `enumerateDevices`, and the `default` alias), which the fake mic cannot reproduce.
- **Verification:**
  - The full plan command exited 0, with all 62 Playwright tests passing.
  - `app/dist` has no dev-only strings.
- **Residual risks:**
  - A select height and radius are raw px (no tokens exist).
  - The unnamed-device label is untested.
  - A choice made during the sub-second unplug fallback is ignored.
