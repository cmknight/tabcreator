---
title: 'Announcements and the Tab toolbar'
type: 'feature'
ticket: '11'
created: '2026-10-07'
status: done
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '4d5563f15f2abc23c445ad8e59427dbdef5a4705'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** These are the Recording retro's A4/DS10 items plus the epic notes (CAP-21, CAP-25, AD-18).

- **Tab toolbar keyboard:** the toolbar declares `role="toolbar"` but has no arrow-key navigation, and every button is its own Tab stop.
- **Tab screen silence:** neither the first analysis finishing nor "Take not found" is announced.
- **Polite queue:** it has no cap or expiry, and it stalls in a hidden tab because every message waits for `requestAnimationFrame`.
- **Assertive region:** it is latest-wins, so a count-in beat overwrites an error.
- **Off-Record stops:** a storage-full or failed-save stop on Tuner or Library is announced only as a polite "Recording stopped".

**Approach:**
- Roving tabindex on the toolbar.
- Two Tab-screen announcements.
- Announcer changes: a cap, expiry, a hidden-tab path, and a minor assertive kind that yields to errors.
- One shell announcer that owns the storage-full and failure-stop notices on every screen.

## Boundaries & Constraints

**Always:**
- **Toolbar** (`Tab.tsx` `role="toolbar"`, the ARIA toolbar pattern):
  - Exactly one enabled button has `tabIndex=0`; the others have `-1`.
  - ←/→ move focus to the previous/next enabled button, wrapping. Home/End go to the first/last.
  - Focus or a click on a button makes it the stop.
  - When the stop becomes disabled or unmounts, the stop moves to the nearest enabled button, so the toolbar always keeps one Tab stop while any button is enabled.
  - The existing Undo/Redo travel-focus hand-off and the Esc return to the Trim and Analysis-settings toggles keep working.
  - The registry already leaves ←/→/Esc to the toolbar (`inToolbar`). Do not add a keyboard listener outside the toolbar's own `onKeyDown` (component-owned, like TabArea's roving).
  - The play/speed controls and the note list toggle stay outside the toolbar, unchanged.
- **Tab screen announcements** (polite, through `announce`):
  - When the first analysis finishes (running → idle with a tab), announce "Analysis done — N notes", or the no-notes text when there are 0. Re-analysis keeps its existing `tab.reanalysed`; no second message.
  - When the snapshot becomes `missing` (load or deletion), announce "Take not found" once.
- **Announcer** (`ui/a11y/announcer.ts`):
  - **Polite queue:** cap `ANNOUNCE_QUEUE_MAX = 5` (dropping the oldest), expiry `ANNOUNCE_EXPIRY_MS = 10_000` (a queued message older than that when its turn comes is dropped). Both exported.
  - **Hidden tab** (`document.hidden`): both regions skip rAF and fill through a timer, so the queue drains while hidden. Visible behaviour is unchanged (the clear is committed, then the fill on the next frame).
  - **Minor assertive messages:** `announce(msg, 'assertive', { minor: true })`. A minor message is dropped while a non-minor assertive message is pending, or was shown within `ASSERTIVE_HOLD_MS = 2_000`. A non-minor assertive message always replaces a minor one. Count-in beats use `minor`.
  - Existing callers' signatures are unchanged.
- **The shell's stop and storage announcer** (new component in `ui/components/`, mounted in `Shell`):
  - It reads `recordingSession` (which mirrors `storage/persistence.ts`'s storage-full source; `ui/` must not import `storage/`).
  - It announces assertively, once per event, on any screen:
    - a storage-full stop that saved: `record.storageFull`;
    - a failed save (`save-failed` notice): `record.saveFailed`;
    - storage becoming full outside a stop: `global.storageFull`.
  - It is now the single owner of these announcements:
    - Record's `StorageFullBanner` and the Library's storage-full announce (`Library.tsx:695-701`) stop announcing; their banners stay visible.
    - The `save-failed` toast becomes `silent`, so it isn't announced twice.
  - RecordingAnnouncer's polite "Recording stopped" stays.
- All strings go in `ui/strings.ts`, and the layer rules still hold.

**Never:**
- No new `aria-live` region, and no `aria-live` outside `ui/a11y`.
- No change to toolbar order, labels or button behaviour.
- No change to the edit, re-fit or progress announcements.
- No session or storage logic change, apart from reading what the snapshots already expose. If a needed fact isn't exposed, add the smallest read-only field to the session.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Toolbar Tab stop | Tab into the toolbar, then Tab again | one stop: the toolbar is entered once, and the next Tab leaves it | none |
| Arrows | → from Undo (Redo disabled) | skips disabled buttons; wraps from the last to the first; Home/End | none |
| Stop disabled | the stop is Undo; the undo stack empties | the stop moves to an enabled button; travel focus is unchanged | none |
| Analysis done | first analysis finishes with 12 notes | polite "Analysis done — 12 notes" | none |
| Not found | `#/tab/unknown` | polite "Take not found" | none |
| Queue cap | 8 polite messages in one burst | only the last 5 are spoken, in order | none |
| Expiry | a message queued > 10 s before its turn | dropped | none |
| Hidden tab | `document.hidden`, 2 polite messages | both reach the region without rAF | none |
| Beat vs error | an error, then a beat within 2 s; a beat, then an error | the error stays; the error replaces the beat | none |
| Stop on Tuner | recording, go to Tuner, storage fills | assertive `record.storageFull` | none |
| No double | the same stop while on Record | announced once (the shell); the banner is still shown | none |

</intent-contract>

## Code Map

- **`app/src/ui/a11y/announcer.ts`:**
  - `announce` :23-25, `ANNOUNCE_GAP_MS` :13;
  - `fill` :38-41 (flushSync clear, then set);
  - the polite queue `next()` :44-74 (rAF, then a 500 ms timer);
  - assertive :76-81 (latest wins, rAF);
  - unmount :84-90.
  - Tests: `tests/unit/announcer.test.ts` (fake timers, `vi.advanceTimersToNextFrame`, a `texts()` helper).
- **Count-in beats:** `ui/components/RecordButton.tsx:14-36` `useCountInBeat`; the assertive call is at :25.
- **Assertive storage-full and stop announcers today:**
  - `ui/components/StorageFullBanner.tsx:16-38` (Record only);
  - `Library.tsx:695-701`;
  - `MicNotices.tsx` (save-failed toast);
  - `RecordingAnnouncer.tsx` (polite "Recording stopped" on `savedSeq`);
  - `MicErrorAnnouncer.tsx` (mic-lost; already shell-wide).
- **Recording snapshot:** `storageFull`, `storageFullSaved`, `savedSeq`, `notice` (`session/recording-types.ts:24-87`). The storage-full stop is in `take-lifecycle.ts` `finishTake` :790-862.
- **Strings:** `record.storageFull` :193, `record.saveFailed` :198, `global.storageFull` :126, `tab.notFound` :299, `tab.noNotes` :276, `tab.reanalysed`, `tab.analysingAnnounce` :266.
- **Tab screen (`ui/screens/Tab.tsx`):**
  - `useProgressAnnouncements` :162-175;
  - missing body :790-791;
  - `showToolbar` :749;
  - toolbar :956-1070 (Undo, Redo, Insert, Delete, Copy, Download, Trim, Bar lines (raw `<button>`), Analysis settings);
  - `ToolButton` :258-308 (native `disabled`; `buttonRef`, `onFocus`/`onBlur`);
  - travel focus :742-787;
  - Esc returns :1078-1082, :1094-1097.
  - `session/take-session.ts` analysis states :123-130; the first-analysis completion is in `follow()` :580-612.
  - Roving precedent: `TabArea.tsx` (`tabStop`, :251, :519).
- **Shell:** `App.tsx` `Shell` mounts the hosts after `main`.
- **Tests:**
  - Unit:
    - `tests/unit/tab-screen.test.tsx` (mocks `announce`; toolbar order :1061-1089);
    - `storage-full-and-notices.test.tsx`;
    - `shortcuts.test.ts` (toolbar-owned keys).
  - e2e:
    - `tab-helpers.ts` `openSeededTab`; `helpers.ts` `politeRegion`;
    - `input-quality.dev.spec.ts:174-188` (the page-side `__politeLog` pattern);
    - `src/dev/hooks/analysis.ts` (`?slowAnalysis`, `?holdAnalysis`);
    - `src/dev/hooks/storage-full.ts` `window.__storageFullHook`;
    - `storage-states.dev.spec.ts:250-290` and `record.dev.spec.ts:660-760` (storage-full during a take);
    - `library-helpers.ts` `nav`.
  - Specs that Tab through the Tab screen and may need updating: `tab-screen.dev.spec.ts:279`, `shell-a11y.dev.spec.ts:179`, `tab-edit.dev.spec.ts:428`, `reanalyse.dev.spec.ts:214-217`.

## Tasks & Acceptance

**Execution:**
- [x] `app/src/ui/a11y/announcer.ts` -- the cap, expiry, the hidden-tab timer path, and minor assertive messages -- the retro DS10 queue and priority.
- [x] `app/src/ui/components/RecordButton.tsx` -- beats are `minor`.
- [x] `app/src/ui/components/StorageNoticeAnnouncer.tsx` (new), `App.tsx` -- the shell owner of the storage-full and failure-stop announcements. `StorageFullBanner.tsx`, `Library.tsx` and `MicNotices.tsx` stop announcing them -- single owner.
- [x] `app/src/ui/screens/Tab.tsx`, `ui/strings.ts` -- toolbar roving tabindex; the analysis-done and not-found announcements.
- [x] Unit tests:
  - `announcer.test.ts`: cap, expiry, the hidden drain (stub `document.hidden`; no frame advance), minor vs error both ways.
  - `tab-screen.test.tsx`: roving (one `tabIndex=0`, arrows, Home/End, wrap, skipping disabled, the stop moving on disable); the two announcements.
  - The new announcer's test: each event once; nothing on mount.
  - Update the banner, Library and MicNotices tests for the moved announcements.
- [x] `app/tests/e2e/announcements.dev.spec.ts` (new) -- toolbar one Tab stop and arrows, analysis done, not found, the storage-full stop while on the Tuner (assertive text), and no double announcement on Record. Update the existing specs that Tab through the toolbar.

**Acceptance Criteria:**
- Given the Tab screen, when a keyboard user tabs, then the toolbar is one Tab stop and the arrows move across its enabled buttons.
- Given a recording that stops because storage filled while the player is on any screen, when the stop is saved, then a screen reader hears the storage-full stop exactly once.
- Given an error during a count-in, when the next beats tick, then the error is not overwritten.
- Given the full verification, when it runs, then it exits 0.

## Implementation Notes

- **Announcer:** the polite message is taken from the queue when its frame (or hidden-tab timer) runs, not when the clear is scheduled, so a burst is capped as a whole (8 → the last 5). Expiry is checked at that moment with `performance.now()`. The hidden path is a `setTimeout(0)` in place of rAF, for both regions. A frame already scheduled when the page hides moves to that timer path on `visibilitychange`.
- **Minor assertive:** `announce(msg, 'assertive', { minor: true })`; the hold (6 s: a whole count-in at 40 BPM) is measured from when the non-minor message fills the region.
- **Duplicates:** an assertive text equal to the pending one, or shown within `ASSERTIVE_REPEAT_MS` (1 s), is dropped. The window is not `ASSERTIVE_HOLD_MS`, because 6 s broke `mic-errors.dev.spec.ts` "the same failure twice is announced twice". `{ repeat: true }` marks a genuine new event; `MicErrorAnnouncer` uses it.
- **StorageNoticeAnnouncer:** a storage-full stop is detected from the new read-only `lastStopReason`, set with `savedSeq`, not from the `storageFull` flag. Storage filling during a take says nothing at that moment; the stop speaks for it (`record.storageFull` or `record.saveFailed`). An emit that announced a stop never also says `global.storageFull`. A take that ends with neither (a too-short storage-full stop) gets `global.storageFull` when it goes idle. Nothing is announced on mount. The Record and Library banners keep their own announce-once-per-showing, and the announcer absorbs the same text arriving at the same moment.
- **Toolbar:** the stop is held as a tool key (`data-tool`). When its button is disabled or unmounted, the stop moves to the nearest enabled button (after it first, then before it) and stays there. Focus and click are handled by the toolbar's own `onFocus`/`onClick`, and the keys by its `onKeyDown`. Of the existing e2e specs, `tab-screen.dev.spec.ts` (its toolbar-focus probe is now a real button) and `record.dev.spec.ts` (it waits out the repeat window before the Library round trip) were updated. The `?` dialog lists the toolbar's keys through listing-only registry entries.

## Plan Change Log

## Review Triage Log

### 2026-10-07 — Review pass
- verdicts: 34 findings — high 0, medium 5, low 23, false 6, maybe-false 0
- findings:
  - `medium` `patch` (edge) a frame scheduled before the tab hides never runs, so both regions stall — `visibilitychange` reschedules pending work through timers.
  - `medium` `patch` (blind) same — same fix.
  - `low` `patch` (intent) same, the hidden-mid-message reading — same fix.
  - `medium` `patch` (edge) a storage-full stop goes unannounced when storage is freed before the save lands — announced from the stop reason (a read-only snapshot field), not the current flag.
  - `low` `patch` (edge, claim) same — same.
  - `low` `patch` (blind) same — same.
  - `medium` `patch` (edge) the stop and a full flip in one emit announce `global.storageFull` over the stop message — no shared message in the same emit.
  - `low` `patch` (edge) same, for a failed save — same.
  - `medium` `patch` (verification) the Tab screen's storage-full banners still announce alongside the shell — the announcer drops identical assertive text within the hold; the banners keep announcing once per showing.
  - `low` `patch` (intent) reaching the Library with storage already full is silent, a regression from story 7.1 — Library and Record banner announcements restored, deduplicated by the announcer.
  - `low` `patch` (blind) throttled hidden-tab timers let messages expire rather than drain — documented as intended (stale messages dropped).
  - `low` `patch` (blind) `Date.now()` can jump — `performance.now()`.
  - `low` `patch` (edge, claim) a 2 s hold lets a later beat replace an error at 40 BPM — hold raised to 6 s, a whole count-in at the slowest tempo.
  - `low` `patch` (verification) beats sent as `minor` are untested at the caller — RecordButton unit test.
  - `low` `patch` (blind) same — same.
  - `low` `patch` (intent) priority tested only at the API — same.
  - `low` `patch` (edge) a pending "analysis done" survives an analysis that ends without a tab — cleared.
  - `false` `reject` (edge) an arrow on a button that just became disabled — a disabled button loses focus to body, so the keydown never reaches the toolbar.
  - `low` `patch` (blind) the toolbar order is defined twice (`TOOLS` and the DOM) — one order or a test tying them.
  - `low` `patch` (verification) Bar lines' place in the roving stop is untested — count-in take unit tests.
  - `low` `patch` (blind) the toolbar arrows are missing from the `?` dialog — listing-only entries.
  - `low` `patch` (blind) the e2e claims Tab out and back without checking; stop-on-removal and Esc returns untested — checked.
  - `low` `patch` (blind) no e2e for a failed save off Record — added.
  - `low` `reject` (blind) no e2e for storage filling outside a take on the Library — covered by the restored Library announce e2e (item 3) and the shell unit tests.
  - `low` `patch` (blind) hard-coded "Analysis done" prefix and a NaN on zero notes — derived from strings; zero handled.
  - `low` `reject` (blind) fixed negative waits — kept short; there is no event to await for "nothing more announced".
  - `low` `patch` (blind) Library header width and an orphan comment — fixed.
  - `low` `reject` (intent) "failure-stop" could cover mic-lost and instance-lost — mic-lost is already shell-wide (MicErrorAnnouncer, the stopped-saved toast); instance-lost has its own screen; max-length is not a failure.
  - `low` `reject` (intent) the store should emit the events, not the UI infer them — the plan keeps session logic unchanged; a read-only stop-reason field is the only addition.
  - `false` `reject` (intent) beat priority checked only at the announcer API — duplicate of the caller-test row, patched.
  - `false` `reject` (intent) take-deleted-while-open is unit-only — the unit test covers the transition; e2e covers load.
  - `false` `reject` (intent) the plan-listed Tab-through specs were not touched — they pass unchanged in the full run.
  - `false` `reject` (intent) the hidden-drain unit test stubs hidden before announcing — duplicate of the hidden-mid-message row, patched.
  - `false` `reject` (intent) re-analysis done not newly announced — `tab.reanalysed` already announces it.

## Design Notes

These choices are made here and recorded:
- **The numbers:** a cap of 5, a 10 s expiry and a 6 s assertive hold, which covers a whole count-in at the slowest tempo (4 beats at 40 BPM). A later error still replaces it.
- **Analysis done:** it reuses the note count the status line shows.
- **Owners and duplicates:** the shell announces the stop and failed-save events on any screen, which fixes off-Record silence. The screen banners keep announcing once per showing. The announcer drops the same assertive text arriving in the same moment, so there is no double announcement (DM3, part of A4's reshaping).

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && pnpm --filter app size:check && TABCREATOR_E2E_BUILD=B pnpm --filter app exec vite build && CI=1 pnpm e2e && pnpm --filter app benchmark'` (repo root, `~/.cargo/bin` on PATH) -- expected: all exit 0.

## Auto Run Result

- **Summary:**
  - **Tab toolbar:** roving tabindex. One enabled button is the Tab stop; ←/→ wrap across enabled buttons and Home/End go to the ends. The stop follows focus or a click, and moves when its button is disabled or removed. The order is tested against `TOOLS`. The keys are listed in the `?` dialog.
  - **Tab screen announcements:** "Analysis done — N notes" (or "No notes found") when the first analysis ends, and "Take not found".
  - **Announcer:**
    - the polite queue is capped at 5 and expires messages after 10 s (`performance.now()`);
    - a hidden tab drains through timers, including frames already pending when the tab hides (`visibilitychange`);
    - count-in beats are `minor` and yield to an error for 6 s;
    - an identical assertive text within 1 s is dropped unless the caller marks it a new event (`repeat`, used by mic errors).
  - **Shell `StorageNoticeAnnouncer`:** announces on any screen:
    - a storage-full stop, from the new read-only `lastStopReason`;
    - a failed save (the toast is silent);
    - storage becoming full.
    
    The screen banners keep announcing once per showing, and the announcer absorbs same-moment duplicates.
- **Files changed:**
  - **Session:** `app/src/session/{recording-session,recording-types,take-lifecycle}.ts` (`lastStopReason`).
  - **UI:** `ui/a11y/{announcer,shortcuts}.ts`, `ui/components/{StorageNoticeAnnouncer (new),RecordButton,MicErrorAnnouncer,MicNotices,StorageFullBanner}.tsx`, `ui/screens/{Tab,Library}.tsx`, `ui/strings.ts`, `App.tsx`.
  - **Tests:**
    - unit `announcer`, `shortcuts`, `storage-full-and-notices`, `tab-screen`, `record-button` (new);
    - e2e `announcements.dev.spec.ts` (new), `record.dev.spec.ts`, `tab-screen.dev.spec.ts`.
- **Review:** 34 findings (medium 5, low 23, false 6).
  - Patched:
    - the hidden-tab stall mid-message;
    - the storage-full stop from its reason;
    - same-emit precedence;
    - duplicate handling instead of a single owner, which restores story 7.1's Library announcement;
    - the 6 s beat hold and the caller test;
    - `performance.now()`;
    - the stale analysis-done flag;
    - toolbar order and Bar lines coverage;
    - toolbar keys in the `?` dialog;
    - the failed-save e2e;
    - strings-derived matches.
  - Rejected rows carry their reasons in the triage log.
- **Plan deviation:** the duplicate window is 1 s with an explicit `repeat` option, not the 6 s hold. A 6 s window swallowed a legitimately repeated mic failure (`mic-errors.dev.spec.ts`).
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 5, low 18.
- **Verification:** the full plan command exited 0: 2137 unit; 276 e2e, 1 flaky that passed on retry (the tuner chip timing, unrelated); size and benchmark gates pass.
- **Residual risks:**
  - In a long-hidden tab the throttled timers let older messages expire rather than play (intended).
  - The stop events are still inferred in the UI from snapshot changes, with only `lastStopReason` added to the session.
