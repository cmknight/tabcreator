---
title: 'Copy and Download on the Tab screen'
type: 'feature'
ticket: '4'
created: '2026-10-06'
status: 'draft'
route: 'full'
route_source: 'auto'
review: ''
review_source: ''
lenses_ran: []
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
- [ ] `app/src/ui/platform.ts` (+ a slug function in `app/src/model/` for the pure part) -- the platform helpers and the slug -- AD-2.
- [ ] `app/src/ui/screens/Tab.tsx`, `icons.tsx`, `strings.ts` -- Copy and Download buttons, export text, toasts, disabled reasons -- CAP-18.
- [ ] `app/src/ui/a11y/shortcuts.ts` -- Ctrl/⌘+Shift+C -- the shortcut.
- [ ] Unit tests for every I/O row (slug, line endings with an injected platform, platform helpers with stubbed DOM/clipboard, toolbar state, shortcut).
- [ ] `app/tests/e2e/export.dev.spec.ts` -- the ACs.

**Acceptance Criteria:**
- Given a recorded `c_major_scale_pos1` take on the Tab screen, when the player clicks Copy and then Download, then the clipboard text equals the downloaded file's text, and every line of each tab system has the same length.
- Given a take renamed to "Blues / Riff 🎸 in A♯", when the player downloads, then the file is named `blues-riff-in-a.txt`.
- Given the take, when the player presses Ctrl+Shift+C, then the clipboard holds the tab and "Tab copied" shows.
- Given a count-in take with Bar lines off, when the player copies and downloads, then neither text contains bar lines.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

- **Ctrl+Shift+C** may be reserved by Chrome for DevTools' element picker, depending on the platform. Playwright delivers the key to the page either way. Check in a real browser that the page receives it; if Chrome swallows it, record that in Implementation Notes (the toolbar button remains the path).

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass.
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test --project=dev tests/e2e/export.dev.spec.ts tests/e2e/tab-edit.dev.spec.ts tests/e2e/tab-screen.dev.spec.ts` -- expected: pass.
