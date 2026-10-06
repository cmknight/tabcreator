---
title: 'Copy and Download on the Tab screen'
type: 'feature'
ticket: '4'
created: '2026-10-06'
status: done
baseline_revision: 'b45d558992a1ca4331388f4bcbc4611691082fb3'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-library-and-export/epic-library-and-export.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** The tab can't leave the app; the player can only look at it.

**Approach:**
- Add `ui/platform.ts` (AD-2), which owns clipboard writes, downloads and the file picker for 6.5 and 6.6.
- Add Copy and Download buttons to the Tab toolbar, and a Ctrl/⌘+Shift+C shortcut that copies.

## Boundaries & Constraints

**Always:**
- **`ui/platform.ts`** is the only module that touches `navigator.clipboard`, temporary `<a download>` elements and `<input type=file>` (AD-2). It exports:
  - `copyText(text): Promise<void>`;
  - `downloadText(fileName, text)`, as `text/plain;charset=utf-8`;
  - `downloadBlob(fileName, blob)` (for 6.5);
  - `pickFile(accept): Promise<File | null>` (for 6.6; null on cancel);
  - `isWindowsPlatform()` (`userAgentData.platform`, else `navigator.platform`, injectable for tests).

  Object URLs are revoked after use.
- **Export text:** `toText(take, notes)` from `model/tab-render.ts` over the notes the screen shows (the take's trim, `visibleNotes`), with `countInBpm` passed only when the Bar lines toggle is on, so no bar lines appear in the export when it's off, as on screen. Copy and Download use the same text.
- **Download:**
  - The file name is `<slug>.txt`. The slug is the title NFD-normalised with diacritics stripped, lowercased, every run of anything outside `a–z0–9` turned into one hyphen, hyphens trimmed from the ends, and at most 60 characters (cut on a hyphen boundary where possible). An empty result gives `tab.txt`.
  - Line endings are `\r\n` on Windows (the text's `\n` replaced at download time) and `\n` elsewhere, so copy and download differ only in line endings (CAP-18).
- **Copy:** writes the text and toasts "Tab copied". If the clipboard write fails, it toasts "Couldn't copy the tab".
- **Toolbar** (EXPERIENCE :74 order: Undo, Redo, Insert, Delete, Copy, Download, Trim, Bar lines, Analysis settings): Copy and Download are `ToolButton`s with icons (the mockup's `#i-copy` / `#i-download`).
  - In No notes found (no visible notes) they are disabled with the mockup reasons "No notes to copy" / "No notes to download".
  - While a re-analysis runs they stay enabled (the shown tab is unchanged until the commit).
- **Shortcut:** Ctrl/⌘+Shift+C (`mod: 'mod+shift'`, key `c`) on the Tab route copies. It obeys the same guards as the other edit shortcuts: not in text fields, not under an overlay, not in the trim strip, and only while the tab is shown with visible notes.

**Never:**
- No Library-side export.
- No change to `toText`'s layout.
- No new copy outside `ui/strings.ts`.
- No clipboard or DOM download code outside `ui/platform.ts`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Copy | Copy clicked | the clipboard holds toText(shown notes); "Tab copied" | write rejects: "Couldn't copy the tab" |
| Download | Download clicked | a `<slug>.txt` download with the same text | — |
| Same text | copy vs download (non-Windows) | identical | — |
| Windows | `isWindowsPlatform()` true | the download uses `\r\n`; the clipboard keeps `\n` | — |
| Slug | "Blues / Riff 🎸 in A♯" | `blues-riff-in-a.txt` | — |
| Slug empty | "🎸🎸" | `tab.txt` | — |
| Slug long | a 100-character title | ≤ 60 characters | — |
| Accents | "Café Déjà" | `cafe-deja.txt` | — |
| Bar lines off | a count-in take, toggle off | no bar lines in either export | — |
| Trim | a trimmed take | only visible notes exported | — |
| No notes | No notes found | both disabled with reasons | — |
| Shortcut | Ctrl+Shift+C on the Tab screen | copies; not from a text field | — |

</intent-contract>

## Code Map

- `app/src/model/tab-render.ts:227` `toText(take, notes)` (header, 80-column systems, `\n`, trailing newline; `countInBpm` drives bar lines).
- `app/src/model/notes.ts` `visibleNotes` (the trim filter, 8.7).
- `app/src/ui/screens/Tab.tsx`:
  - the `barLines` prefs read :618 and the bar-line choice :877 (`countInBpm={barLines ? take.countInBpm : undefined}`);
  - the toolbar :949+ (`ToolButton` :246-250; Undo, Redo, Insert, Delete, Trim, Bar lines, Analysis settings);
  - `showTab`/`notes` (the visible notes).
- `app/src/ui/a11y/shortcuts.ts`: `isMacPlatform` :93; `tabEditShortcuts` :360 (the guards and `mod` entries); `dispatchShortcut` :518.
- `app/src/ui/toast.ts` `showToast`. `app/src/ui/components/icons.tsx`; mockup icons in `mockups/tab.html` (`#i-copy`, `#i-download` symbols near :256-262).
- `app/src/ui/strings.ts`. `eslint.config.js` layering (ui → session, model).
- Tests:
  - unit: `app/tests/unit/` (new `platform.test.ts`, slug tests; `tab-screen.test.tsx` toolbar; `shortcuts.test.ts`);
  - e2e: `app/tests/e2e/tab-edit.dev.spec.ts` (recording `c_major_scale_pos1` via `goLive`, `recordAndAnalyse`) and a new `export.dev.spec.ts`. Use `context.grantPermissions(['clipboard-read','clipboard-write'])` and `page.waitForEvent('download')`.

## Tasks & Acceptance

**Execution:**
- [x] `app/src/ui/platform.ts` (+ a slug function in `app/src/model/` for the pure part) -- the platform helpers and the slug -- AD-2.
- [x] `app/src/ui/screens/Tab.tsx`, `icons.tsx`, `strings.ts` -- Copy and Download buttons, export text, toasts, disabled reasons -- CAP-18.
- [x] `app/src/ui/a11y/shortcuts.ts` -- Ctrl/⌘+Shift+C -- the shortcut.
- [x] Unit tests for every I/O row (slug, line endings with an injected platform, platform helpers with stubbed DOM/clipboard, toolbar state, shortcut).
- [x] `app/tests/e2e/export.dev.spec.ts` -- the ACs.

**Acceptance Criteria:**
- Given a recorded `c_major_scale_pos1` take on the Tab screen, when the player clicks Copy and then Download, then the clipboard text equals the downloaded file's text, and every line of each tab system has the same length.
- Given a take renamed to "Blues / Riff 🎸 in A♯", when the player downloads, then the file is named `blues-riff-in-a.txt`.
- Given the take, when the player presses Ctrl+Shift+C, then the clipboard holds the tab and "Tab copied" shows.
- Given a count-in take with Bar lines off, when the player copies and downloads, then neither text contains bar lines.

## Implementation Notes

- The pure part lives in `app/src/model/export-file.ts` (`slugify`, `exportFileName`, `withPlatformLineEndings`); `app/src/ui/tab-export.ts` holds the shared glue (`tabExportText`, `copyTab` with its toasts, `downloadTab`) so the toolbar and the shortcut (`tabExportShortcuts` in `shortcuts.ts`, reading `settingsSession`'s `barLines`) export the same text.
- Download object URLs are revoked 1 s after the click (revoking synchronously can cancel the download in some browsers).
- The `dev` Playwright project uses the Desktop Chrome device, whose user agent is Windows, so `isWindowsPlatform()` is true there and downloads carry `\r\n`. `export.dev.spec.ts` checks the file's endings against the page's reported platform, then compares the `\n`-normalised file text with the clipboard.
- Ctrl+Shift+C: Playwright delivers it to the page and the e2e passes. Not checked in a real, non-automated Chrome (no interactive browser in this session); desktop Chrome binds Ctrl+Shift+C to DevTools' Inspect element and may swallow it there. The toolbar Copy remains the path if so; worth a manual check.

## Plan Change Log

## Review Triage Log

### 2026-10-06 — Review pass
- verdicts: 22 findings — high 0, medium 0, low 18, false 3, maybe-false 1
- findings:
  - `[low]` `[patch]` (blind) `slugify` turns letters that NFD doesn't split (ß, ø, æ, œ, ł, đ) into hyphens — a small fold map runs before the ASCII filter (ß→ss, ø→o, æ→ae, œ→oe, ł→l, đ→d); non-Latin titles keep the spec's `tab.txt` fallback.
  - `[low]` `[patch]` (blind) Download has no failure path — wrapped like Copy: "Couldn't download the tab" toast on a throw. No success toast: the browser shows the download.
  - `[maybe-false]` `[reject]` (blind) Ctrl/⌘+Shift+C may be swallowed by the browser's DevTools inspector and was not checked by hand — needs a manual check in a real Chrome (recorded under residual risks); the spec names the binding, and the toolbar Copy is the dependable path. Low if true.
  - `[low]` `[reject]` (blind) The e2e Windows branch isn't pinned — the probe shows `dev`'s Desktop Chrome reports `userAgentData.platform` "Windows", so e2e runs the `\r\n` branch; the `\n` branch is unit-tested with an injected platform.
  - `[low]` `[patch]` (blind) `pickFile` waits forever where the input's `cancel` event isn't fired (Chromium before 113) — a window-focus fallback settles null when no file was chosen and removes the input; test added.
  - `[low]` `[reject]` (blind) AD-2 isn't lint-enforced — a convention reviewed like the other AD rules; `use-playback`'s object URL predates it.
  - `[low]` `[reject]` (blind) No clipboard fallback without `navigator.clipboard` — the app is served over HTTPS (a secure context), where the API exists; failure already toasts.
  - `[low]` `[patch]` (blind) The new describe block orphans the edit-popover comment in tab-screen.test.tsx — moved.
  - `[false]` `[reject]` (blind) Holding Ctrl+Shift+C starts overlapping copies — the dispatcher ignores auto-repeat unless an entry opts in (5.8), and this entry doesn't.
  - `[low]` `[reject]` (blind) The `?` dialog test doesn't show the Shift modifier — the `?` dialog isn't built yet (epic Offline, accessibility and budgets).
  - `[low]` `[patch]` (blind) The shortcut and the toolbar read Bar lines from different sources — the shortcut reads the same `settingsSession` prefs the Tab screen uses by default (one source); see the verification-gap test.
  - `[low]` `[patch]` (edge) Windows-reserved slugs (con, nul, aux, prn, com1–9, lpt1–9) — suffixed with `-tab`.
  - `[low]` `[patch]` (edge) `pickFile` cancel on old browsers — the same as the blind finding.
  - `[low]` `[patch]` (edge) Non-decomposing letters — the same as the blind finding.
  - `[low]` `[reject]` (edge) The e2e comment about Windows — accurate per the intent probe (`userAgentData.platform` reports Windows); the comment is clarified.
  - `[false]` `[reject]` (edge) Literal equality fails on Windows — the spec says "except line endings"; the e2e normalises them.
  - `[low]` `[patch]` (verification-gap) The shortcut's default Bar-lines source is never checked — an e2e step presses Ctrl+Shift+C on a count-in take with Bar lines off and compares with the toolbar Copy.
  - `[low]` `[reject]` (verification-gap, other) The `\r\n` branch may not run in CI — it does (Windows UA data); `\n` is unit-tested.
  - `[low]` `[reject]` (intent) The bar-lines check runs on a seeded take — recorded takes have no count-in by default, so only a count-in take can show the toggle's effect.
  - `[false]` `[reject]` (intent) The platform detection is mirrored in e2e — `isWindowsPlatform` reads the browser-reported platform, the only observable one; the e2e asserts the matching endings.
  - `[low]` `[reject]` (intent) The disabled reason is checked as a `title` — the toolbar's existing convention (Insert, Delete, Trim).
  - `[low]` `[reject]` (intent) `pickFile` has no consumer yet — by design (R1a: for 6.5 and 6.6).

## Design Notes

- **Ctrl+Shift+C** may be reserved by Chrome for DevTools' element picker, depending on the platform. Playwright delivers the key to the page either way. Check in a real browser that the page receives it; if Chrome swallows it, record that in Implementation Notes (the toolbar button remains the path).

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass.
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test --project=dev tests/e2e/export.dev.spec.ts tests/e2e/tab-edit.dev.spec.ts tests/e2e/tab-screen.dev.spec.ts` -- expected: pass.

## Auto Run Result

**Status:** built, 2026-10-06.

**Summary:**
- `ui/platform.ts` (AD-2) owns clipboard writes, text and blob downloads, the file picker (with a focus fallback where `cancel` isn't fired) and Windows detection.
- The Tab toolbar's Copy and Download (after Delete) and Ctrl/⌘+Shift+C export `toText` of the visible notes, following the Bar lines toggle.
  - Copy toasts "Tab copied", or "Couldn't copy the tab".
  - Download saves `<slug>.txt` with `\r\n` on Windows, and toasts "Couldn't download the tab" on failure.
  - The slug folds diacritics and ß/ø/æ/œ/ł/đ, is at most 60 characters, falls back to `tab.txt`, and avoids reserved device names.
  - Both buttons are disabled with reasons in No notes found.

**Files:**
- `app/src/ui/platform.ts` (new), `app/src/model/export-file.ts` (new), `app/src/ui/tab-export.ts` (new).
- `app/src/ui/screens/Tab.tsx`, `app/src/ui/a11y/shortcuts.ts`, `icons.tsx`, `strings.ts`.
- Tests:
  - unit: `platform`, `shortcuts`, `tab-screen`;
  - e2e: `tests/e2e/export.dev.spec.ts`, and the toolbar list in `tab-edit.dev.spec.ts`.

**Review:** thorough, 22 findings (18 low, 3 false, 1 maybe-false).
- **Patched (low):**
  - slug folding and reserved names;
  - download failure toast;
  - `pickFile` focus fallback;
  - a test pinning the shortcut's Bar-lines source, plus the e2e shortcut step;
  - a test comment moved.
- **Deferred:** none.
- **Rejected:** with reasons in the triage log.

**Follow-up review: not recommended.** No high or medium.

**Verification:**
- lint, typecheck, format:check and test pass (1582).
- Full Playwright: 199 passed (perf included).

**Residual risks:**
- Ctrl/⌘+Shift+C may be taken by the browser's DevTools inspector in a real Chrome; this needs a manual check. The toolbar Copy is the dependable path.
