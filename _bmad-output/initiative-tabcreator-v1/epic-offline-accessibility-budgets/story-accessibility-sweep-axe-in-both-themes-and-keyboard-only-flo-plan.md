---
title: 'Accessibility sweep: axe in both themes and keyboard-only flow'
type: 'feature'
ticket: '12'
created: '2026-10-07'
status: 'built'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: 'e4293853d59f067ec6d2116766c4fdb26e0aba68'
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** CAP-21, US-8.2 and the EXPERIENCE Accessibility Floor require:
- no serious or critical axe violations on every screen in both themes;
- a record → edit → export flow completed with the keyboard alone.

Today:
- axe runs ad hoc in about 40 dev checks, mostly light theme only, with dark mostly through emulated `prefers-color-scheme` rather than the stored theme.
- On the production build only two screens are checked, both light.
- No test does the flow without the mouse.

**Approach:**
- One axe matrix on the production build over every screen and state reachable there, each in Light and Dark set by the stored theme pref (`data-theme`, story 7.6).
- A small dev companion for the states only dev hooks can produce.
- A keyboard-only prod-mic run.
- Fix any violation found in the app, never by excluding rules.

## Boundaries & Constraints

**Always:**
- **The matrix, on the production build.** Specs: `tests/e2e/a11y-matrix.spec.ts` (`chromium` project: no-mic states) and `tests/e2e/a11y-matrix.prod.spec.ts` (`prod-mic`: live-mic states).
  - Every state runs `expectNoSeriousAxe` twice, Light then Dark.
  - The themes are applied through the stored pref: seed `tabcreator.prefs.v1` `{ version: 1, theme }` before load (the `theme-boot.spec.ts` seed-once init script). Within one page, switch with Settings' Theme control, or by setting `data-theme` on `<html>` exactly as `applyTheme` does.
  - Before each axe run, assert `data-theme` and the body background (`rgb(250, 250, 247)` / `rgb(20, 19, 17)`), so a theme that didn't apply fails loudly.
  - States are reached only through the UI and standard-API init scripts (no `src/dev` hooks, `?fakeMic` or `#/__test` pages):
    - **Record:** the mic setup card; the error cards `mic-denied`, `mic-no-device`, `mic-in-use`, `mic-failed` (an init script makes `getUserMedia` reject with the matching `DOMException` name); live meter; count-in; recording.
    - **Tuner:** setup card; live.
    - **Tab** (seeded with `seed-helpers.ts` `restoreSeed`):
      - analysed with notes; a note selected; the note list view; the edit popover; the analysis settings panel; the Re-analyse confirm;
      - the Trim strip and its confirm (a take with audio);
      - no notes; analysing in progress;
      - analysis failed — try a recorded take with an undecodable WAV; if that doesn't produce the failure on prod, move it to the dev companion and note it;
      - not found.
    - **Library:** empty; with takes; row menu; rename field; the Delete take and Delete audio confirms; the Restore confirm; the restore error banner; search with no results.
    - **Settings:** default, plus the at-risk storage notice if a `navigator.storage.persisted` stub produces it.
    - **Shortcuts dialog.**
    - **Toast:** "Tab copied".
    - **Instance:** other tab (a second page in the context); lost (after Use here); no Web Locks.
    - **Unsupported screen.**
    - **Update prompt:** reuse `update.prod.spec.ts`'s server, if cheap; otherwise the dev companion.
  - One `test` per state group keeps the run time sane. Hygiene (`watchHygiene`) stays clean.
- **Dev companion** (`tests/e2e/a11y-matrix.dev.spec.ts`): the same Light/Dark pref helper, run on the dev-hook-only states:
  - Library storage-full banner, mid-take storage-full banner, Tab storage-full on commit;
  - held analysis;
  - upgrade-blocked;
  - Too loud / Too quiet;
  - input-quality banner;
  - recovered-take banner and leave dialog;
  - near-cap warning.
  
  Put the theme and axe helper in a shared `tests/e2e/a11y-helpers.ts`.
- **Keyboard-only flow** (`tests/e2e/keyboard-flow.prod.spec.ts`, prod-mic): no `click`, `dblclick`, `hover` or `mouse.*` after `goto`; only `page.keyboard`. Steps:
  1. Tab to "Allow microphone", Enter.
  2. Tab to Record, Space or Enter; a ~3 s take; Space or Enter to stop.
  3. On the Tab screen, after analysis, reach the skip link "Skip to tab", Enter.
  4. ←/→ to a note; a digit sets the fret; ↑/↓ moves the string; check it in storage (`storage-helpers`).
  5. Ctrl+Z / Ctrl+Shift+Z.
  6. Ctrl+Shift+C copies (clipboard permission granted; read it back).
  7. Tab into the toolbar, then ←/→ to Download, Enter; check the download event and the text, as `offline.prod.spec.ts` does.
  
  Assert focus is visible at each focus move: the focused element's computed `outline-style` is not `none`, or it has a box-shadow ring.
- **Fixes:** every violation the matrix finds is fixed in app code, with theme tokens only.
  - No `disableRules`, `exclude` or `withTags` narrowing.
  - Colour fixes change token values only if the pair fails contrast. Record each fix in Implementation Notes.
  - If the keyboard flow finds a step impossible without a mouse, fix the app. A missing keyboard opener for the edit popover is not in scope while digits and arrows edit.

**Never:**
- No app hooks or dev pages added for the prod matrix.
- No axe rule exclusions.
- No theme pref faked through `prefers-color-scheme` emulation in place of `data-theme`.
- Don't delete the existing per-feature axe checks.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Each prod state | listed state, Light then Dark | `data-theme` and the background match; axe has no serious or critical | a violation is fixed in the app |
| Theme not applied | pref seed failed | the theme assertion fails before axe | none |
| Mic error cards | `getUserMedia` rejects NotAllowed / NotFound / NotReadable / other | the matching card; axe clean in both | none |
| Dev-only states | storage full, held analysis, upgrade-blocked, … | axe clean in both themes (dev companion) | none |
| Keyboard flow | prod-mic, keyboard only | take recorded, analysed, edited (stored), copied and downloaded; focus visible on each move | none |

</intent-contract>

## Code Map

- **`app/playwright.config.ts`:**
  - `chromium` (:57-61, production `:4173`, no mic; ignores DEV/SUBPATH/PROD/PERF);
  - `prod-mic` (:62-80: `*.prod.spec.ts`, mic permission, fake device with `testdata/synth/c_major_scale_pos1_noisy.wav`);
  - `dev` (:90-99).
  - CI `pnpm e2e` runs every project (`ci.yml:343`).
- **Axe:** `tests/e2e/mic-helpers.ts:106-113` `expectNoSeriousAxe` (default rules; prod-safe imports). `goLive(page, null)` is prod-safe.
- **Theme seeding:**
  - `tests/e2e/theme-boot.spec.ts` (seed-once init script on prod);
  - `theme.dev.spec.ts:27-44` `observeTheme`;
  - key `tabcreator.prefs.v1` (`src/storage/prefs.ts:9`);
  - `app/build/theme-boot.ts` sets `data-theme` before paint;
  - `ui/theme-apply.ts` `applyTheme`.
- **Seeding:** `tests/e2e/seed-helpers.ts` (prod-safe: `seedAnalysedTake`, `seedTake`, `seedBackup`, `wavFile`, `loopPcm`, `readFixtureWav`, `restoreSeed` from `#/library`). `tab-helpers.ts` `seedTab` / `openSeededTab` are dev-only; its locators `noteButton`, `tabArea` and `selectedNote` are fine.
- **Mic cards:** `ui/components/MicGate.tsx`, `ui/mic-error.ts` (codes); titles are in `mic-errors.dev.spec.ts:10-56`. Precedent for an init-script stub: `mic-setup.spec.ts:23-29` patches `permissions.query`.
- **Instance:** `instance.dev.spec.ts:66-119` (second page via `context.newPage()`; delete `Navigator.prototype.locks`). Unsupported: `unsupported.spec.ts` (`REMOVALS`, `remove()`).
- **Tab screen:**
  - skip link `Tab.tsx:~1087` (`tab.skipToTab`);
  - toolbar roving (story 7.11);
  - edit popover (double-click only, `TabArea.tsx:29`);
  - Note list view toggle;
  - Re-analyse confirm `Tab.tsx:607`;
  - Trim confirm `TrimStrip.tsx:496`;
  - analysis failure mapping `session/analysis.ts:171-173`.
- **Export:** `offline.prod.spec.ts:62-165` and `export-helpers.ts` (download event, clipboard read). Shortcuts: `ui/a11y/shortcuts.ts` (Space record, digits, arrows, Ctrl+Z, Ctrl+Shift+C).
- **Update toast:** `update.prod.spec.ts:16-60`, `update-server.ts`.
- **Dev-only states and their hooks:**
  - `src/dev/hooks/{analysis,storage-full,instance,recovery,recording}.ts`;
  - existing dev axe calls to borrow setups from: `storage-states.dev.spec.ts:230`, `tab-states.dev.spec.ts:88/229`, `instance.dev.spec.ts:283`, `level-meter.dev.spec.ts:95/117`, `input-quality.dev.spec.ts`, `recovery.dev.spec.ts:74`, `record.dev.spec.ts:553/785`.
- **Hygiene:** `tests/e2e/hygiene.ts` `watchHygiene`.

## Tasks & Acceptance

**Execution:**
- [x] `app/tests/e2e/a11y-helpers.ts` -- the theme seed, the in-page theme switch with its assertion, and `axeBothThemes(page)` (reusing `expectNoSeriousAxe`).
- [x] `app/tests/e2e/a11y-matrix.spec.ts` and `a11y-matrix.prod.spec.ts` -- the prod matrix.
- [x] `app/tests/e2e/a11y-matrix.dev.spec.ts` -- the dev-hook-only states.
- [x] `app/tests/e2e/keyboard-flow.prod.spec.ts` -- the keyboard-only flow.
- [x] `app/src/**` -- fix every violation and keyboard blocker found (tokens, labels, roles, focus styles), with unit tests where a component changes. No app change was needed: the matrix found no serious or critical violation and the keyboard flow found no blocker, so no source, token or unit test changed.

**Acceptance Criteria:**
- Given the production build, when the matrix runs in CI, then every listed state in Light and Dark reports no serious or critical axe violations.
- Given prod-mic and only the keyboard, when the flow runs, then a take is recorded, analysed, edited, copied and downloaded, with visible focus throughout.
- Given the full verification, when it runs, then it exits 0.

## Implementation Notes

- **Helpers** (`a11y-helpers.ts`): `seedTheme(page, theme, extra?)` (the seed-once init script, `{ ...extra, version: 1, theme }`, `theme` light, dark or system), `expectTheme` (polls `data-theme` and the body background; `{ system: true }` expects no `data-theme`), `axeIn(page, theme, state)` (asserts the theme, then `expectNoSeriousAxe`, in a named `test.step`). There is no in-page theme switch: every state group runs once per theme (`THEMES`), seeded through the stored pref before the first load, so the app applies the theme itself and each state is reached and rendered in it (anything that reads tokens when it renders, such as the Trim waveform, draws in that theme). Checked once with a throwaway spec: text in the light text colour appended to Settings fails Dark with `color-contrast`.
- **Prod matrix, `chromium`** (`a11y-matrix.spec.ts`), one test per group, each group in a `light theme` and a `dark theme` describe: Record setup card and the four error cards (an init script makes `getUserMedia` reject with the `DOMException` name in `window.__gumError`, changed between Try again presses; `mic-failed` uses `UnknownError`, as `AbortError` maps to `mic-in-use`); Tuner setup card and its `mic-denied` card; Tab analysed / note selected / note list view / edit popover / analysis settings / Re-analyse confirm / Trim strip / Trim confirm / "Tab copied" toast (kept up by hovering); Tab no notes / analysis failed / not found (errors asserted empty: the production build logs nothing for the failed analysis, so no message is filtered); Tab analysing (a 240 s WAV take, still analysing after the check, then cancelled); Library empty / with takes and the one-time storage notice / row menu / rename field / Delete take / Delete audio / Restore confirm / restore error / no results; Settings with "Storage: may be cleared" (a `persisted()` stub) and the Theme control (the other theme, then back), plus the shortcuts dialog; Instance other tab and lost (the second page with its own errors and hygiene); Instance no Web Locks (asserts `navigator.locks` undefined, no nav, no Use here, the heading focused); the unsupported screen (no WebAssembly); the Update available toast from `update-server.ts` in its own context (cheap, so not moved to the dev companion). Plus one **system dark** group: pref `system`, `emulateMedia({ colorScheme: 'dark' })`, no `data-theme`, the dark background, axe clean on the Library with takes and the analysed Tab, covering theme.css's `prefers-color-scheme` block.
- **Analysis failed on prod**: a recorded take whose `audio/{id}.wav` is 4 KiB of non-WAV bytes, restored normally, fails decode and shows `tab-analysis-failed`; it stays in the prod matrix.
- **Prod matrix, `prod-mic`** (`a11y-matrix.prod.spec.ts`), once per theme: live meter; count-in (seeded `countIn { on, bpm: 40 }`, the slowest tempo, 6 s, asserted still counting after the check); recording; Tuner live.
- **Dev companion** (`a11y-matrix.dev.spec.ts`), once per theme: mid-take storage-full banner then the Library storage-full banner; Tab storage-full on commit; held analysis; upgrade-blocked banner and notice; Too loud and Too quiet (separate tests, so no fixture page is closed); input-quality banner; recovered-take banner; near-cap warning (`maxTakeMs=30000&warnLeadMs=20000`: shown from 0:10 with 20 s to spare, asserted still showing after the check). Every test asserts `unexpected(errors)` empty. The leave dialog is the browser's native `beforeunload` prompt, outside the page's DOM, so axe cannot check it; the test asserts it was shown and checks the recovered-take banner it leads to.
- **Canvas content is outside axe**: the level meter, the tuner and the Trim waveform draw on canvas, which axe cannot inspect. Their colours are design tokens, covered by DESIGN's contrast table.
- **Keyboard flow** (`keyboard-flow.prod.spec.ts`), once per theme (pref-seeded): after `goto` only `page.keyboard`. Focus visible means the element matches `:focus-visible` and its computed outline or box-shadow while focused differs from the same element's once blurred and is not transparent (then focus is put back and must match `:focus-visible` again), so a selected note's permanent selection outline or the active nav link's underline never counts; a note must show its ring, the `.note:focus-visible` box-shadow. Checked after every focus-moving key, after Enter on Allow microphone, on Stop, on the Tab screen's h1 after the route change, after Ctrl+Shift+C and after Enter on Download (still on Download). A Tab that wraps through the body is skipped, not checked. The exported text is compared with a copy taken before the edit: the edited fret appears once more on its new string's line and once less on the old one; the download equals the copy. Download is reached with Home then → in the toolbar.
- **Fixes:** none needed. Every state in both themes reported no serious or critical axe violation, and every keyboard step worked with a visible focus indicator, so no app code, tokens or unit tests changed. No rule was disabled, excluded or narrowed.
- Stability: the first version of the new specs passed 3× repeated with 4 workers (60/60). After the review patch: `a11y-matrix.spec.ts` 23/23, `a11y-matrix.dev.spec.ts` + `a11y-matrix.prod.spec.ts` 20/20, `keyboard-flow.prod.spec.ts` 2/2; `playwright test --list` routes them to chromium (23), dev (18) and prod-mic (2 + 2).
- Full verification (the Verification command) exited 0: e2e 296 passed, 1 flaky on its first try and passed on retry (`tab-edit.dev.spec.ts:355` "mouse only: the popover moves…", an existing spec this story does not touch); benchmark gate passed (median 1356 ms vs the 2000 ms limit).

- Verification fix (orchestrator): `announcements.dev.spec.ts` "an unknown take announces Take not found" (story 7.11) failed both tries in the first full run. A strict-mode race: once the polite region already held the text, `getByText` matched both it and the visible message. The visible check is now scoped to `main`. Test-only; 5/5 alone, green in the full run.

## Plan Change Log

## Review Triage Log

### 2026-10-07 — Review pass
- verdicts: 33 findings — high 0, medium 4, low 22, false 7, maybe-false 0
- findings:
  - `medium` `patch` (blind) Dark is a DOM write, not the stored pref; token-reading renders (the TrimStrip canvas) stay light — each state group runs per theme, seeded through the pref before load.
  - `low` `patch` (edge, claim) same — same.
  - `low` `patch` (intent) Dark never comes from the pref (R3 vs R4) — same.
  - `medium` `patch` (verification) the focus-visible check passes on a selected note's selection outline — the indicator must be present only when focused; the note's ring checked.
  - `medium` `patch` (blind) any box-shadow or a transparent outline passes as a ring — same.
  - `low` `patch` (edge) transparent outline or zero-alpha shadow counted — same.
  - `low` `patch` (edge, claim) no focus check after Allow, Copy and Download — added.
  - `low` `patch` (edge) a Tab wrap through body fails `tabTo` — handled.
  - `medium` `patch` (blind) the keyboard flow runs in one theme only — runs pref-seeded in Dark too.
  - `low` `patch` (blind) the export is not shown to carry the edit — the edited fret is asserted in the copied and downloaded text.
  - `low` `patch` (blind) the System dark block (`prefers-color-scheme`) is never checked — a system + emulated-dark group.
  - `low` `patch` (blind) canvas content is outside axe — stated in Implementation Notes (DESIGN's contrast table covers the tokens).
  - `low` `reject` (blind) no narrow-viewport axe pass — story 7.10 covers reflow at 320 px; this story's matrix is themes and states.
  - `low` `patch` (blind) errors and hygiene missing on extra pages and some tests — added.
  - `low` `patch` (edge) the level-warnings test compares raw errors — `unexpected(errors)`.
  - `low` `patch` (edge) the recovered-take test asserts no errors — added.
  - `low` `patch` (edge) no-notes / not-found errors unchecked — added, filtering only the expected failure.
  - `low` `patch` (edge) extra pages lack hygiene — added.
  - `low` `patch` (verification) the unsupported test's second page is unchecked — same.
  - `low` `patch` (blind) near-cap and count-in windows are tight — near-cap lengthened; the count-in is at the slowest tempo and asserts the state after.
  - `low` `patch` (blind) "no Web Locks" duplicates the unsupported check without confirming its state — asserts locks gone, no nav, focused heading.
  - `low` `reject` (blind) module-level `let` state in `beforeEach` — the project runs serially; a style point.
  - `low` `reject` (edge) the quiet page may meet the closed page's Web Lock — passed repeatedly; `goLive` waits for Allow.
  - `low` `patch` (edge, claim) the `app/src/**` task is ticked with no source change — reworded: none needed.
  - `low` `patch` (intent) Tuner mic error cards are not in the matrix — `mic-denied` on the Tuner added.
  - `low` `reject` (intent) the edit popover and dialogs are not in the keyboard flow — plan scope; story 7.10's specs cover the dialog focus trap and restore.
  - `false` `reject` (intent) three files, not one matrix — one helper and one list of states, split by the project each state needs (Design Notes).
  - `false` `reject` (intent) dev-hook states not on the production build — they cannot exist in `dist`; the dev companion checks them (Design Notes).
  - `false` `reject` (intent) states reached through stubbed browser APIs — plan: UI and standard-API stubs, the real production code paths.
  - `false` `reject` (intent) backup export not in the keyboard flow — "export" is the tab text (EXPERIENCE's Tab screen export).
  - `false` `reject` (intent) analysis is implicit — analysis starts on Stop; there is no separate user action to analyse.
  - `false` `reject` (intent) no app fixes — the matrix found none; the helper was shown to catch a contrast failure.
  - `false` `reject` (intent) Record idle-with-mic not separate — the live meter state is Record with a live mic.

## Design Notes

**Prod matrix vs dev companion.** The Verify line puts the matrix on the production build. States that only an in-app dev hook can produce cannot exist in `dist`, so they are checked in the dev companion with the same both-theme helper. That way every state is checked, and the production build carries no hooks.

**What is not this story:**
- **The edit popover:** it opens only on double-click. The keyboard flow edits with digits and arrows, which EXPERIENCE's Interaction Primitives define.
- **Calibration and the screen-reader check:** story 14.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && pnpm --filter app size:check && TABCREATOR_E2E_BUILD=B pnpm --filter app exec vite build && CI=1 pnpm e2e && pnpm --filter app benchmark'` (repo root, `~/.cargo/bin` on PATH) -- expected: all exit 0.

## Auto Run Result

- **Summary:**
  - **The axe matrix on the production build:** `a11y-matrix.spec.ts` (chromium, no mic) and `a11y-matrix.prod.spec.ts` (prod-mic). It covers:
    - Record: setup card, four mic error cards, live meter, count-in, recording;
    - Tuner: setup card, `mic-denied`, live;
    - Tab: analysed, selected, note list, edit popover, analysis settings, Re-analyse and Trim confirms, Trim strip, toast, no notes, analysis failed (undecodable WAV), analysing, not found;
    - every Library state; Settings and its at-risk notice; the shortcuts dialog;
    - Instance: other tab, lost, no Web Locks;
    - the unsupported screen and the update toast.
    
    Each runs once per theme, seeded through the stored pref and reached in that theme, with `data-theme` and the background asserted before axe. A System + emulated-dark group covers the `prefers-color-scheme` block.
  - **Dev companion:** `a11y-matrix.dev.spec.ts` covers the dev-hook-only states (storage-full banners, held analysis, upgrade-blocked, level warnings, input quality, recovered take, near-cap) in both themes.
  - **Keyboard-only flow:** `keyboard-flow.prod.spec.ts`, in both themes. Allow, record, stop, the skip link, select, fret, string, undo/redo, copy and download, all with `page.keyboard` only. A focus indicator that appears only when focused is checked at every move. The export carries the edit.
  - **Findings:** no serious or critical violation and no keyboard blocker, so no app change was needed. The helper was shown to catch a dark-theme contrast failure.
- **Files changed:**
  - **Tests (`app/tests/e2e/`):** `a11y-helpers.ts`, `a11y-matrix.spec.ts`, `a11y-matrix.prod.spec.ts`, `a11y-matrix.dev.spec.ts` and `keyboard-flow.prod.spec.ts` (all new).
  - **Fix:** `announcements.dev.spec.ts`, scoped the 7.11 strict-mode race.
- **Review:** 33 findings (medium 4, low 22, false 7).
  - Patched:
    - themes come from the pref, not a DOM write;
    - the focus check is focus-only and non-transparent, with a note-ring check;
    - the keyboard flow runs in Dark and checks the edit in the export;
    - System dark;
    - errors and hygiene on every page;
    - state identity for no-Web-Locks and the Tuner error card;
    - the longer near-cap window;
    - plan text.
  - Rejected rows carry their reasons in the triage log.
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 4, low 18.
- **Verification:**
  - The full plan command exited 0: 2137 unit, 322 e2e with no retries; size and benchmark gates pass.
  - The first run needed the test-only 7.11 fix (Implementation Notes).
- **Residual risks:**
  - Some states are checked only while they last: the count-in at the slowest tempo, analysing on a 240 s take, a hovered toast. Each asserts the state is still showing after axe.
  - Canvas content is outside axe.
  - The edit popover still opens only on double-click.
