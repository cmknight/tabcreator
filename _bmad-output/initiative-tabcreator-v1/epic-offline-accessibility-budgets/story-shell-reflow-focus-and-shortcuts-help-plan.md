---
title: 'Shell reflow, focus and shortcuts help'
type: 'feature'
ticket: '10'
created: '2026-10-07'
status: 'built'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '9dfcf1f5b443e4e315f8e4d9e7eff5a1976eedf7'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/EXPERIENCE.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Four keyboard and narrow-window gaps (CAP-21, AD-18, EXPERIENCE :89, :126-146, :152-162; Recording retro A4/DS11):
- **Nav overflow:** the top bar is a no-wrap row with a fixed height, so at 320 px every screen scrolls sideways (WCAG 1.4.10).
- **Focus on route change:** a route change leaves focus where it was instead of on the new screen's h1.
- **No shortcuts dialog:** there is no `?` dialog listing the shortcuts.
- **Esc in a text field:** Esc does not cancel a count-in while focus is in a text field, because the registry's text-field guard blocks every entry.

**Approach:**
- The top bar wraps.
- The shell focuses the h1 after a real route change.
- A shortcuts dialog renders from the `shortcuts.ts` registry. It opens on `?` and from a Keyboard shortcuts button in Settings' About panel.
- The count-in Esc entry opts out of the text-field guard.

## Boundaries & Constraints

**Always:**
- **Reflow:** `.topBar` gets a `min-height` (not a fixed height), and `.inner` and `.navList` wrap. Fix any other element that makes a screen scroll sideways at 320 px, using wrapping or `min-width: 0`, not hiding. Desktop layout ≥ 720 px is unchanged (the top bar stays one row, 56 px).
- **Route focus:**
  - After the route changes (name, or takeId for Tab; not on first load, and not when the same link is clicked again), focus `main h1` with `preventScroll`.
  - Settings' h1 gains `tabIndex={-1}`.
  - `record.dev.spec.ts:330-335` (same-route nav-link click keeps focus on the link) must stay green.
- **Registry (`ui/a11y/shortcuts.ts`, AD-18):**
  - `?`: global, `shiftOk`; it is guarded in text fields like every other shortcut, and opens the dialog.
  - The count-in Esc entry gets a per-entry opt-out of the text-field guard. Fields that handle Esc themselves already `preventDefault` and keep winning.
  - Listing-only entries (no handler, never dispatched) cover the shortcuts EXPERIENCE lists that live elsewhere:
    - Esc "close dialog, popover or panel" (global);
    - the Trim handle's ←/→ (10 ms) and Shift+←/→ (100 ms).
  - A pure function builds the dialog's groups from the registry:
    - groups in this order: Global, Record, Tab, Trim handle;
    - entries with the same description merge into one row, with keys joined, e.g. digits `0–9`, Delete/Backspace, redo `Ctrl+Shift+Z / Ctrl+Y`;
    - modifier labels follow the platform the dispatcher detects (`Ctrl` or `⌘`).
- **Dialog:**
  - `role="dialog"`, `aria-modal`, an h2 "Keyboard shortcuts", one `<table>` per group with a `<caption>` (keys in `<th scope="row"><kbd>`), the note "Shortcuts never fire while you are typing in a field.", and one Close button that gets focus when it opens.
  - It goes through `openOverlay` (focus trap, Esc, restore focus to the opener). Restore focus to the element that had it before `?`, or to the Settings button.
  - The scrim and dialog styles follow `ConfirmDialog.module.css` (DESIGN :236, max 480 px). The body scrolls inside the dialog when it is taller than the window.
  - One host is mounted in `Shell`, opened through a tiny open-state in `ui/` that both the `?` handler and Settings call.
- **Settings About:** a `<button aria-haspopup="dialog">` "Keyboard shortcuts" with a `?` kbd hint, beside the engine line in a wrapping row (mockup `settings.html`). The ticket says "link"; the button follows the mockup because it opens a dialog.
- All strings go in `ui/strings.ts` and all colours are theme tokens. The layer rules still hold.

**Never:**
- No second keyboard listener for `?`, and no `aria-live` outside `ui/a11y`.
- No change to existing shortcut behaviour other than the count-in guard opt-out.
- No horizontal-scroll fix that hides content (`overflow: hidden` on the page or main).
- No dialog stacking: `?` while an overlay is open does nothing, as the dispatcher already ensures.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Reflow | 320×720 on Record, Tuner, Library, Settings, Tab | `scrollWidth <= clientWidth`; nav links all visible | none |
| Route focus | click Library from Record | the Library h1 is focused | none |
| Same route | click Record on Record | focus stays on the link | none |
| `?` | focus on a Tab note, press `?` | dialog opens, Close focused, Tab cycles inside | none |
| `?` in a field | Library search focused, type `?` | a `?` is typed; no dialog | none |
| Esc | dialog open | closes; focus back on the note | none |
| Settings button | click it | dialog opens; Esc returns focus to the button | none |
| Listing | dialog | every registry description appears once, in its group | none |
| Count-in Esc in a field | count-in at 40 BPM, go to Settings, focus a Defaults number field, Esc | count-in cancelled, no take recorded | none |
| Axe | dialog open, light and dark | no serious or critical violations | none |

</intent-contract>

## Code Map

- **`app/src/ui/a11y/shortcuts.ts`:**
  - `Shortcut` interface (:71-96);
  - `cancelCountIn` (:195-203);
  - `guarded` (:130-142, runs after the match for every entry);
  - `modMatches` (:523-531; `?` needs `shiftOk`);
  - `SHORTCUTS` (:499-511);
  - `dispatchShortcut` (:552-570; returns early when `isOverlayOpen()`);
  - `installShortcuts`/`ShortcutListener` (:573-589, mounted at `App.tsx:163`).
  - Shortcut description strings: `strings.ts` :209, :224, :294-300, :355-382, :447.
- **`app/src/ui/a11y/overlays.ts`:** `openOverlay({ element, opener, initialFocus, onDismiss })` (:78-143), which handles the trap, Esc and the restore.
  - Precedent: `app/src/ui/components/ConfirmDialog.tsx:53-67` and `ConfirmDialog.module.css` (scrim, dialog, title, actions).
- **The shell:**
  - `app/src/App.tsx` `Shell` (:117-171): header/nav, `<main tabIndex={-1}>`, the hosts mounted after main.
  - `app/src/App.module.css` `.topBar` (:1-7, `height: 56px`), `.inner` (:9-18), `.navList` (:24-30).
  - `ui/router.ts` `useRoute`.
- **h1s:**
  - `Record.tsx:24`, `Tuner.tsx:57`, `Library.tsx:958` and `TakeHeader.tsx:78` already have `tabIndex={-1}`.
  - `Settings.tsx:70` does not.
  - Existing focus moves to leave alone: `Tab.tsx:723-740`, `MicGate.tsx`, `Library.tsx` `focusHeading`.
- **Settings About:** `app/src/ui/screens/Settings.tsx:126-133`; `.row` in `Settings.module.css:29-35` already wraps.
- **Mockup:** `_bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/mockups/settings.html` :233-240 (`.keys`/`.kbd` CSS), :320/:441 (the About button), :444-475 (the dialog).
- **Count-in:**
  - `CountInControls.tsx:25` disables the tempo field while busy, so the field can't hold focus during a count-in. The count-in keeps running off Record (`shortcuts.test.ts:68`).
  - `recording-session.ts` `stop('user')`.
- **320 px suspects:** `Record.module.css:2-7` `.head` (no wrap), Tuner `.scale span` and LevelMeter `.scale span` (absolute, nowrap edges), `TrimStrip.module.css:76-89`, and `banner.module.css` (no wrap by default; the Settings, InputQuality, StorageFull and TakeWarnings banners are unchecked).
- **Tests:**
  - Unit: `tests/unit/shortcuts.test.ts` (:45 Esc order, :53-90 count-in Esc), `overlays.test.ts`, `settings-screen.test.tsx`.
  - e2e helpers:
    - `mic-helpers.ts` `goLive`, `expectNoSeriousAxe`;
    - `tab-helpers.ts` `openSeededTab`;
    - `library-helpers.ts`;
    - `theme.dev.spec.ts` `observeTheme` (both-theme axe loop :170-178);
    - `record.dev.spec.ts` `countInOn`, `tempoField`, `cancelButton` (:356-369, :443-475).
  - `tab-screen.dev.spec.ts:63` skips the page-scroll check at 320; tighten it.
  - `tests/e2e/navigation.spec.ts` clicks each nav link; add `toBeFocused` on the h1.

## Tasks & Acceptance

**Execution:**
- [x] `app/src/App.module.css` (and any screen or component CSS that overflows at 320) -- the top bar wraps, with min-height -- WCAG 1.4.10.
- [x] `app/src/App.tsx`, `app/src/ui/screens/Settings.tsx` -- focus the h1 after a route change; mount the shortcuts dialog host; Settings h1 `tabIndex={-1}` -- focus order.
- [x] `app/src/ui/a11y/shortcuts.ts` -- the `?` entry, the count-in guard opt-out, listing-only entries, and the pure grouping function -- AD-18 single registry.
- [x] `app/src/ui/components/ShortcutsDialog.tsx` (+ module CSS) and a small open-state in `ui/` -- the dialog through `openOverlay` -- EXPERIENCE :89.
- [x] `app/src/ui/screens/Settings.tsx`, `ui/strings.ts` -- the About panel button and every new string.
- [x] Unit tests:
  - `shortcuts.test.ts`: `?` dispatches (Shift), and is guarded in a field; count-in Esc fires from an input; listing-only entries never dispatch; the grouping and merging.
  - a dialog test: every description listed once, Close focused.
  - `settings-screen.test.tsx`: the button opens it.
- [x] `app/tests/e2e/shell-a11y.dev.spec.ts` (new) -- the matrix rows: 320 px on each screen, route focus, `?`/Settings open, trap, Esc restore, `?` typed in a field, the count-in Esc from a Settings field, axe in both themes. Also tighten `tab-screen.dev.spec.ts:63`, and add h1 focus to `navigation.spec.ts`.

**Acceptance Criteria:**
- Given any screen at 320 px wide, when it renders, then the page does not scroll sideways and every nav link is reachable.
- Given a route change by nav link or by the app (e.g. Stop opening the Tab), when the new screen renders, then its h1 has focus.
- Given `?` or the Settings button, when the dialog opens, then it lists every registered shortcut grouped by where it works; focus is trapped; Esc or Close restores focus to the opener.
- Given a count-in and focus in a text field, when Esc is pressed, then the count-in is cancelled.
- Given the full verification, when it runs, then it exits 0.

## Implementation Notes

- Registry: `Shortcut.handler` is optional (absent = listing-only, skipped by the dispatcher); new `group?: 'trim'`, `textFieldOk?`, and `mod: 'shift'` (used only by the Trim listing entries). `guarded(target, key, textFieldOk)`. `helpShortcut`, `LISTING_ONLY`, `keyLabel`, `shortcutGroups` exported.
- Open state: `app/src/ui/shortcuts-dialog.ts`; host `ShortcutsDialogHost` in `ShortcutsDialog.tsx`, mounted in `Shell`. If the opener (a note button) was re-created by a reflow, focus returns to the button with the same `data-note-id`.
- The dialog body is the scroll container and is focusable (`tabIndex=0`, `role="region"` named by the title) so axe's scrollable-region rule holds when it overflows; Tab therefore cycles body ↔ Close.
- Route focus: `useRouteFocus` in `App.tsx` keys on name/takeId; unknown hashes are ignored so the first load (incl. the #/record fallback) does not move focus; a MutationObserver covers an h1 rendered later.
- Reflow: top bar `min-height` and wrapping; `banner.module.css .text` gets `min-width: 0; overflow-wrap: anywhere` (RecoveredTakeBanner's 12em raised to `.banner .text` so stylesheet order cannot drop it); Record `.head` wraps. Desktop top bar measured 57 px (56 + border) as before.
- Verification exited 0; two timing-bound dev specs (playback cursor ≤ 50 ms, tuner tick) were flaky under parallel load and passed on retry / alone.

- Verification fix (orchestrator): `record.dev.spec.ts` "count-in: the beats 4-3-2-1" failed both tries in two full runs. The cause: axe ran mid-count-in under load and a polled beat check missed beat 2 (it passed alone 4/4). The test now records the beats and announcements with a page-side MutationObserver installed before Record, runs axe on beat 3, then asserts the sequence 4-3-2-1. Test-only; 6/6 alone, green in the full run.

## Plan Change Log

## Review Triage Log

### 2026-10-07 — Review pass
- verdicts: 36 findings — high 0, medium 2, low 27, false 7, maybe-false 0
- findings:
  - `medium` `patch` (blind) back/forward with the dialog open moves focus behind the modal — the dialog closes on route change; route focus skips while an overlay is open.
  - `medium` `patch` (edge) same — same fix.
  - `low` `patch` (edge) the dialog store stays open when the Shell unmounts — closed on host unmount.
  - `low` `patch` (blind) the dialog note is false now that the count-in Esc fires in fields — reworded with the exception.
  - `low` `patch` (edge) same — same.
  - `low` `patch` (verification) same — same.
  - `low` `patch` (intent) same — same.
  - `low` `reject` (edge) Esc in the Library search during a count-in cancels and suppresses the native clear — cancelling the count-in is the intended action; the search keeps its text.
  - `low` `reject` (edge) `?` is guarded on checkbox and range inputs — the shared TEXT_FIELD selector applies to every shortcut; not this story's change.
  - `low` `patch` (edge) the h1 observer has no timeout — the branch is removed (dead: every screen renders its h1 in the same commit); `main` is the fallback.
  - `low` `patch` (verification) the observer branch is unreachable and untested — same.
  - `low` `reject` (blind) the Trim group misses Home/End and Esc — the dialog lists EXPERIENCE's Interaction Primitives, which name only the nudges.
  - `low` `reject` (blind) the Trim listing can drift from TrimStrip — listing-only by design; a sweep item.
  - `low` `patch` (blind) the Settings button's name includes the `?` hint — the hint is `aria-hidden`, plus `aria-keyshortcuts`.
  - `low` `patch` (blind) the focused h1 can be out of view after a route change — the page scrolls to the top first.
  - `low` `patch` (blind) the wrapped sticky bar can cover focused content at narrow widths — the bar is static below 720 px.
  - `low` `patch` (blind) the scrim's 56 px padding assumes the old bar — `min(56px, 8vh)`.
  - `low` `patch` (blind) the scroll region repeats the dialog name — its own label.
  - `low` `patch` (blind) with no opener, focus falls to body on close — falls back to `main`.
  - `low` `patch` (blind) the `?` description is a noun phrase — "Show keyboard shortcuts".
  - `low` `reject` (blind) the Mac labels mix ⌘ with spelled-out Shift — EXPERIENCE writes "Ctrl/⌘+Shift+Z"; kept consistent.
  - `low` `patch` (blind) over-long doc comments — rewrapped.
  - `low` `patch` (blind) the count-in Esc e2e waits 6.5 s and checks late — asserted right after Esc.
  - `low` `patch` (blind) the rewritten beats test no longer ties each announcement to its beat — the alerts are recorded with the beat shown.
  - `low` `patch` (blind) `useRouteFocus` paths are untested — e2e for back/forward, Library → Tab, Stop → Tab.
  - `low` `patch` (verification) route focus is unchecked for the Tab screen and back/forward — same.
  - `low` `patch` (verification) the re-created note button focus return is untested — unit test.
  - `low` `reject` (intent) the tempo-field half may pass with focus on body — that is the real state (the field is disabled during a count-in, Design Notes); the Settings-field half exercises the guard opt-out; the test now asserts and comments where focus is.
  - `low` `reject` (intent) the dialog-vs-registry check is circular — the hand-written EXPERIENCE expectation table in `shortcuts.test.ts` ties the registry to the spec.
  - `false` `reject` (intent) the dialog component lives outside `ui/a11y` — AD-18 says the dialog renders from the registry; the content is built in `shortcuts.ts`.
  - `false` `reject` (intent) a button, not a link — plan decision (mockup; it opens a dialog).
  - `false` `reject` (intent) 320 px misses some states (instance screen, banners, many rows) — the five screens and the mic card are covered; banner text now narrows in shared CSS.
  - `false` `reject` (intent) route focus untested beyond nav links — duplicate of the verification row, patched.
  - `false` `reject` (intent) `?` not tested from every screen — it is global; one dispatcher path, unit-tested.
  - `false` `reject` (intent) axe runs only under the System theme with emulated colour schemes — both token sets are exercised; explicit Light/Dark prefs apply the same tokens (story 7.6).
  - `false` `reject` (intent) the count-in test rewrite is out of scope — a verification fix, recorded in Implementation Notes.

## Design Notes

**Two choices made here, both recorded:**
- **The tempo field.** The Verify line names "Esc in the tempo field". The tempo field is disabled during a count-in, so it cannot hold focus, but the count-in keeps running when you leave Record. The intent (description and retro A4) is "Esc cancels a count-in while focus is in a text field", so the e2e uses a Settings Defaults field. It also checks that Esc with focus left behind by the disabled tempo field still cancels.
- **Button vs link.** The ticket says "link"; the button follows the mockup and opens a dialog.

**What the dialog lists:** "Every registered shortcut" is read with AD-18, where every EXPERIENCE shortcut is registered in `shortcuts.ts`. The overlay Esc and the Trim nudges therefore join the registry as listing-only entries, which keeps one source for the dialog.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && pnpm --filter app size:check && TABCREATOR_E2E_BUILD=B pnpm --filter app exec vite build && CI=1 pnpm e2e && pnpm --filter app benchmark'` (repo root, `~/.cargo/bin` on PATH) -- expected: all exit 0.

## Auto Run Result

- **Summary:**
  - **Reflow:** the top bar wraps, with a min-height. Below 720 px it is static, not sticky, so it can't cover focused content. Shared banner text narrows, and the Record head wraps. No screen scrolls sideways at 320 px.
  - **Route focus:** a real route change closes the shortcuts dialog, resets the scroll, and focuses the new screen's h1, or `main` if there is none. This covers nav links, back/forward, a Library row opening a take, and Stop opening the Tab. It does nothing on first load or for the same route.
  - **Shortcuts dialog:** `?` (registered in `ui/a11y/shortcuts.ts`) and a Keyboard shortcuts button in Settings' About panel open a modal that renders from the registry:
    - groups Global, Record, Tab and Trim handle, with merged rows;
    - listing-only entries for the overlay Esc and the Trim nudges;
    - the focus trap and Esc come from `overlays.ts`; focus returns to the opener (a re-created note button, or `main`).
  - **Count-in Esc:** it now fires with focus in a text field (`textFieldOk`), and the dialog note states this exception.
- **Files changed:**
  - **Source:** `app/src/App.{tsx,module.css}`, `ui/a11y/shortcuts.ts`, `ui/shortcuts-dialog.ts` (new), `ui/components/ShortcutsDialog.{tsx,module.css}` (new), `ui/components/{banner,RecoveredTakeBanner}.module.css`, `ui/components/icons.tsx`, `ui/screens/Settings.{tsx,module.css}`, `ui/screens/Record.module.css`, `ui/strings.ts`.
  - **Tests:**
    - unit `shortcuts`, `shortcuts-dialog` (new), `settings-screen`;
    - e2e `shell-a11y.dev.spec.ts` (new), `navigation.spec.ts`, `tab-screen.dev.spec.ts`, `record.dev.spec.ts` (the count-in beats test made load-robust).
- **Review:** 36 findings (medium 2, low 27, false 7).
  - Patched:
    - route change with the dialog open;
    - closing the dialog store when the Shell unmounts;
    - the false dialog note;
    - the dead observer branch removed, with `main` as the fallback;
    - scroll reset;
    - the static bar below 720 px;
    - the button's accessible name and `aria-keyshortcuts`;
    - the region label and the scrim padding;
    - action-style strings;
    - route-focus e2e for back/forward, Library → Tab and Stop → Tab;
    - a unit test for focus return to a re-created note button;
    - tighter count-in tests.
  - Rejected rows carry their reasons in the triage log.
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 2, low 20.
- **Verification:**
  - The full plan command exited 0: 2101 unit, 269 e2e with no retries; size and benchmark gates pass.
  - Before the patches, the count-in beats test failed under load in two full runs; it was fixed test-only (Implementation Notes).
- **Residual risks:**
  - The tempo field is disabled during a count-in, so "Esc in the tempo field" means Esc with focus left on body there. An enabled Settings field proves the text-field path.
  - The Trim listing is hand-written next to TrimStrip's handler.
  - The bar is not sticky below 720 px, which departs from DESIGN :208's fixed top bar at narrow widths only.
