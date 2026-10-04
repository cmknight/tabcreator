---
title: 'Tab layout and text'
type: 'feature'
ticket: '5'
created: '2026-10-04'
status: 'built'
baseline_revision: '604c241b4a846c48135558cde5ea947ea2c1f8b2'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/specs/spec-tabcreator/tab-format.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** the Tab screen (entry 8) and the .txt export (epic Library and export) both need tab text, and nothing produces it yet.

**Approach:** add a pure module, `app/src/model/tab-render.ts`, with these functions:
- `layoutTab(notes, widthChars, countInBpm?)` returns systems of six lines, with cell and bar-column positions.
- `toText(take, notes)` returns the export text.

The rules are US-6.1's, quoted below, with the golden sample from tab-format.md.

## Boundaries & Constraints

**Always:**
- **Types:**
  - `layoutTab(notes: readonly Note[], widthChars: number, countInBpm?: number): TabLayout`.
  - `TabLayout = { systems: { lines: string[6]; cells: { noteId: string; col: number; width: number; string: StringNo }[]; barCols: number[] }[] }`.
  - `col` is the 0-based index into the line string, prefix included. `lines[0]` is `e` (string 1) and `lines[5]` is `E` (string 6).
  - Use `Note` and `StringNo` from `model/types.ts`. No imports from `ui/`, `session/` or `storage/` (pure model).
- **Notes in `startMs` order.** Sort a copy, stably, by `startMs`. A note takes its fret digits (1 or 2 characters) on its string, and the other five lines get the same number of `-`.
- **Spacing:**
  - After each note: `clamp(round(ioi / 125), 1, 8)` dashes, where `ioi` is the gap to the next note's start (a gap of 0 gives 1). The last note gets one dash.
  - Each system's lines start with `<letter>|-` and end with `---|`.
- **Bar lines** (only when `countInBpm` is set and greater than 0):
  - `barMs = 4 × 60000 / countInBpm`. Boundaries fall at `n × barMs` (n ≥ 1) in take time.
  - For each boundary `b`, draw `|` on all six lines followed by one dash. Place it after the spacing dashes of the last note starting before `b`. A note starting exactly on `b` comes after the bar line.
  - A boundary before the first note's start goes right after the leading dash.
  - Every boundary crossed gets its own bar line, so empty bars stay visible.
  - Omit boundaries after the last note's start.
  - `barCols` lists the column of each drawn `|`.
- **Wrapping:**
  - The units are each note (its digits plus its spacing dashes) and each bar line (`|` plus one dash). They pack into systems so that every line, prefix and closing `|` included, is ≤ `widthChars`. Overhead per line is 3 for `x|-` plus 4 for `---|`.
  - A unit is never split, and a note's spacing stays with it (assumption: see Design Notes).
  - When a break is needed, prefer the last bar-line unit in the system if it is in the system's last third; otherwise break before the unit that doesn't fit.
  - A bar line at a break is dropped; the system edge stands in for it.
  - A single unit wider than the space available still gets a system of its own; this can only happen at absurdly small widths, and the width is then exceeded rather than the note split.
- **Empty notes:** one system whose six lines are `x|----|` (leading dash plus the three trailing ones), with no cells or bars.
- **`toText(take, notes)`:**
  - Header lines: `TabCreator — <title>`, then `Tuning: E A D G B E (standard)`, then `Recorded: <YYYY-MM-DD HH:mm>` from `take.createdAt` in local time, then a blank line.
  - Then `layoutTab(notes, 80, take.countInBpm)` systems, separated by one blank line, with `\n` line endings and a trailing newline.
- **Golden sample:** the tab-format.md sample, as 15 notes 125 ms apart, renders exactly as shown there. Each line is 37 characters: 34 between the `|`s. The ticket's "at 34 characters" is that inner width, because rendering at `widthChars` 34 would have to wrap. The test renders it at any width ≥ 37 and compares all six lines.

**Never:**
- No UI, no DOM, no storage access.
- No trimming logic: times are take time, untrimmed, so bar lines never move with a trim.
- No note durations in the output.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Golden | the tab-format.md phrase, 125 ms apart, width 80 | exactly the six sample lines | — |
| Empty | no notes | one system of `x\|----\|` | — |
| Single note | one note | `x\|-<fret>-` + `---\|` | — |
| Two-digit frets | frets 10–24 mixed with 1-digit frets | all six lines equal length; other strings `--` | — |
| Long take | 200 notes at width 80 and at 40 | every line ≤ width; every note in exactly one cell; cells' text matches the fret | — |
| Bars 240 BPM | sample phrase, countInBpm 240 (barMs 1000) | `\|` before the note at 1000 ms | — |
| Bars 120 BPM | notes across 0–6 s | a bar line at each 2.0 s boundary between the right notes; a note at exactly 4000 ms sits after the bar | — |
| Empty bars | a gap spanning two boundaries | two bar lines | — |
| Wrap on a bar | a break falls at a bar line | that `\|` dropped; the next system starts with its note | — |
| No count-in | countInBpm undefined | no bar lines; outputs identical to the goldens | — |
| toText | a take + 200 notes | header, a blank line, systems at 80, blank lines between | — |

</intent-contract>

## Code Map

- **`app/src/model/types.ts`:** `Note` (`id`, `string: StringNo`, `fret`, `startMs` and the other `DetectedNote` fields) and `Take` (`title`, `createdAt`, `countInBpm?`). Read-only.
- **New `app/src/model/tab-render.ts`:** the module. Follow the style of the existing `model/` modules (e.g. `level-warnings.ts`, `input-quality.ts`): a short header comment naming US-6.1 and CAP-12/CAP-24, and doc comments on the exports.
- **New `app/tests/unit/tab-render.test.ts`:** Vitest goldens. Inline expected strings for the small cases. For the 200-note cases use property assertions (width, coverage, cell text) rather than one giant literal; a seeded generator is fine.
- **`app/src/session/README.md` / `model/`:** no other files change.

## Tasks & Acceptance

**Execution:**
- [x] `app/src/model/tab-render.ts`: `layoutTab`, `toText` and the exported `TabLayout` types.
- [x] `app/tests/unit/tab-render.test.ts`: one test per matrix row, plus `toText`'s date format, checked against a fixed local time.

**Acceptance Criteria:**
- Given the matrix rows, when `pnpm test` runs, then each row's test passes, and the golden test compares the exact sample lines from tab-format.md.

## Implementation Notes

## Plan Change Log

## Review Triage Log

### 2026-10-04 — Review pass
- verdicts: 31 findings — high 0, medium 5, low 20, false 6, maybe-false 0
- findings:
  - `low` `patch` (verification-gap) the "last third" bound is untested; deleting it passes every test — patched: a case with a bar in the first two-thirds where the break must fall before the note.
  - `low` `patch` (verification-gap) the trailing-bar pop is untested — patched with the consecutive-bars fix: exact-lines tests for the trailing-bar case.
  - `low` `reject` (blind) the export header's title line can exceed 80 characters — the 80-character rule is for the tab systems; titles are app-generated now, and renaming (epic Library and export) can bound their length.
  - `low` `patch` (blind) a title with CR/LF breaks the fixed header — patched: CR/LF runs become one space, with a test.
  - `false` `reject` (blind) the tuning is hard-coded while Take.tuning could differ — `Take.tuning` is the literal type 'EADGBE'; an invalid createdAt is not reachable (always written by the app as ISO).
  - `low` `reject` (blind) the local-time test cannot tell local from UTC on a UTC runner — it constructs the time from local components and passes under a non-UTC TZ (implementer checked Asia/Kolkata); pinning TZ is test infrastructure beyond a direct fix.
  - `medium` `patch` (blind) consecutive empty bars at a wrap give a system starting with `|-` or ending with a bar — patched: exactly one bar dropped at a break, no system ends with a bar, the rest of the run starts the next system; exact-lines tests for runs of two and three.
  - `low` `patch` (blind) the last-third rule is tested only where it fires — same as the verification-gap finding.
  - `low` `patch` (blind) checkLayout checks neither played order nor bar count — patched: a played-order assertion across systems.
  - `low` `reject` (blind) inputs (fret, widthChars, startMs) are not validated — frets come from the engine and model as integers 0–24, widths and times from the app; guards would add branches for unreachable inputs.
  - `low` `reject` (blind) TabSystem.lines is string[] rather than a six-tuple — always six by construction and tested; a type-only nicety.
  - `low` `reject` (blind) nothing lets the export hide bar lines — hiding bar lines is the Tab screen's view toggle (entry 9); whether export follows it belongs to the export story (epic Library and export).
  - `medium` `patch` (edge) a wrap on a bar followed by another bar starts the next system with `|-` — same root cause as the consecutive-bars finding.
  - `medium` `patch` (edge) only one trailing bar is popped — same root cause.
  - `medium` `patch` (edge) the preferred barAt split can leave a bar before `---|` — same root cause.
  - `low` `reject` (edge) a bar-only system at widthChars 8 — widths that small are outside any real use; the plan accepts over-wide systems there.
  - `low` `reject` (edge) widthChars NaN, negative or below the overhead — callers pass a measured character width; no reachable source of NaN.
  - `low` `patch` (edge) a countInBpm of Infinity loops forever, and huge values emit huge numbers of bars — patched: a countInBpm that is not finite or outside (0, 1000] is treated as no count-in, with a test.
  - `low` `reject` (edge) float drift could put an on-boundary note before its bar at non-integer barMs — measured note times essentially never equal a fractional boundary; the integer-BPM test cases are exact.
  - `low` `reject` (edge) negative, fractional or 3-digit frets break the width contract — same as the blind input-validation finding.
  - `low` `reject` (edge) NaN startMs breaks sorting — same as the blind input-validation finding.
  - `low` `reject` (edge) an unparseable createdAt prints NaN — same as the blind tuning/date finding; not reachable.
  - `low` `patch` (edge) a title with a newline or over ~66 characters — the newline part patched with the blind sanitisation finding; the length part rejected as above.
  - `medium` `patch` (edge) claim: "the next system starts with its note" fails for an empty bar at a wrap — same root cause as the consecutive-bars finding.
  - `low` `reject` (edge) claim: every line is within widthChars, but narrow widths exceed it — the plan states over-wide systems happen only at absurd widths.
  - `false` `reject` (intent) the golden renders at 37/80/200, not at widthChars 34 — US-6.1 counts the prefix in widthChars, so 34 can only be the inner width; the plan records this reading.
  - `low` `patch` (intent) toText for a take without a count-in is untested — patched: a toText case with no countInBpm.
  - `false` `reject` (intent) toText wraps at 80 — aligned (tested).
  - `false` `reject` (intent) the 120 BPM fixture — aligned (exact lines and columns tested).
  - `false` `reject` (intent) the bar-line preference threshold — a choice within what the intent leaves open, recorded in the plan.
  - `false` `reject` (intent) no screen or export wiring — the intent says those use it later.

## Design Notes

**Spacing at a wrap.** US-6.1 doesn't say whether a note's spacing dashes survive a break. Keeping each note together with its spacing makes a unit atomic, so a note never ends up separated from its spacing. This is the reading taken here, and both the screen and export see the same output. Each system still closes with `---|`.

**Preferring bar lines.** "Prefer breaking at a bar line" is bounded to the system's last third, so a system is never left mostly empty just to break on a bar.

## Verification

**Commands:**
- `npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass

## Auto Run Result

**Summary:** added `app/src/model/tab-render.ts`, a pure module with these exports:
- **`layoutTab(notes, widthChars, countInBpm?)`:** returns systems of six lines (e B G D A E), with each note's cells and the bar line columns.
  - US-6.1 spacing; two-digit frets align across the six lines.
  - 4/4 bar lines from the count-in tempo, with take time 0 as bar 1.
  - Wrapping never splits a note and prefers a bar line in the system's last third.
  - Exactly one bar line is dropped at a break, and the rest of a run of empty bars starts the next system.
  - A `countInBpm` that is not finite, or is outside (0, 1000], means no count-in.
- **`toText(take, notes)`:** the export header (line breaks in the title become spaces), then systems at width 80.

**Files:**
- `app/src/model/tab-render.ts` (new).
- `app/tests/unit/tab-render.test.ts` (new): 24 tests.
  - The golden sample matches exactly.
  - Two-digit frets align, and bar placement at 120 and 240 BPM is exact.
  - Exact-lines tests cover empty bars, wraps on bar lines and runs of bars at a break.
  - 200-note checks at widths 80 and 40: line width, played order and every note in one cell.
  - `toText`, with and without a count-in.

**Review:** thorough (4 lenses), 31 findings.
- **Patched:**
  - medium (1 entry): bar lines in a run of empty bars at a break.
  - low: the infinite loop on an out-of-range `countInBpm`, line breaks in the title, and tests for the last-third bound, the trailing bar, `toText` without a count-in and played order.
- **Deferred:** none.
- **Rejected:** with reasons in the triage log, mainly validation of inputs no caller can produce, and choices US-6.1 leaves open.

**Follow-up review:** not recommended. One medium entry was patched, and its tests pin the exact lines.

**Verification:** lint, typecheck, format:check and test pass (847).

**Residual risks:**
- **Wrap behaviour is this plan's choice:** the readings US-6.1 leaves open (spacing kept at a wrap, the last-third preference, the leftover bars of a run at a break) are decisions made here, and the Tab screen and export will both inherit them.
- **The golden width is a reading:** "renders exactly at 34 characters" is read as the sample's width between its `|` characters, because the full lines are 37 characters.
