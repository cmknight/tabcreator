---
name: TabCreator
description: Free, on-device web app that turns single-note guitar playing into editable ASCII tab. Desktop Chrome, React + CSS Modules, no UI framework; tokens ship as CSS custom properties in app/src/ui/theme.css.
status: final
created: 2026-09-27
updated: 2026-09-28
sources:
  - ../../../../TabCreator-Requirements.md
  - ../../../../TabCreator-User-Stories.md
  - ../../../specs/spec-tabcreator/SPEC.md
colors:
  # Light theme. Dark pairs use the -dark suffix. Palette confirmed by the owner.
  background: '#FAFAF7'
  surface: '#FFFFFF'
  text: '#1C1B19'
  text-muted: '#5E5A54'
  border: '#8C877E'
  primary: '#1F5FAD'
  on-primary: '#FFFFFF'
  record: '#B3261E'
  on-record: '#FFFFFF'
  check-bg: '#FCE8B2'
  check-line: '#8A5A00'
  refit: '#6A3FB5'
  meter-ok: '#2E7D32'
  meter-warn: '#B26A00'
  meter-hot: '#C62828'
  success: '#2E7D32'
  warning: '#8A5A00'
  danger: '#B3261E'
  background-dark: '#141311'
  surface-dark: '#1D1B18'
  text-dark: '#ECE9E3'
  text-muted-dark: '#A8A39A'
  border-dark: '#6E6960'
  primary-dark: '#7FB0F0'
  on-primary-dark: '#0B1B2E'
  record-dark: '#F2766B'
  on-record-dark: '#2A0B08'
  check-bg-dark: '#4A3A12'
  check-line-dark: '#E3B34C'
  refit-dark: '#B99BF2'
  meter-ok-dark: '#5CC06A'
  meter-warn-dark: '#E3B34C'
  meter-hot-dark: '#F2766B'
  success-dark: '#5CC06A'
  warning-dark: '#E3B34C'
  danger-dark: '#F2766B'
typography:
  # System stacks only — no web-font download.
  ui:
    fontFamily: 'system-ui, "Segoe UI", -apple-system, sans-serif'
    fontSize: 15px
    fontWeight: '400'
    lineHeight: '1.5'
  ui-small:
    fontFamily: 'system-ui, "Segoe UI", -apple-system, sans-serif'
    fontSize: 13px
    fontWeight: '400'
    lineHeight: '1.4'
  heading:
    fontFamily: 'system-ui, "Segoe UI", -apple-system, sans-serif'
    fontSize: 20px
    fontWeight: '600'
    lineHeight: '1.3'
  display:
    fontFamily: 'system-ui, "Segoe UI", -apple-system, sans-serif'
    fontSize: 56px
    fontWeight: '600'
    lineHeight: '1'
  tab:
    fontFamily: 'ui-monospace, Consolas, Menlo, "Cascadia Mono", monospace'
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.35'
  numeric:
    fontFamily: 'ui-monospace, Consolas, Menlo, "Cascadia Mono", monospace'
    fontSize: 15px
    fontWeight: '500'
    lineHeight: '1.3'
rounded:
  sm: 4px
  md: 6px
  lg: 10px
  full: 9999px
spacing:
  '1': 4px
  '2': 8px
  '3': 12px
  '4': 16px
  '6': 24px
  '8': 32px
  '12': 48px
  gutter: 16px
  content-max: 1100px
  focus-ring: 2px
components:
  button-primary:
    background: '{colors.primary}'
    foreground: '{colors.on-primary}'
    radius: '{rounded.md}'
    height: 36px
  button-pressed:
    background: 'color-mix(in srgb, {colors.primary} 14%, {colors.surface})'
    foreground: '{colors.text}'
    border: '1px solid {colors.primary}'
    fontWeight: '600'
  button-secondary:
    background: '{colors.surface}'
    foreground: '{colors.text}'
    border: '1px solid {colors.border}'
    radius: '{rounded.md}'
    height: 36px
  button-destructive:
    background: '{colors.surface}'
    foreground: '{colors.danger}'
    border: '1px solid {colors.danger}'
    radius: '{rounded.md}'
    height: 36px
  record-button:
    background: '{colors.record}'
    foreground: '{colors.on-record}'
    radius: '{rounded.full}'
    size: 88px
  level-meter:
    track: '{colors.border}'
    ok: '{colors.meter-ok}'
    warn: '{colors.meter-warn}'
    hot: '{colors.meter-hot}'
    height: 12px
    radius: '{rounded.sm}'
  tab-system:
    font: '{typography.tab}'
    background: '{colors.surface}'
    foreground: '{colors.text}'
    padding: '{spacing.4}'
  tab-note-selected:
    outline: '2px solid {colors.primary}'
  tab-note-check:
    background: '{colors.check-bg}'
    underline: '2px dotted {colors.check-line}'
  tab-note-refit:
    outline: '2px dashed {colors.refit}'
  tab-note-playing:
    outline: '2px solid {colors.text}'
  banner-warning:
    background: '{colors.check-bg}'
    foreground: '{colors.text}'
    border-left: '4px solid {colors.warning}'
  banner-error:
    background: '{colors.surface}'
    foreground: '{colors.text}'
    border-left: '4px solid {colors.danger}'
  menu:
    background: '{colors.surface}'
    border: '1px solid {colors.border}'
    radius: '{rounded.md}'
  scrim:
    background: 'rgba(0, 0, 0, 0.45)'
  toast:
    background: '{colors.text}'
    foreground: '{colors.surface}'
    radius: '{rounded.md}'
  dialog:
    background: '{colors.surface}'
    radius: '{rounded.lg}'
  focus-ring:
    outline: '{spacing.focus-ring} solid {colors.primary}'
    offset: 2px
    on-selected-note: '2px {colors.surface} gap, then 2px {colors.primary} ring outside the selection outline'
---

## Brand & Style

TabCreator is a free tool a guitarist reaches for mid-practice: play a riff, stop, get tab. The aesthetic is a quiet practice notebook — warm neutral paper, dark ink, and the ASCII tab set in monospace as the unmistakable centrepiece. The interface chrome recedes so the tab reads like text you could paste anywhere, because it is exactly that.

Two colours carry meaning; everything else is neutral. Blue is "act here" (primary actions, selection, focus). Red is "the mic is live" and appears only on the Record control and the recording state. The amber check highlight is the one place the tab itself takes colour, and it always comes with a dotted underline so it survives without colour.

## Colors

Dark mode swaps every token for its `-dark` pair under `prefers-color-scheme: dark` or the Settings theme toggle. Contrast figures hold in both themes.

| Token(s) | Used for | Never / always | Min contrast |
| --- | --- | --- | --- |
| `{colors.background}`, `{colors.surface}` | Warm off-white page, white panels (dark: near-black warm greys). The tab always sits on `{colors.surface}`. | — | — |
| `{colors.text}`, `{colors.text-muted}` | Ink and secondary ink (dates, durations, hints, status line) | Muted text is never used for anything the user must act on | text ≥ 14:1, muted ≥ 6.5:1 |
| `{colors.border}` | Dividers, input outlines, meter track | — | ≥ 3:1 on surface (WCAG non-text) |
| `{colors.primary}`, `{colors.on-primary}` | Primary buttons, links, selected note outline, focus ring, active nav item, tuner needle | The tuner's in-tune state uses `{colors.success}`, not blue | primary text ≥ 5:1; on-primary ≥ 6.3:1 |
| `{colors.record}`, `{colors.on-record}` | Record button and recording indicator only | Never for errors — errors use `{colors.danger}`, which shares the hue but always pairs with an icon and text | on-record ≥ 6.3:1 |
| `{colors.check-bg}`, `{colors.check-line}` | Low-confidence notes and warning banners | Always paired with the dotted underline or a warning icon | text on check-bg ≥ 9:1 |
| `{colors.refit}` | The brief outline on notes that a re-fit re-fingered; unmistakable from selection blue and check amber | — | ≥ 3:1 |
| `{colors.meter-ok}`, `{colors.meter-warn}`, `{colors.meter-hot}` | Level meter zones only (below −12, −12 to −3, above −3 dBFS) | Zone meaning is also carried by the warning text | ≥ 3:1 |
| `{colors.success}`, `{colors.warning}`, `{colors.danger}` | Status text and banner edges | Always with an icon | ≥ 5:1 |

## Typography

- **`{typography.tab}`** — the ASCII tab, 16 px monospace. The tab view measures the rendered character width to compute `widthChars`, so any monospace font in the stack works. Also used for the .txt preview and the Library's note preview.
- **`{typography.numeric}`** — timers (`m:ss`), cents readout, dBFS, BPM. Monospace so digits don't jitter as they change.
- **`{typography.display}`** — the tuner's string name ("A") and the count-in beat number.
- **`{typography.heading}`** — screen `<h1>` and dialog titles.
- **`{typography.ui}` / `{typography.ui-small}`** — everything else; small for metadata and the status line.

## Layout & Spacing

- 4-px base scale (`{spacing.1}`–`{spacing.12}`).
- Content is centred with a maximum width of `{spacing.content-max}` and `{spacing.gutter}` side gutters. The tab view may use the full content width, because more characters per line means fewer wrapped tab systems.
- One column on every screen.
- The top bar (app name + Record, Library, Tuner, Settings) has a fixed height; screens scroll beneath it.
- Designed for windows ≥ 720 px wide. Narrower windows still work (the tab reflows, the toolbar wraps) but get no dedicated layout.

## Elevation & Depth

Flat. Panels are separated by `{colors.surface}` against `{colors.background}` and a hairline `{colors.border}`; only dialogs, toasts and popover menus cast a soft shadow, to show they sit above the page. Dialogs sit on `{components.scrim}` in both themes. No shadows on buttons or cards.

## Shapes

Small, tool-like radii: `{rounded.sm}` for inputs and the meter; `{rounded.md}` for buttons, toasts and panels; `{rounded.lg}` for dialogs. `{rounded.full}` only on the Record button and the tuner's string chips — the two round, physical-feeling controls.

## Components

Visual references (light + dark, with alternate states): [`mockups/record.html`](mockups/record.html), [`mockups/tab.html`](mockups/tab.html), [`mockups/tuner.html`](mockups/tuner.html), [`mockups/library.html`](mockups/library.html), [`mockups/settings.html`](mockups/settings.html) (includes the keyboard shortcuts dialog and unsupported screen). DESIGN.md and EXPERIENCE.md win on any conflict with a mockup.

### Shared controls

- **Pressed / selected** — one style everywhere: `{components.button-pressed}` (primary-tinted fill, primary border, semibold label) for toggle buttons and selected segments. Never a solid primary fill, which is reserved for the one primary action on a screen.
- **Destructive button** — `{components.button-destructive}` with a trash icon, in menus and dialogs; never the default.
- **Form controls** (microphone select, tempo field, search box, analysis settings sliders and number fields) — native elements restyled only to `{typography.ui}`, `{colors.surface}` fill, 1 px `{colors.border}` outline, `{rounded.sm}`, 36 px height. Sliders show their value in `{typography.numeric}` beside the track and their end labels ("Fewer notes" ↔ "More notes") in `{typography.ui-small}`.
- **Focus ring** — `{components.focus-ring}` on every focusable element. On a selected tab note the ring sits outside the selection outline with a 2 px `{colors.surface}` gap, so the two never merge.
- **Progress bar** — 6 px bar in `{colors.primary}` on a `{colors.border}` track, with the percentage in `{typography.numeric}`.
- **Popover menu** — `{components.menu}` with a soft shadow; the trigger ("⋯") shows the pressed style while open.

### Feedback and overlays

- **Banners** — full-width strip above the content: `{components.banner-warning}` (tuning, Bluetooth, clipping, all-uncertain, recovered take, storage notice) or `{components.banner-error}` (analysis failed, storage full, engine failed); icon, one sentence, one action — a button when it acts, a link when it navigates. Warnings add a text "Dismiss" button at the end.
- **Toast** — inverted `{components.toast}`, bottom-centre, auto-dismiss after 4 s; one optional action.
- **Dialog** — `{components.dialog}` centred on `{components.scrim}`, max 480 px wide; title, body, right-aligned actions, with the safe action first in tab order and focused when the dialog opens.

### Record

- **Mic setup card** — inline panel, max 560 px, mic icon, heading + one line of body text + primary button; error variants add a `{colors.danger}` left edge and numbered recovery steps.
- **Record button** — 88 px red circle with a white dot (idle) or white rounded square (recording), label "Record"/"Stop" below ("Cancel" during count-in). The only large control on the Record screen, centred in a 640 px column. The timer above it uses `{typography.display}` size in the `{typography.numeric}` font, muted when idle.
- **Level meter** — labelled "Input level"; horizontal 12 px bar, −60 to 0 dBFS with scale labels and the unit "dBFS" (no numeric readout); fill segmented into green / amber / red zones; 1.5 s peak-hold tick in `{colors.text}`. Warning text with icon sits directly under it.

### Tab

- **Inline-editable title** — `{typography.heading}` with a 16 px pencil icon in `{colors.text-muted}` shown on hover and focus.
- **Toolbar** — row of secondary buttons with icon + text label; disabled buttons at 40% opacity with a tooltip explaining why. Toggles (Bar lines; Analysis settings while its panel is open) show the pressed style.
- **Analysis settings panel** — inline panel below the toolbar (not a dialog) on `{colors.surface}` with a `{colors.border}` hairline and `{spacing.4}` padding; Re-analyse is a `{components.button-primary}`.
- **Status line** — `{typography.ui-small}` in `{colors.text-muted}`, directly under the toolbar; the "to check" count in `{colors.warning}` when non-zero.
- **Playback controls** — Play/Pause `{components.button-secondary}` with icon (the only Play control on the screen), a speed segmented control (0.5× / 0.75× / 1×), and current time / duration in `{typography.numeric}`.
- **Trim strip** — full-width 64 px waveform in `{colors.text-muted}` on `{colors.surface}`; the trimmed-out ends dimmed to 30% opacity; handles are 8 px `{colors.primary}` bars with a time label in `{typography.numeric}`.
- **Tab system** — each wrapped system is a `<pre>` in `{typography.tab}` on `{colors.surface}`, `{spacing.4}` padding, one blank line between systems. Bar lines, when shown, are plain `|` characters in `{colors.text}` — no extra styling.
- **Tab note states** (overlaid buttons exactly covering the note's characters):
  - selected — `{components.tab-note-selected}` (solid blue outline)
  - low-confidence — `{components.tab-note-check}` (amber fill + dotted underline)
  - re-fingered by a re-fit — `{components.tab-note-refit}` (dashed violet outline, fades after 1.5 s; with reduced motion, it disappears without fading)
  - currently playing — `{components.tab-note-playing}` (solid ink outline)
  - States combine: a selected low-confidence note shows both the amber fill and the blue outline.

### Tuner

- **Tuner** — large string name in `{typography.display}` ("—" when no signal); horizontal needle track −50 to +50 cents (max 640 px) with tick marks, blue needle and the numeric cents readout; green check + "In tune" in `{colors.success}` while the pitch holds in tune; six round string chips labelled E A D G B E (both E strings show "E"; their accessible names say "Low E" and "High E") that fill with `{colors.success}` and show a check badge when ticked.

### Library

- **Library row** — full-width row, `{spacing.3}` vertical padding, hairline `{colors.border}` between rows; title in `{typography.ui}` weight 600, metadata in `{typography.ui-small}` `{colors.text-muted}`, note preview in `{typography.tab}` at 13 px, status badge as a `{rounded.full}` outline pill in `{colors.text-muted}` ("Analysed" in `{colors.success}`); rows without notes show "—" as the preview. The storage footer ("23 takes · 41 MB used") is pinned to the bottom of the window.
- **Backup / Restore** — `{components.button-secondary}` pair in the Library header; backup progress appears in the progress bar.

### Settings

- **Settings sections** — stacked panels (Defaults for new takes, Appearance, Storage, About) styled like the Analysis settings panel; Theme is a segmented control whose selected segment uses the pressed style.

### Unsupported screen

- **Unsupported screen** — full window on `{colors.background}`, no top bar, centred heading and one line of body text.

## Do's and Don'ts

| Do | Don't |
| --- | --- |
| Let the monospace tab dominate the Tab screen | Decorate the tab with colour beyond the four note states |
| Reserve red for the live mic | Use red for generic errors without an icon and text |
| Pair every colour signal with a shape, icon or text | Rely on colour alone (meter zones, check notes, refit) |
| Use `{typography.numeric}` for any changing number | Let timers or cents readouts jitter in a proportional font |
| Keep screens one column | Add sidebars or multi-pane layouts |
| Ship system font stacks | Download web fonts (they cost offline-cache space and bundle budget) |
