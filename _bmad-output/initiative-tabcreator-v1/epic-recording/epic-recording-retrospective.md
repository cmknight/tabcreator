---
epic: epic-recording
date: 2026-10-03
verdict: accepted-with-open-items
criteria: declared
headless: false
---

# Retrospective: Recording (epic 3)

## Epic summary

- **Epic:** `epic-recording` (id 3), file `epic-recording.md`. It has a declared Done when (4 criteria). The epic file's status is still `in-progress`; closing it is the ticketing skill's job, confirmed by the user.
- **Retro choices:** the user picked this epic interactively and asked for no particular focus.
- **Tickets:** all 12 are `done`. `pending_tickets` is empty, and no ticket is left at `built`.

| Ref | Title | Status | Range (baseline → next baseline) | Non-ticket commits |
|-----|-------|--------|-------|-------------------|
| 3.1 | Split the recording store | done | a0c5340..343612b | refactor (3.1); chore: gitignore personal Claude Code settings |
| 3.2 | Serialise mic input transitions | done | 343612b..1da379c | fix (3.2) |
| 3.3 | Queue announcements | done | 1da379c..ade1f4e | fix (3.3) |
| 3.4 | Record and stop a take (tracer) | done | ade1f4e..378b8e6 | feat (3.4) |
| 3.5 | Space to record and the production test lane | done | 378b8e6..0937390 | feat (3.5), fix (3.5 review) |
| 3.6 | Count-in | done | 0937390..4308e80 | feat (3.6) |
| 3.7 | Length cap, short takes and recording announcements | done | 4308e80..c63a4a2 | feat (3.7) |
| 3.8 | Recording-time mic touch points | done | c63a4a2..79c0e47 | feat (3.8) |
| 3.9 | Failure stops keep the take | done | 79c0e47..04d69d1 | feat (3.9) |
| 3.10 | One tab at a time | done | 04d69d1..0e5d05f | feat (3.10) |
| 3.11 | Recover an unfinished take | done | 0e5d05f..b0db361 | feat (3.11) |
| 3.12 | Refactor sweep | done | b0db361..97e143a (inferred: HEAD) | refactor (3.12), docs (3.12) |

- **Evidence inventory:**
  - **Available:**
    - the epic file;
    - initiative Requirements and SPEC CAPs;
    - 12 plans, each with a baseline, a Review Triage Log, Verification and an Auto Run Result;
    - `git_evidence.py` output for each range;
    - the full epic diff `a0c5340..HEAD -- app` (114 files, +10,642 / −658, no merges);
    - the previous retro (`epic-mic-and-tuner-retrospective.md`);
    - session transcript `146cfd82-….jsonl`, which covers 3.1–3.12 with earlier portions summarized.
  - **Missing:** story files (no entry was refined).

## Findings

How each view was derived:
- **Deterministic:** an import-graph script over `git archive` trees at a0c5340 and HEAD (Tarjan's algorithm for cycles), `git_evidence.py` churn, `wc`, `eslint`, and grep for browser-API ownership.
- **Inline judgment:** what counts as duplication and as pattern divergence.
- **Diff-scope review:** `bmad-review` with three lenses (adversarial, edge-case, verification-gap) over `epic.diff`, weighted toward the seams between stories.

Each finding was re-checked against the file before routing. Line refs are as of HEAD `97e143a`.

### Aggregate views

**Architecture delta**
- **AV1.** `app/src` grew from 46 to 62 modules. Every new edge follows the layer rules, and ESLint is clean.
  - The only new cycle is `ui/strings.ts:2` ↔ `ui/format.ts:3`, introduced by 00a571b (3.12).
  - *Accept as-is*: both sides call each other only inside functions. *Defer* untangling it to the next sweep.
- **AV2.** Each browser API family has a single owner, as AD-2 requires.
  - `beforeunload` has no owner named in AD-2; it is wired by the recording-session composition root (`recording-session.ts:1430-1433`).
  - Session code also reaches `window.location` directly: the hash navigation at `:1434-1437` duplicates the router's format; `instance-lock.ts:317,334` calls `location.reload()`, while AD-16 routes reloads through `app-reload.ts`.
  - *Spec reconciliation* (A6).
- **AV3.** AD-6's handover order omits "flush all stores" (`instance-lock.ts:164-176`; spine :105), and AD-16's `pagehide`/`flushAll` does not exist (`app-reload.ts:1-3`).
  - The 3.10 plan scoped this out (:83).
  - *Spec reconciliation*, or a Tab-epic story once take-session has state to flush.

**Duplication map**
- **DM1.** The stop/save pipeline is written twice: `finishTake` (`recording-session.ts:1235-1298`) and recovery's `rebuild` (`recording-recovery.ts:183-225`).
  - The 500 ms minimum is defined twice: `MIN_TAKE_MS` (`:130`) and `MIN_RECOVERED_MS` (`recording-recovery.ts:20`).
  - Clip detection is done twice: worklet counting vs `anyClipped` (`recording-recovery.ts:92-97`).
  - *Fix now* (A3).
- **DM2.** The MediaRecorder graph is set up twice (`recorder.ts:188-200`, `encode.ts:51-62`). "Resume the context within a timeout" has three copies (`recorder.ts:88-100`, `encode.ts:36-41`, `dev/fake-mic.ts:160-170`). There are three small "attempt"/"quietly" helpers.
  - *Defer* to the next sweep.
- **DM3.** There are four announce-once patterns in the banners and announcers (`RecoveredTakeBanner.tsx:12`, `InputQualityBanner.tsx:24`, `StorageFullBanner.tsx:22`, `RecordingAnnouncer.tsx:13-23`, `MicNotices.tsx:15-19`).
  - *Defer* (A4 reshapes announcements).
- **DM4.** In e2e:
  - six in-page IndexedDB readers (`record.dev.spec.ts:60,298,697`, `recovery.dev.spec.ts:42`, `instance.dev.spec.ts:19`, `record.prod.spec.ts`);
  - `opfsFiles` twice;
  - `recordButton`/`timer` locators in four specs.

  In unit tests, `setup`/`deferred`/`flush` are each defined twice. The 3.12 sweep took only the items it was given.
  - *Defer* to the next sweep.

**God-class and size growth**
- **GC1.** `session/recording-session.ts` grew from 489 lines (a0c5340) to 1444, across ten stories:
  - +278 take capture (3.4)
  - +274 count-in (3.6)
  - +135 cap (3.7)
  - +108 recovery and the unload guard (3.11)

  One closure, `createRecordingSession` (`:443-1392`), holds about 45 inner functions and roughly nine documented responsibilities. Several diff-scope findings (DS5–DS7) sit on its internal seams.
  - `recording-take.test.ts` is now 1663 lines and `record.dev.spec.ts` 876.
  - *Fix now*: extract the take lifecycle (A3).

**Pattern divergence**
- **PD1.** `audio/encode.ts` throws plain `Error` (`:28,44,68,73,95`) where `recorder.ts` uses `AppError` codes for the same conditions (`recorder.ts:164`, AD-10). *Fix now* (A3).
- **PD2.** Dev-only hooks still live in production modules:
  - `__storageFullHook` (`storage/audio-store.ts:77-82,241`)
  - `__recordingClock` (`recording-session.ts:151-163`)
  - `readDevLimits` (`:1394`)

  All are DEV-gated. The 3.12 `dev/` layer moved only the fake mic. *Defer* to the next sweep.
- **PD3.** New module CSS adds raw px where `--space-*` tokens exist (`RecordButton.module.css:14` gap 6px, `CountInControls.module.css:20` 84px). *Deferred* in the 3.12 frontmatter.
- **PD4.** Session code uses injected timers unevenly: instance-lock injects `setTimeout`, recording-session uses the global one (`:872,1170`). *Accept*.

### Spec-to-implementation reconciliation

- **SR1, Done when 1.** The production-lane tests meet it:
  - start latency 57–64 ms (`record.prod.spec.ts:50-85`);
  - a 5-minute take saves as `max-length` with ≤ 5 MiB (`:89-139`).

  Gaps:
  - stop latency is never measured;
  - "≤ 5 MB" is tested as 5 MiB;
  - "deployed build" is `vite preview` of `dist/`, not the Pages subpath.

  *Fix now* (A5, tests).
- **SR2, Done when 2.** Met on the dev lane (`recovery.dev.spec.ts:88-131`).
  - "Open like normal ones" reaches only the placeholder `Tab.tsx`; analysis belongs to the Tab epic (Decision, epic :52).
  - The WAV fallback has never run in a browser (3.11 plan residuals).
  - *Accept*; *defer* to the Tab epic.
- **SR3, Done when 3.** Met: capture opens at click + 2.015 s, inside the test's ±20 ms (`record.dev.spec.ts:415-442`). The 15 ms lead is from 3.6's review. Speaker bleed is untestable with the fake mic. *Accept*.
- **SR4, Done when 4.** Met as reinterpreted: the take is saved `instance-lost` (Decision, epic :62; `instance.dev.spec.ts:148-190`). A backgrounded holder is untested. *Accept*; owner hardware check.
- **SR5.** Ticket 5's Verify asks for "Space in a text field does nothing" on the production lane. As built, the check is dev-only and uses a `<select>` (`record.dev.spec.ts:388-396`); inputs are covered by unit tests only. *Fix now* (A5).
- **SR6.** Decision line epic :58 says WAV "is no stored-shape change", but 3.11 added a no-op v3 migration under AD-11 (`storage/migrations.ts:40-42`). *Spec reconciliation*: amend the Decision line.
- **SR7.** US-1.2:293 says a mic-lost take is "saved and analysed". As built, it is saved without navigating or analysing (AD-15). *Spec reconciliation*.
- **SR8.** EXPERIENCE.md:113 lists the storage-full banner only on Tab and Library; as built it shows on Record (Decision, epic :50). *Spec reconciliation*.
- **SR9.** The spine is stale in four places:
  - The state diagram (:288) omits `storage-full`.
  - The structural seed (:322) omits `recording-recovery`, the four watch/derivation modules and `audio/encode.ts`.
  - AD-15 doesn't state the 3.5 s scan delay.
  - AD-18 still says "single live region" and "stores emit"; as built there are two regions and UI-derived announcements.

  *Spec reconciliation*.
- **SR10.** The epic file's `covers` omits CAP-2 and CAP-26 (covered by tickets 8 and 9), and its References omit AD-11 and AD-18. *Spec reconciliation*.

### Diff-scope review (bmad-review: adversarial, edge-case, verification-gap)

Lens overlap is noted in brackets.

- **DS1. Data loss.** A raw append failure other than `storage-full` is swallowed and stops counting samples (`recording-session.ts:898-910`). A long take whose writes failed then measures under 500 ms and is deleted as "too short" (`:1244-1262`), although MediaRecorder's `parts` hold the full audio. [adversarial; 3.9 residual] *Fix now* (A1).
- **DS2. Duration mismatch.** After `storage-full`, raw stops but MediaRecorder keeps recording, so `durationMs` and `clipped` (counted per captured chunk, `:893`) describe less audio than the compressed copy. Recovery derives `clipped` from raw instead. [adversarial, edge-case] *Fix now* (A1).
- **DS3. Failed saves are misreported.**
  - When the save after a storage-full stop also fails, the banner still says "Storage is full — recording stopped and saved" (`:1281-1285`); the same happens for a too-short take (`:1257-1260`).
  - A user or max-length save that fails closes the live mic and shows a mic-failed card (`failRecording`, `:1287`).
  - A `storage-full` from createTake, openRawWriter or writeCompressed takes the same mic-failed path.
  - A failed failure-stop save gets only the `switched` toast.
  - No path re-offers the take in the same session, because the scan runs once per grant.

  [all three lenses; 3.9 and 3.11 residuals] *Fix now* (A1).
- **DS4. Recovery acts on a saved take.**
  - Discard deletes without re-reading the take's status (`recording-recovery.ts:246-256`).
  - The scan tests this tab's `activeTakeId` only after `listTakes` (`:145`), so a take saved in between can be offered, and Discard would then delete a recorded take.

  [edge-case, verification-gap] *Fix now* (A1).
- **DS5. Stop ignored while starting.** Stop is silently dropped while `recording === 'starting'` (`:1220`), so a quick Space-Space leaves a take running. [adversarial] *Fix now* (A1).
- **DS6. Queued-stop races.**
  - An `ended` already queued before Stop or the cap saves the take as `mic-lost` with no navigation (`:797-806`, `:875-881`).
  - A user or cap stop finishing after a handover still navigates (`:1296`).
  - A too-short mic-lost stop's notice is replaced at once by `switched` (`:835-841`).

  [adversarial, edge-case] *Fix now* (A1).
- **DS7. Busy guards disagree.**
  - `app-reload.ts:15` checks only `recording !== 'idle'`, while the unload guard also covers a recovery rebuild (`:504-512`).
  - After a handover whose save outlives the deadline, the guard stays armed on the instance notice.
  - Settings Reload is refused silently (3.7 residual).

  [adversarial, edge-case] *Fix now* (A1).
- **DS8. Handover completion is inferred from a timer.**
  - The recovery scan's 3.5 s delay (`instance-lock.ts:28-40`) assumes a background tab meets wall-clock deadlines.
  - `writeCompressed` checks the fence only on entry, then removes other formats (`audio-store.ts:173-204`).
  - A recovery rebuild in progress is never cancelled on handover.
  - The app-wide `onHeld` wiring is untested; the e2e test's cooperative path passes with no delay at all (`recovery.dev.spec.ts:163`).

  [all three lenses; 3.10 and 3.11 residuals] *Fix now* (A2).
- **DS9. Upgrade-blocked during a take.** A `blocked` database open while a take runs unmounts the shell (`App.tsx:72-74`, `instance-lock.ts:214-215`), leaving capture running with no Stop control. [edge-case] *Fix now* (A2).
- **DS10. Failure stops off Record.**
  - A storage-full or failed stop on Tuner or Library is announced only as a polite "Recording stopped", or not at all.
  - Assertive count-in beats replace a same-frame error (latest wins, `RecordButton.tsx:11-35`).
  - The polite queue stalls in a hidden tab (rAF, `announcer.ts:216-233`).

  [adversarial, edge-case] *Fix now* (A4).
- **DS11. Esc cancel.** Esc does not cancel a count-in while focus is in a text field or select (`shortcuts.ts:59-65,126-135`). [adversarial] *Fix now* (A4).
- **DS12. Recovery UX.**
  - Open navigates to the Tab minutes later, from wherever the user is (`recording-recovery.ts:197-199`).
  - Banners appear 3.5 s after load above the h1 and push Record down; Discard has no confirmation.

  [adversarial] *Defer* (UX decision: Open/Discard is per the mockup).
- **DS13. Structure.** The take lifecycle is the seam behind DS5–DS7 (GC1). [adversarial] *Fix now* (A3).

**Behavior verification** (see the next section) found no defect beyond those above.

## Behavior verification

Every flow was exercised in headless Chromium against a dev server on port 5191 and a `vite preview` of a scratch production build on port 4191. Scripts and logs are in the session scratchpad (`retro3/behavior/`). No console errors were logged.

1. **Space record and stop (dev).**
   - Stop appeared within 80 ms of Space, and the second Space opened `#/tab/<id>` 57 ms later.
   - The take saved `recorded`/`user` with 4090 ms; the webm decodes to 4.02 s.
2. **Count-in at 120 BPM.**
   - Beats were shown and announced (assertive) at 44, 558, 1058 and 1558 ms; "Recording started" came at 2078 ms.
   - The app clock put capture at click + 2.015 s. `countInBpm` 120 persisted.
3. **Cap** (`maxTakeMs=6000`).
   - The near-limit warning showed at 0:03, worded "30 seconds left" because the copy is fixed (dev override only).
   - The take auto-stopped as `max-length` at exactly 6000 ms and opened its Tab.
4. **Two tabs.**
   - The second tab showed the notice; Use here at 0:03 handed over in 112 ms.
   - The first tab's take saved `instance-lost` (3759 ms, decodes 3.72 s).
   - **Observed:** the first tab shows only the notice and gives no sign that its take was saved.
5. **Reload mid-take.**
   - The leave dialog appeared once.
   - The banner appeared about 4.0 s after reload: "An unfinished take from 1:14 pm was recovered (0:08)".
   - Open took 7.3 s (real-time encode) and saved `recovered` with 8000 ms; the webm decodes to 8.10 s and the raw file is kept.
   - Discard removed the take and its raw file and moved focus to the h1.
   - **Observed:** the polite announcer still holds the removed banner's sentence.
6. **Production build with the native fake device.**
   - Space-to-capture took 62 ms; a 5 s take saved.
   - No dev UI: `__fakeMic` and `__recordingClock` are undefined, `#/__test/*` redirects, and `?fakeMic`/`?maxTakeMs` are ignored.

**Also observed:**
- **Sample rate:** every take was at 44.1 kHz (the headless device rate).
- **Decoded length:** decoded lengths differ from `durationMs` by −70 to +100 ms.
- **After a stop:** the Tab page is a bare h1, with focus on BODY.

**Side effect, recorded under Open questions:** during this run the user's own dev server on port 5173 (pid 1552576) stopped.
- The probe's dev server re-optimised the shared `app/node_modules/.vite/deps` at 13:12:41, which may have caused it.
- The probe killed only its own process groups.
- The server was not restarted.

## Previous-retro follow-through

Source: `epic-mic-and-tuner-retrospective.md`, Action items A1–A7. That retro's own follow-through section had no items, because epic 1 had no retro.

**A1 store split** (Dev, with the architect) — landed: 669d45a (3.1).

**A2 queued announcements** (Dev) — landed: ba76f2d (3.3). `ALL_SIX_DELAY_MS` is gone; tested at `input-quality.dev.spec.ts:189`.

**A3 serialised transitions** (Dev) — landed: 6d94cb5 (3.2), with interleaving tests.

**A4 test gaps** (Dev):

| Item | Outcome | Evidence |
|---|---|---|
| live→live reset | landed | `recording-session.test.ts:793` |
| Tuner banner and Dismiss focus | landed | `input-quality.dev.spec.ts:210` |
| "All six" on unmount | landed, now moot | 3.3 removed the unmount path; `tuner.dev.spec.ts:241` |
| `#/tuner` no-prompt | landed | `mic-setup.spec.ts:45` (3.5) |
| production native-device test | landed | `prod-mic` project, `playwright.config.ts:56` (dfa134b) |
| `--repeat-each` check | landed as a one-off | 3.2 plan:170, 90/90; not a CI step |

**A5 sweep** (Dev):

| Item | Outcome | Evidence |
|---|---|---|
| dBFS helper | landed | 00a571b |
| dev-page ternary | landed | 00a571b |
| WarnIcon and banner styles | landed | 00a571b |
| 4096 constant | landed | 00a571b |
| `global.*` mic card keys | landed | 00a571b; the key shape is deferred |
| e2e helpers | landed in part | 00a571b; the live-region probe and getUserMedia instrumentations are deferred |
| scale-label and spacing tokens | not landed | deferred in the 3.12 frontmatter |
| "Microphone 1" fallback | not landed | only the naming moved; `MicNotices.tsx:29` keeps `|| 1` |
| silence vs Too-quiet thresholds | not landed | deferred; comments only |
| `dev/` ESLint layer | landed | 00a571b, 97e143a |

**A6 spec reconciliations** (Architect and UX; product owner for the chip letter). No spec document changed during the epic.

| Item | Outcome | Evidence |
|---|---|---|
| AD-3 | not landed | spine :79 unchanged |
| AD-18 two regions | not landed | spine :207 |
| AD-12 token families | not landed | spine :150 |
| DESIGN.md:242 meter readout | landed before the epic | 8d15e3e |
| US-1.3 fftSize | not landed | US :309 still says 2048 |
| US-1.1 request constraints | not landed | US :266 |
| epic 2 Notes `micGranted` | not landed | `epic-mic-and-tuner.md:49` |
| chip letter "E" | landed before the epic | 8d15e3e |

**A7 process** (Product owner, with the dev):

| Item | Outcome | Evidence |
|---|---|---|
| sweep greps triage logs; deferrals in frontmatter | landed in practice | 3.12 plan:104,316; the workflow itself is unchanged |
| one unit-test location | landed | 00a571b, `tests/unit/test-location.test.ts` |
| one story at a time or worktrees | no evidence found in the workflow | the history is linear, one story at a time |
| non-destructive bad_plan revert | not landed | `.agents/skills/bmad-build-auto/step-04-review.md:107` still says "Revert code changes" |
| finish Auto Run Result and task boxes before done | not landed | three done plans still have unchecked boxes: 3.8 (5), 3.9 (7), 3.10 (5) |

**Still deferred from epic 2:** none of the eight items changed (rate re-read, YIN dropout, 192 kHz, OS block copy, toast reach, mic release control, In tune slack, pitch cost).

## Action items

These are proposed only; nothing was applied. The human decides what runs, and the dev loop executes it.

| # | Action | Kind | Owner | Source findings |
|---|--------|------|-------|-----------------|
| A1 | **Take-save robustness, before the Tab epic reads takes:**<br>• count, or hold on to, non-quota append failures, so a take is never deleted as short while its compressed audio is whole, and bring the duration and `clipped` in line with the saved audio after storage-full;<br>• give a failed save true copy (no "saved"), keep the mic live, and re-offer the take in the same session;<br>• re-read the take's status before Discard, and check the active take before the scan offers it;<br>• queue a Stop pressed while starting;<br>• let a requested stop reason win over a queued `ended`, and don't navigate after a handover;<br>• share one `isBusy` between the unload guard and `app-reload`, and give the refused Settings Reload feedback. | Remediation (story) | Dev | DS1–DS7 |
| A2 | **Handover and recovery coordination:**<br>• the released tab broadcasts `released`, and the scan waits for it (with a long fallback) instead of a fixed 3.5 s;<br>• `writeCompressed` re-checks the fence before it removes other formats;<br>• a handover cancels a recovery rebuild in progress;<br>• an e2e test on the steal path;<br>• keep the shell (or a Stop) mounted when `blocked` fires during a take;<br>• show the first tab that its take was saved. | Remediation (story) | Dev, with the architect for AD-6 and AD-15 | DS8, DS9; behaviour check 4 |
| A3 | **Recording-store refactor:**<br>• extract the take lifecycle (`ActiveTake`, count-in start, `finishTake`, limits, failure stops) from `recording-session.ts` into its own module with an explicit state machine;<br>• share the save pipeline, the 500 ms constant and clip counting with recovery;<br>• make `audio/encode.ts` throw `AppError`. | Remediation (refactor story; do it first so A1 lands in the new module) | Dev, with the architect for the AD-3 boundary | GC1, DM1, PD1, DS13 |
| A4 | **Announcements:**<br>• the store emits failure-stop and storage-full notices that the shell announces on any screen;<br>• errors are not overwritten by count-in beats;<br>• the polite queue drains in a hidden tab;<br>• Esc cancels a count-in from a text field. | Remediation | Dev | DS10, DS11; DM3 |
| A5 | **Test gaps:**<br>• measure Stop latency on the production lane;<br>• assert ≤ 5,000,000 bytes, or state MiB in the spec;<br>• Space in a text input on the production lane (ticket 5's Verify);<br>• a production-lane recovery check;<br>• the WAV fallback in a real browser;<br>• the app-wide `onHeld` scan-delay wiring. | Remediation (tests) | Dev | SR1, SR5, SR2, DS8 |
| A6 | **Spec reconciliations for a human to apply:**<br>• spine: AD-2 (owner of `beforeunload`), AD-6 (flush step) and AD-16 (`pagehide`/`flushAll`, `versionchange` → `lost`), AD-15 (scan delay), AD-18 (two regions, UI-derived announcements, banners without a role), the state diagram's `storage-full`, the structural seed;<br>• epic Decision :58 (WAV adds a no-op v3 migration);<br>• epic `covers` (+CAP-2, CAP-26) and References (+AD-11, AD-18);<br>• US-1.2:293 (mic-lost is not analysed);<br>• EXPERIENCE.md:113 (storage-full banner on Record);<br>• carried from epic 2 A6, not landed: AD-3, AD-18, AD-12, US-1.3 fftSize, US-1.1, epic 2 Notes `micGranted`. | Spec reconciliation | Architect (Winston) for the spine; UX (Sally) for EXPERIENCE; product owner for the epic file and user stories | SR6–SR10, AV2, AV3; epic 2 A6 |
| A7 | **Process:**<br>• the build workflow gets a non-destructive `bad_plan` revert (stash or branch) — epic 2 A7, still open;<br>• a plan is not marked done while it has unchecked task boxes — epic 2 A7, still open; 3.8, 3.9 and 3.10 have them;<br>• behaviour-check and verification probes run Vite with their own `cacheDir` (or a copied tree), so they never rewrite the shared `node_modules/.vite` under the user's running dev server. | Process lesson | Product owner (workflow), with the dev | Previous-retro follow-through; behaviour check side effect |
| A8 | **Next sweep:**<br>• the strings ↔ format cycle;<br>• the MediaRecorder and resume-with-timeout duplicates;<br>• e2e IndexedDB readers, `opfsFiles` and locators;<br>• unit test fixtures;<br>• dev hooks into `dev/`;<br>• plus the 3.12 frontmatter deferrals (key shape, spacing tokens, getUserMedia instrumentations, live-region observers, the visually-hidden assertion). | Remediation (sweep) | Dev | AV1, DM2, DM4, PD2, PD3 |

**Still deferred and tracked:**
- the 3.3 announcement queue cap and gap (medium, unverified);
- the 3.10 upgrade-blocked render test;
- the scale-label font sizes;
- silence vs Too-quiet;
- the eight epic 2 items;
- recovery UX: Open's late navigation and Discard without confirmation (DS12) are accepted by the user on 2026-10-03.

## Acceptance verdict

**Machine verdict: accepted-with-open-items. Criteria: declared** (epic file, Done when 1–4).

- **Ticket status:** all 12 tickets are done; `pending_tickets` is empty.
- **Done when 1:** met on the production lane: Space-to-capture 57–64 ms in tests and 62 ms observed; a 5-minute take ≤ 5 MiB, saved as `max-length`.
- **Done when 2:** met on the dev lane: ≥ 9 s offered, and the take opens and decodes.
- **Done when 3:** met: 2.015 s, with no click in raw or compressed audio.
- **Done when 4:** met as the recorded Decision reads it: the take is saved `instance-lost`.
- **Open items:**
  - **No blocking finding:** none stands between the epic and its criteria.
  - **Real defects outside the criteria' tested paths:** DS1 (a take deleted after non-quota write failures), DS3 (failed saves misreported) and DS8 (timer-based handover inference). They are routed to A1 and A2 as fix-now stories, to land before the Tab epic builds on saved takes.
  - **Gaps in the criteria' own checks:** Stop latency and the MiB/MB unit (A5).
  - **Owner real-hardware checks** (epic Notes :64-68), not yet run:
    - a real mic in real Chrome;
    - a USB unplug mid-take;
    - two real tabs;
    - closing a tab mid-take and reopening.

**Human decision (user, 2026-10-03): accepted.** The epic is accepted with the open items above. A3, A1 and A2 open the Tab view and editor epic, in that order.

## Open questions

Answered by the user on 2026-10-03:
- **Verdict:** the epic is accepted.
- **Next stories:** A3 (store refactor), then A1 (take-save robustness), then A2 (handover and recovery) are the opening stories of the Tab view and editor epic. This is recorded as a Decision in that epic's Notes.
- **Recovery UX (DS12):** Discard stays without a confirmation, and Open still navigates when the encode finishes. These are accepted deviations; later retros should not re-flag them.

Still open:
- **Hardware checks:** the four owner real-hardware checks (epic Notes) have not been run. Their results could add findings.
- **Dev server:** port 5173 stopped during the behaviour check and was not restarted.
