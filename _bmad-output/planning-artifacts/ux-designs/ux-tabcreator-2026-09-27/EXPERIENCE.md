---
name: TabCreator
status: final
created: 2026-09-27
updated: 2026-09-28
sources:
  - ../../../../TabCreator-Requirements.md
  - ../../../../TabCreator-User-Stories.md
  - ../../../specs/spec-tabcreator/SPEC.md
---

# TabCreator — Experience Spine

## Foundation

Desktop web app for the last two versions of Chrome on Windows and macOS, installable as a PWA and fully offline after first load; other Chromium browsers work best-effort. No phones or tablets. React + TypeScript with CSS Modules and no UI framework; `DESIGN.md` is the visual identity reference and its tokens are CSS custom properties in `app/src/ui/theme.css`. All user-visible strings live in `app/src/ui/strings.ts`. Nothing leaves the device: no accounts, sign-in, analytics or crash reporting.

Requirement-level behaviour (message texts, thresholds, timings) is defined in `TabCreator-User-Stories.md`; this spine owns how surfaces, states and interactions fit together. `DESIGN.md` and this document win on any conflict with a mockup.

A **re-fit** is the automatic re-fingering of nearby notes after the player edits or confirms a note: unlocked notes in the same phrase may move to other strings to stay playable around the locked one.

## Information Architecture

Every stated need lands on a surface: tune (Tuner), record (Record), analyse and review (Tab), edit and undo (Tab), play back (Tab), save, find, rename, delete (Library), export (Tab), back up (Library), defaults and theme (Settings).

Hash routes, no router library. Top bar on every screen: app name, then Record · Library · Tuner · Settings; the current screen's link is marked active.

| Surface | Route / reached from | Layout (top to bottom) | Mock |
| --- | --- | --- | --- |
| Record (default) | `#/record`, app open, top bar | Banners (recovered take, Bluetooth), h1 "Record" with "Tune first" link, panel with microphone select and level meter, count-in row, timer, Record button. The mic setup card replaces the panel on first use. | [`mockups/record.html`](mockups/record.html) |
| Tab | `#/tab/{id}`, after Stop, Library row | Warning/error banners, title (inline-editable) with date ("Sun 27 Sep 2026, 21:14") and duration, toolbar, status line with "Next to check" at its right end, playback controls, the tab. | [`mockups/tab.html`](mockups/tab.html) |
| Library | `#/library`, top bar | h1, search, Back up library / Restore from backup, list of takes (newest first) with row menus, storage footer pinned to the bottom. | [`mockups/library.html`](mockups/library.html) |
| Tuner | `#/tuner`, top bar, "Tune first" link | h1, string name, needle, cents with direction, six string chips, level meter, microphone select, "Done — go to Record" (primary). | [`mockups/tuner.html`](mockups/tuner.html) |
| Settings | `#/settings`, top bar | h1, then panels: Defaults for new takes, Appearance (theme: System / Light / Dark), Storage (status; links to Library backup when not protected), About (engine version, Keyboard shortcuts). | [`mockups/settings.html`](mockups/settings.html) |

Overlays and replacement views (overlays are one level deep, never stacked):

| View | Opened from | Purpose |
| --- | --- | --- |
| Mic setup card (replaces the Record/Tuner panel) | First visit to Record or Tuner; access lost | Explain mic use before any browser prompt |
| Analysis settings panel | Tab toolbar | Sensitivity, minimum note length, highest fret, Re-analyse |
| Trim strip | Tab toolbar | Waveform with two handles, Save / Reset trim |
| Fret popover | Double-click a note | Type a fret number |
| Confirm dialog | Delete take, delete audio, re-analyse with locked notes, restore from backup | Name the take and the consequence |
| Keyboard shortcuts dialog | `?` | Every shortcut in Interaction Primitives |
| Unsupported screen (replaces the app) | App start when AudioWorklet, OPFS, WebAssembly or Web Locks is missing | "TabCreator needs a recent desktop Chrome" |

## Voice and Tone

Plain, short, practical — a bandmate pointing at the problem, not a system reporting one. Say what happened, then what to do. Brand posture lives in `DESIGN.md.Brand & Style`. The examples below illustrate the voice; the exact strings for each state are in State Patterns.

| Do | Don't |
| --- | --- |
| "Too loud — move back or lower the input" | "Input clipping detected (peak ≥ −1 dBFS)" |
| "No notes found" + three tips | "Analysis returned 0 results" |
| "Your guitar seems about 45 cents flat — tune up and record again for accurate tab" | "Tuning offset −45 c exceeds threshold" |
| "Looks like drop tuning — not supported in v1" | "Notes below E2 were discarded" |
| "An unfinished take from 9:14 pm was recovered (0:42)" | "Recovery data found. Restore?" |
| "Re-analysing replaces notes you haven't edited. Your edited notes are kept." | "Are you sure?" |
| "Audio is analysed on this computer and never uploaded." | Privacy boilerplate or legal tone |
| Numbers with units: "42 notes · 3 to check", "23 takes · 41 MB used" | Emoji, exclamation marks, celebration |

## Component Patterns

Behavioural rules that hold in every state; state-specific treatment is in State Patterns. Visual specs live in `DESIGN.md.Components`.

| Component | Use | Behavioural rules |
| --- | --- | --- |
| Mic setup card | Record, Tuner | Only its "Allow microphone" button triggers the browser prompt. Error variants keep the card in place; "Try again" retries without a page reload. |
| Record button | Record | Click or `Space` toggles record/stop. `aria-pressed` reflects state. Recording starts within 100 ms. During count-in it reads "Cancel" and the beat number replaces the timer; a press or `Esc` cancels. Disabled with a reason when the mic is unavailable. |
| Level meter | Record, Tuner | Live at ≥ 30 fps before and during recording. Warnings appear as text under the meter; "Too loud" clears after 2 s without clipping; "Too quiet" appears only after 3 s of low input, and only while recording or on the Tuner. |
| Microphone select | Record, Tuner | Hidden when there's only one input. Disabled while recording, with the tooltip "Can't change the microphone while recording". Changing it swaps the meter source immediately. |
| Count-in controls | Record | Pressed-style toggle (default off) and Tempo field 40–240 BPM (default 100); both are remembered and both are disabled while recording. |
| Toolbar | Tab | Undo, Redo, Insert, Delete, Copy, Download, Trim, Bar lines, Analysis settings. Toggles expose `aria-pressed`/`aria-expanded`. Bar lines appears only when the take had a count-in and has notes. Undo/Redo tooltips name the action ("Undo move to string 3"). |
| Status line | Tab | "42 notes · 3 to check"; updates on every edit or confirm. "Next to check" (`N`) sits at its right end and jumps to the next flagged note in time order. |
| Analysis progress | Tab | Labelled "Analysing…"; the bar never moves backward and shows a percentage. Cancel stops analysis within 200 ms and leaves an "Analyse" button. Resumes automatically if the page reloads mid-analysis. |
| Playback | Tab | The only Play/Pause control; sits between the status line and the tab. Plays the take's `<audio>`; the current note is outlined and kept in view (scroll at most every 500 ms). Clicking a note while playing, or pressing `P`, seeks to 100 ms before it. Speed 0.5× / 0.75× / 1× with pitch preserved. |
| Tab view | Tab | Renders from the note list; reflows on resize (debounced 100 ms) and keeps the selection. Each note is a button over its characters. `Tab` enters the tab area; arrows move within it. |
| Note (in tab) | Tab | Click selects; double-click opens the fret popover. Editing, inserting or confirming a note locks it. Notes moved by a re-fit are outlined for 1.5 s, and the live region announces "<n> nearby notes re-fingered". |
| Fret popover | Tab | Opens with the fret field focused. Accepts 0 to the take's highest fret; `Enter` applies the fret and locks the note; `Esc` closes without changes. |
| Analysis settings panel | Tab | Changes save to the take. Re-analyse asks for confirmation only when the tab has locked notes; it keeps locked notes and never brings back deleted ones. The result is one undo step. |
| Trim strip | Tab | Drag handles or use the arrow keys; handles announce their time. Save re-analyses the trimmed range; Reset trim restores the full take. |
| Library row | Library | Title, date/time, duration, note count, status badge, audio size, first-12-notes preview (before analysis, the preview shows "—" and the note count is blank). Click or `Enter` opens the tab. Row menu ("⋯", "More actions for <title>"): Rename (inline), Delete audio only, Delete take. |
| Search | Library | "Search takes"; filters titles as you type, ignoring case and accents; no match highlighting. |
| Backup / Restore | Library | Backup builds one .zip in the background with a "Backing up…" bar under the header; no Cancel, and the button is disabled while it runs. Restore imports takes not already present and reports "Imported 12 takes, skipped 3 already in your library"; a malformed file changes nothing. |
| Banner | Record, Tab, Library, Settings | One sentence and one action (the recovered-take banner has two: Open, Discard). The action is a button when it acts and a link when it navigates. Warnings have a Dismiss button that hides them for the session; they return on the next visit while the condition holds. Errors have no Dismiss and stay until resolved. |
| Toast | Global | Confirmations only (for example, "Tab copied"). Never the only place an error appears. |
| Confirm dialog | Global | In-app, never `window.confirm`. Names the take and the consequence ("Its tab and recording are removed from this computer. This can't be undone."); Cancel comes first and has focus; the destructive button is never the default. Focus is trapped while open and restored on close. |
| Keyboard shortcuts dialog | Global | `?` opens it; lists every shortcut in Interaction Primitives grouped by where it works; `Esc` or Close dismisses it and restores focus. |

## State Patterns

| State | Surface | Treatment |
| --- | --- | --- |
| First visit, mic not yet allowed | Record, Tuner | Mic setup card: "TabCreator needs your microphone" / "Audio is analysed on this computer and never uploaded." / "Allow microphone". No browser prompt until clicked. |
| Mic denied / no device / in use | Record, Tuner | Inside the setup card with a danger edge: specific message, numbered recovery steps (for denied: Chrome's site settings icon → Microphone → Try again), and "Try again", which works without a page reload. |
| Mic access lost mid-session | Record, Tuner | Any recording stops cleanly and is kept; the setup card returns with "Microphone access was lost". |
| Device unplugged | Record, Tuner | Idle: switches to the default input and shows the toast "Microphone disconnected — switched to <label>". Recording: stops and saves, with the toast "Microphone disconnected — recording stopped and saved". |
| Bluetooth / low-rate input | Record, Tuner | Warning banner: "This microphone may be a Bluetooth headset in call mode — accuracy will be poor. Use the built-in or a wired mic." |
| Too loud / too quiet | Record, Tuner | Meter warnings (see Level meter). Takes that clipped show a clipping warning on the Tab screen. |
| Recording near limit | Record | "30 seconds left" under the timer at 4:30 (warning colour and icon); auto-stop at 5:00, then normal analysis with a "Maximum length reached" toast on the Tab screen. |
| Take too short | Record | Under 0.5 s: "Too short — nothing recorded"; no take created. |
| Recovered take | Record | Banner: "An unfinished take from <time> was recovered (m:ss)" with Open / Discard. |
| No signal | Tuner | String name shows "—" with "Play a single open string"; no needle; ticked chips stay. |
| Analysing | Tab | Progress bar and Cancel; otherwise the screen shows only the title and duration. |
| Engine failed to load | Tab, Settings | Error banner "The analysis engine failed to load" with a Reload button; Settings About shows "Engine version unavailable". Recording and Library keep working. |
| Analysis failed | Tab | Error banner "Analysis failed — try again" with Retry; technical detail goes to logs only. |
| No notes found | Tab | "No notes found" with tips ("Check the input level", "Play single notes", "Raise sensitivity in Analysis settings" — the last links to the panel). Undo, Redo, Insert, Delete, Copy and Download are disabled with a tooltip; Trim and Analysis settings stay enabled; Bar lines is hidden. |
| Every note uncertain | Tab | Warning banner: "Every note is uncertain — check the input level and room noise, then re-analyse". |
| Tuning off | Tab | Warning banner "Your guitar seems about <n> cents <flat\|sharp> — tune up and record again for accurate tab" with an "Open tuner" link. Dismissible for the session; reappears on reopening the take until a re-analysis clears it. |
| Drop tuning | Tab | Warning banner "Looks like drop tuning — not supported in v1". Same dismiss rule as Tuning off. |
| Audio deleted | Tab, Library | Play and Trim disabled with "Audio deleted"; the tab remains editable and exportable. |
| Storage full | Tab, Library | Error banner "Storage is full — delete takes or their audio, or back up and clear"; on Tab it links to the Library (no action on the Library itself); the unsaved result is kept so Retry can save it. |
| Storage may be cleared | Library, Settings | Library warning banner when persistent storage is refused, with a "Back up library" action, shown once ever; Settings shows "Storage: protected" or "Storage: may be cleared by the browser". |
| Empty library | Library | "No takes yet" and a Record button; search and Back up library disabled, Restore enabled, no footer. |
| No search matches | Library | "No takes match "<query>"" and Clear search. |
| Restore failed | Library | Error banner "That file isn't a TabCreator backup — nothing was changed." |
| Update available | Global | Toast "Update available — Reload"; never shown while recording or analysing. |
| Offline | Global | No indicator — every feature works offline. |
| Unsupported browser | App | Full-screen "TabCreator needs a recent desktop Chrome"; no partial app. |
| Open in another tab | App | Full-screen "TabCreator is open in another tab" with "Use here", which moves the app to this tab within 3 s; the other tab keeps any recording and shows the same screen. |
| Update blocked | App | Full-screen "Close other TabCreator tabs to finish updating". |

## Interaction Primitives

**Keyboard-complete.** Every action works by keyboard alone and by mouse alone. Shortcuts never fire while focus is in a text field.

| Key | Where | Action |
| --- | --- | --- |
| `Esc` | Global | Cancel count-in, clear note selection, close dialog/popover/panel |
| `?` | Global | Keyboard shortcuts dialog |
| `Space` | Record | Record / stop |
| `Space` | Tab | Play / pause |
| `←` / `→` | Tab | Previous / next note |
| `↑` / `↓` | Tab | Move note to thinner / thicker string, same pitch (skips unplayable strings) |
| `0`–`9` | Tab | Set fret; two digits within 400 ms make one number |
| `Delete` / `Backspace` | Tab | Delete note |
| `I` | Tab | Insert note after selection |
| `Enter` | Tab | Confirm selected note (clears flag, locks it) |
| `N` | Tab | Next note to check |
| `P` | Tab | Seek playback to selected note |
| `Ctrl/⌘+Z` | Tab | Undo |
| `Ctrl/⌘+Shift+Z`, `Ctrl+Y` | Tab | Redo |
| `Ctrl/⌘+Shift+C` | Tab | Copy tab |
| `←` / `→` | Trim handle | Nudge 10 ms |
| `Shift+←` / `Shift+→` | Trim handle | Nudge 100 ms |

**Mouse:** click to select or act; double-click a note for the fret popover; drag only for trim handles. No hover-only affordances. No drag-and-drop elsewhere.

**Saving:** automatic. Edits save 300 ms after the last change; there is no Save button. Undo history lasts for the session only.

## Accessibility Floor

Behavioural. Visual contrast lives in `DESIGN.md` (all load-bearing pairs meet AA in both themes).

- WCAG 2.2 AA on every screen in both themes; axe reports no serious or critical violations.
- The full record → edit → export flow is completable with the keyboard only; visible focus everywhere; skip link "Skip to tab" on the Tab screen; logical tab order; no keyboard traps outside open dialogs.
- The tab area is `role="application"` with instructions via `aria-describedby`. Each note's label: "Note 12: B string, fret 3, D4, at 4.25 seconds", plus ", check this note" when flagged.
- Toggleable "Note list view": an ordered list of the same labels, for reading the whole tab.
- The live region announces edits ("Moved to G string, fret 7"), re-fits ("<n> nearby notes re-fingered"), analysis progress every 25%, and recording start/stop.
- Colour is never the only cue: meter zones have text warnings; flagged notes have an underline and label text; re-fit and selection use different outline styles.
- `prefers-reduced-motion`: no smooth scrolling, no meter easing; the re-fit highlight appears and disappears without fading.

## Responsive & Platform

Desktop only. The layout is comfortable at ≥ 720 px wide; the tab recomputes characters per line on every resize, so narrow windows produce more, shorter systems rather than horizontal scroll. The toolbar wraps to two rows below ~900 px. The installed PWA opens in its own window with the same layout. No touch-specific behaviour.

## Anti-patterns

- **Rejected — native `window.confirm` / `alert`:** all confirmations are in-app dialogs (per the user stories).
- **Rejected — accounts, sign-in prompts, "rate us", telemetry consent banners:** nothing leaves the device, so there is nothing to ask.
- **Rejected — auto-correcting tuning:** the app warns and points to the Tuner; it never silently shifts pitches.
- **Rejected — auto-reload on update while recording or analysing.**

## Key Flows

### Flow 1 — Capture a riff (Chris, evening practice, laptop on the desk)

1. Chris has just played a riff they like. They open TabCreator (installed app); it lands on Record.
2. The meter shows healthy green levels. They click "Tune first", tune until all six string chips tick on the Tuner, then choose "Done — go to Record".
3. They turn on the count-in at 90 BPM and press `Space`. The 4-3-2-1 count shows; they play the riff and press `Space` again.
4. The Tab screen opens with the progress bar; under two seconds later the tab appears with "38 notes · 2 to check".
5. They press `N`: the first flagged note is a ringing open string misheard as a note on the G string. They press `Delete`. `N` again — a bend came out as its starting note; they press `Enter` to confirm it.
6. **Climax:** They play the take back at 0.75×, watching the outline walk across the tab note by note. It matches. They press `Ctrl+Shift+C` — "Tab copied" — and paste it into their notes. The riff they played two minutes ago is now tab, and nothing left their laptop.

Failure: the guitar was 45 cents flat → the Tab screen shows the tuning warning with a link to the Tuner; Chris tunes and records again.

### Flow 2 — Fixing a take from a noisy room (Chris, fan running, recording a solo)

1. Chris records a 90-second solo with a desk fan on. The tab appears with "212 notes · 41 to check" and several phantom notes.
2. They fix the first phrase by hand: move two notes up a string (`↑`) and delete three phantoms. Nearby notes re-finger around those moves, briefly outlined.
3. They open Analysis settings and drag Sensitivity towards "Fewer notes", then Re-analyse. The dialog says edited notes are kept; they confirm.
4. **Climax:** The new tab has far fewer phantoms — and the first phrase is exactly as they left it; the three phantoms they deleted did not come back. One `Ctrl+Z` would restore the previous analysis if they wanted it.

Failure: sensitivity too low drops real notes → they nudge it back up and re-analyse; locked notes still hold.

### Flow 3 — The tab closed mid-take (Chris, recording a long idea)

1. Three minutes into a take, Chris closes the wrong browser tab.
2. They reopen TabCreator. Record shows: "An unfinished take from 9:14 pm was recovered (3:02)".
3. **Climax:** They click Open; the take analyses like any other and the tab appears. At most the last second is missing.

Failure: they don't want it → Discard removes the take and its recovery file.

### Flow 4 — Backing up the library (Chris, before clearing browser data)

1. In Library, Chris clicks "Back up library"; progress runs while they keep browsing.
2. A `tabcreator-backup-YYYYMMDD.zip` downloads.
3. Later, after a fresh Chrome profile, they choose "Restore from backup" and pick the file.
4. **Climax:** "Imported 23 takes" — every take, tab and recording is back, playable and editable.

Failure: they restore the same file twice → "Imported 0 takes, skipped 23 already in your library"; nothing duplicates. A damaged file shows an error and changes nothing.
