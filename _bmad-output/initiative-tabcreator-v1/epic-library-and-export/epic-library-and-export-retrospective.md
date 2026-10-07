---
epic: epic-library-and-export
date: 2026-10-06
verdict: accepted-with-open-items
criteria: declared
headless: false
---

# Retrospective: Library and export (epic 6)

## Epic summary

- **Epic:** `epic-library-and-export` (id 6), file `epic-library-and-export.md`. It has a declared Done when (4 criteria). The epic file has no `status` yet; closing it is the ticketing skill's job, confirmed by the user.
- **Retro choices:** the user named this epic and asked for no particular focus.
- **Tickets:** all 9 are `done`. `pending_tickets` is empty, and no ticket is left at `built`. Story 6.7 was blocked once on an intent gap (b06c456) and resumed after the user decided it (epic Notes, Decision for 6.7).

| Ref | Title | Status | Range (baseline → next baseline) | Commits (excluding ticket chores) |
|-----|-------|--------|-------|-------------------|
| 6.1 | Library list (tracer) | done | cc3d08d..b45d558 | 15b1b68 feat |
| 6.4 | Copy and Download on the Tab screen | done | b45d558..b9213c2 | d19c0d7 feat |
| 6.8 | Recovered take metadata from its compressed copy (DS2) | done | b9213c2..f2790ef | 81d6402 fix |
| 6.2 | Rename, delete take and delete audio | done | f2790ef..5bf2b19 | 4df4d9e feat; 5c051ed test |
| 6.3 | Search 500 takes | done | 5bf2b19..622294a | 8a0dca8 feat |
| 6.5 | Back up the library | done | 622294a..c7fd66f | de6ab3a feat; 35d8e28 style |
| 6.6 | Restore from a backup | done | c7fd66f..f9071be | 9ac0a1e feat |
| 6.7 | Storage protection and Library states | done | f9071be..6367b51 | 3340b38 feat (blocked b06c456, then resumed) |
| 6.9 | Refactor sweep | done | 6367b51..31df414 (inferred: HEAD) | 5bb7ecc refactor |

- **Build order:** the plans' baselines put 6.4 and 6.8 before 6.2. That matches the inception Decision, which lists 6.4 and 6.8 as parallel lanes.
- **Evidence inventory:**
  - **Available:**
    - the epic file;
    - SPEC CAP-17, CAP-18, CAP-19 and CAP-25;
    - 9 plans;
    - `git_evidence.py` output for each range;
    - the epic diff `cc3d08d..HEAD -- app .github` (82 files, +10,810 / −164, no merges);
    - session transcript `b7bc06f5-….jsonl` (last written 2026-10-06 21:20), which is the likely record of these builds.
  - **Missing:**
    - story files (no entry was refined);
    - a previous retrospective: the epic before this one in build order, Tab editing (epic 8), has no retrospective file.

## Findings

How each view was derived:
- **Deterministic:** an import-graph script over `git archive` trees at cc3d08d and HEAD (`retro6/scripts/graph.py`), `git_evidence.py` churn, `wc`, and grep for API ownership.
- **Inline judgment:** what counts as duplication and as divergence.
- **Diff-scope review:** `bmad-review` with three lenses (adversarial, edge-case, verification-gap) over `epic.diff`, weighted toward the seams between stories.
- **Process lessons:** from the session transcript `b7bc06f5-….jsonl`, which covers all of epic 6; L = JSONL line, times in UTC.

The key claims were re-checked against the files before routing. Line refs are as of HEAD `31df414`.

### Aggregate views

**Architecture delta**
- **AV1.** 15 new modules, none removed, in five layers:
  - storage: `backup`, `backup-worker`, `restore`, `persistence`, `paths`
  - session: `library-session`
  - ui: `platform`, `tab-export`, `RowMenu`
  - model: `library`, `title`, `fold`, `export-file`
  - dev: `library500`, `Library500Page`

  Every new cross-layer edge goes in a direction the layer rules allow. Browser APIs have single owners: clipboard, download and file picking in `ui/platform.ts`; persist and estimate in `storage/persistence.ts`; fflate only in `storage/backup-worker.ts`, enforced by a CI chunk check. *Accept*.
- **AV2.** A new cycle: `storage/backup-worker.ts:19` imports `MANIFEST_NAME` from `storage/backup.ts:104`, which starts that same worker (`backup.ts:162`). 6.9 created `storage/paths.ts` as an import-free leaf for exactly this kind of constant. *Fix now* (B5).
- **AV3.** Storage-full is a second change channel: `storage/persistence.ts:101-150` holds module state (`storageFull`, `fullTakeIds`, its own listeners). `write-guard.ts` `toStorageError` now has a side effect, and Record keeps its own `storageFull` (`take-lifecycle.ts:261`), so the same fact lives in two places. *Fix now* (B1).
- **AV4.** Placement drifts from AD-3:
  - search lives in `ui/screens/Library.tsx:629`, not in `library-session`;
  - `library-session` writes the prefs (`persistNoticeShown`) directly (`library-session.ts:21,610-612`);
  - restore is orchestrated in session (`library-session.ts:532-562`), backup in storage.

  *Spec reconciliation* (B6).

**Duplication map**
- **DM1.** Two storage-full banners. Library builds its own `role="alert"` markup (`Library.tsx:829-837`) instead of `StorageFullBannerView`, which is announced through the announcer (AD-18). The same text appears three times in `strings.ts` (`record.storageFullUnsaved`, `tab.storageFull`, `library.storageFull`:553). The 6.9 sweep missed this. *Fix now* (B1).
- **DM2.** "Is storage persisted" is read in two stores under different names: `settings-session.ts:30,102-110` (`storageProtected`) and `library-session.ts:53,312` (`storage.protected`). *Defer* to the sweep (B5).
- **DM3.**
  - The delete-audio cleanup is written three times: `db.deleteTake` (`db.ts:336-347`), `library-session.ts:473-478`, and the restore rollback (`:553`).
  - Restore's `TAKE_STATUSES` and `STOP_REASONS` (`restore.ts:43-51`) are untyped copies of the model unions.
  - The tab defaults are written twice (`db.ts:90`, `restore.ts:117`).

  *Fix now* for the validator link (B2); *defer* the rest (B5).
- **DM4. Consolidated, recorded so they are not re-flagged:** `model/title.ts`, one `formatMegabytes`, `storage/paths.ts`, `ConfirmDialog` reused three times, and `RowMenu` built on `openOverlay`.

**God-class and size growth**
- **GC1.** `ui/screens/Library.tsx` is 937 lines, built over six stories. It holds:
  - row widgets (`:104-238`);
  - a row with its menu and two confirms (`:240-440`);
  - the virtualised list (`:444-595`);
  - the screen itself (`:596-937`): search, backup, restore, the persist notice, the storage-full banner, errors and the footer.

  It is now the third-largest source file, after `take-session.ts` (1545) and `Tab.tsx` (1129). *Defer* to the sweep (B5).
- **GC2.** `session/library-session.ts` is 614 lines: one store with nine operations, and a `LibraryDeps` of 21 members (`:134-171`). *Accept*; watch it.
- **GC3.** The top churn entry is the committed patch `_bmad-output/implementation-artifacts/story-6-7-attempt-1.patch` (2154 lines, b06c456), not code. *Accept* (process record).

**Pattern divergence**
- **PD1.** Errors:
  - `ui/platform.ts:9` throws a plain `Error`;
  - `backup-worker.ts:76` defines its own `Failure` class, which `backup.ts:191` maps to `AppError` (AD-10).

  *Defer* (B5).
- **PD2.** Live regions:
  - `Library.tsx` uses `role="status"` (`:801`) and `role="alert"` (`:831,:924`) next to `announce()`;
  - elsewhere, only `InstanceScreen` uses a role.

  *Fix now* with B1 for the banner; *spec reconciliation* for AD-18.
- **PD3.** Px literals where tokens exist: `RowMenu.module.css:25` 36px (`--size-control`); `Library.module.css:86,103` 13px and 12px; an 18px icon size repeated in three places. No colour literals. *Defer* (B5).
- **PD4.** Dependency injection takes four shapes:
  - `createLibrarySession(deps)`;
  - `createSettingsSession(client, prefsDeps, storageDeps)`;
  - `createBackup(deps, onProgress)`;
  - `readBackup(file, deps)`.

  *Accept*.

### Spec-to-implementation reconciliation

- **SR1, Done when 1.** Covered:
  - live updates in `library.dev.spec.ts:91` (dev);
  - search p95 ≈ 25 ms in `search-latency.dev.spec.ts:152` (perf project, dev server).

  Gaps:
  - Nothing runs on the deployed build.
  - The gate is p95, not "each keystroke" (`tickets.toml:58`).
  - Live means within one tab, because the instance lock blocks a second tab.

  The behaviour check measured it on the production build (below). *Accept*; *spec reconciliation* for SPEC.md:81's p95; a test on the deployed build (B4).
- **SR2, Done when 2.** Copy equals the download (`export.dev.spec.ts:82`, dev; the `\r\n` branch only). Alignment is checked as equal line lengths; no monospace editor is involved. *Accept*.
- **SR3, Done when 3.** Restoring into a fresh context reproduces takes, tabs and audio, and a second restore imports 0 (`restore.dev.spec.ts:79`, dev).
  - Restore of a WAV take is unit-only.
  - Raw files and takes still `recording` are not in a backup (backup plan :37,:41), although SPEC.md:87 says "every … audio file".
  - A take whose audio is missing from the zip is restored with no audio (Decision, epic :47), but its record keeps `audioMime` (DS3).

  *Accept*; *spec reconciliation* for SPEC.md:87 and US :900; DS3 is *fix now*.
- **SR4, Done when 4.** Delete audio frees space and keeps the tab; delete take leaves no take, tab or OPFS file (`library.dev.spec.ts:282`). The "raw included" path of Delete audio is not exercised, because analysed takes have no raw file. *Accept*.
- **SR5.** UX divergences that no Decision covers:
  - Library errors (rename, delete, backup, copy, download) appear only as toasts (`Library.tsx:176,694`; `tab-export.ts:34,53`), against EXPERIENCE:87 "never the only place an error appears".
  - A one-time persist notice with Dismiss contradicts EXPERIENCE:86, where warnings return on the next visit.
  - New restore-failed copy (`strings.ts:547`) against EXPERIENCE:117.
  - The footer is not pinned (`Library.module.css:338-345`) against DESIGN:266 and EXPERIENCE:32.
  - Restore skips the Confirm when nothing is new (restore plan :178).

  *Spec reconciliation* (B6); the footer pinning is a possible defect (B5).
- **SR6.** The epic's Assumption line (:45) is consistent with AD-11, EXPERIENCE:44 and the Stack, but it is still marked "for review". It should be promoted to a Decision. The epic Boundaries (:30) list `storage/backup.ts` only; `restore.ts` and `persistence.ts` were added as well. *Spec reconciliation* (B6).
- **SR7.** The spine is stale:
  - AD-5 "a store ignores events it wrote" does not hold for `library-session.ts:375-393` (it re-reads, guarded by `pendingTitles`);
  - AD-14 doesn't state that `importTakes` skips existing ids;
  - AD-2 doesn't name `storage/persistence.ts`;
  - the structural seed (:278, :325-326, :344) lacks the 15 new modules and the backup worker.

  *Spec reconciliation* (B6).

### Diff-scope review (bmad-review)

Lens overlap is noted in brackets.

- **DS1. The storage-full status clears on the wrong events** (`persistence.ts:145-150`, pinned by `persistence.test.ts:159-183`):
  - Deleting a take, which is what the banner advises, never clears it.
  - Deleting the audio of the take that failed doesn't clear it either (that take is in `fullTakeIds`).
  - Renaming any other take, or `createTake` at the start of a new recording, does clear it.
  - A restore that imported 0 takes clears it (`importTakes([])` always emits `library-restored`; `Library.tsx:740`).
  - The footer's usage is re-read on the event, before the OPFS files are removed (`db.ts:343-346`), so it doesn't drop after a delete.

  [all three lenses] *Fix now* (B1).
- **DS2.** The Library storage-full banner is separate from Record's: it has its own markup and role, and its own state (see DM1). [adversarial] *Fix now* (B1).
- **DS3.** A take with an audio type but no zip entry is imported with `audioMime` unchanged (`library-session.ts:541-556`). The row shows no "Audio deleted" badge and offers Delete audio; playback and trim fail with `audio-missing`; every later backup reports it as missing again. [all three lenses] *Fix now* (B2), after the user confirms the reading of Decision :47.
- **DS4.** Restore never calls `requestPersistOnce`, so a library rebuilt in a fresh profile stays unprotected until the next recording (only `take-lifecycle.ts:843` and `recording-recovery.ts:348` call it). [edge-case, verification-gap] *Fix now* (B2).
- **DS5.** The backup manifest records `format: 1` but not `DB_VERSION`, and restore imports records as parsed, without migrations (`restore.ts:9`). The first real record-shape migration will import old-shape records. [adversarial, edge-case] *Fix now* (B2), before any v4 migration lands.
- **DS6. Restore validation is brittle:**
  - The stop-reason and status lists are not tied to the model types (`restore.ts:43-51`). Only `max-length` is tested, so a drift would refuse whole backups.
  - Domain rules are unchecked: title cap, trim range, `createdAt`, note `endMs ≥ startMs`, fret range, `recorded` without audio, and an audio extension that doesn't match `audioMime`.
  - A backup that was unzipped and re-zipped (dotfiles, `Thumbs.db`, a top-level folder) is rejected as "not a TabCreator backup".

  [all three lenses] *Fix now* (B2).
- **DS7. Restore races:**
  - Audio is written before records, so a recovery scan running at the same time can delete just-restored audio as orphans (`recording-recovery.ts` `orphan`).
  - Audio written for an id that `importTakes` then skips is not removed.
  - A rollback under the fence leaves orphans while the copy says "nothing was changed".

  [adversarial, edge-case] *Fix now* (B2).
- **DS8. Size limits:** backup allows zips up to 4 GiB (`ZIP_MAX_BYTES`), but restore reads the whole file into memory (`unzipSync`), so a large library can be backed up and never restored. Backup also silently leaves out unfinished takes (status `recording`), and its toast doesn't say so. [adversarial] *Fix now* (B2); the streaming or size-cap choice is the architect's.
- **DS9. Platform and pause gaps:**
  - The "no writes during backup or restore" pause is enforced only in the row menu (`Library.tsx:257-334`); the session methods don't check it.
  - `downloadBlob` revokes the object URL after 1 s, which can be too early for large backups.
  - `pickFile` never settles if neither `cancel` nor `focus` fires (iOS Safari), which leaves the Restore button inert; a late `change` is dropped.

  [adversarial, edge-case] *Fix now* (B3).
- **DS10.** Ctrl/⌘+Shift+C (copy tab) is the browser's "Inspect element" shortcut. Synthetic keys in e2e can't detect the clash; the 6.4 plan already lists it as a residual (:190). [adversarial] *Fix now*: a manual check, then rebind if it clashes (B4).
- **DS11.** CI's production-bundle grep (`ci.yml:195`) lacks `__storageFullSaveHook` and `assertDevSaveSpace`, although `dev/hooks/storage-full.ts` says CI checks them. The behaviour check confirmed the hook is stripped today. [all three lenses] *Fix now* (B4).
- **DS12.** No backup or restore runs against the production build: no CSP, no bundled worker chunk, no `/tabcreator/` sub-path in tests (`csp.spec.ts` and `subpath.spec.ts` start only the engine worker). The behaviour check ran both on a production build (below). [verification-gap] *Fix now* (B4).
- **DS13.** Duplicates are detected by id only, so a backup cannot bring back audio removed with "Delete audio only", and the summary doesn't say that existing takes are never updated. [adversarial] *Defer* (a UX decision; B6).
- **DS14.** A backup started from the Library downloads even after the user has left the Library. WAV recovered takes can dominate backup size, and nothing tells the user. [adversarial] *Defer* (B3 notes).

### Process lessons

From transcript `b7bc06f5`, git and the plans.

- **PL1. A blocking question cost about 8.5 hours.**
  - 6.7 hit an intent gap at L9510 (07:25Z), was saved as a patch, checked with `git apply --check` (L9518) and blocked (b06c456).
  - The question went to the user at L9532 and was answered at L9536 (15:55Z).
  - 6.9 depended on 6.7 only for its docs.
  - The fix under the ruling added state (`fullTakeIds`) and went in as a "carried" patch with no second review (6.7 plan :593-600). DS1 is in that code.
- **PL2. Stylelint wasn't in local verification until CI failed.**
  - It failed CI for 6.3 (L7689), and the fix (35d8e28) was pushed from a worktree where stylelint never ran (Node 25 engine check, L7701-7707).
  - 5c051ed fixed an earlier epic's re-fit test after a CI failure (L7432-7460); no plan records it.
- **PL3. Two flakes are rerun instead of fixed:** tuner timing (L7112, L7633) and count-in (L6916, L9467).
- **PL4. Record-keeping gaps:**
  - 6.9 is marked done with an unchecked task box (refactor-sweep plan :77).
  - The Auto Run Result patch counts disagree with the triage logs in 6.5 (:184) and 6.6 (:191).
  - The 6.6 plan still calls the missing-audio question open (:193), although it was ruled at L9536.
  - The triage rows don't add up to the verdict headers in 6.3, 6.5, 6.6 and 6.9.
- **PL5. Review numbers.**
  - Findings: 248 across 9 plans, with no high and 7 mediums; 99 rows were patched, 2 deferred.
  - No `bad_plan` loopbacks; `review_loop_iteration` is 0 everywhere.
- **PL6. Recording retro A7:**
  - The non-destructive `bad_plan` revert has not landed (`.agents/skills/bmad-build-auto/step-04-review.md:107`); the 6.7 intent-gap revert happened to be non-destructive.
  - "No done plan with unchecked boxes" broke once (6.9).
  - Probe `cacheDir` has not landed: Playwright's dev webServer (`playwright.config.ts:131`) still uses the shared `node_modules/.vite`. This retro's own probe used a scratch `cacheDir`, and port 5173 was not affected.

## Behavior verification

Flows 1–5 ran on a production build (`vite preview`, scratch `cacheDir` and `outDir`) with Chromium's fake capture device. Flow 6's hooks needed the dev server. Nothing was listening on 5173 before or after, and `app/node_modules/.vite` was unchanged. Scripts and logs are in `retro6/behavior/`. No console errors were logged.

1. **Library list.**
   - The empty state is "No takes yet · Record"; Search and Back up are disabled.
   - Takes appeared without a reload (a `__noReload` marker survived).
   - A take still `recording` shows a Recording badge with no link or menu.
   - The footer read "1 take · 0.1 MB used", and the persist notice appeared after the first save.
2. **Search, 503 takes.**
   - Virtualised: 17 `<li>` for `aria-setsize` 503.
   - Per keystroke over 34 keystrokes: p50 13.7 ms, p95 27.5 ms, max 28.6 ms. Every keystroke was under 50 ms.
   - "No takes match … Clear search"; accent folding works ("cafe" finds 50).
3. **Rename and delete.**
   - Rename saved.
   - Delete audio removed the webm, set `audioMime` null and kept the tab; usage dropped 483,806 → 455,797.
   - Delete take left no take, tab or file, and focus moved to the h1.
4. **Copy and Download.** The clipboard and `blues-riff.txt` are identical (253 B, LF), and the six tab lines are all 27 characters. CRLF was not checked.
5. **Backup and restore.**
   - The backup (843,839 B, 503 takes, 3 audio including a 763,244 B WAV) restored into a fresh context with **identical** hashes for every take, tab and audio file. The WAV decodes and plays.
   - Restoring again imported 0 and skipped 503.
   - A truncated zip is rejected with "nothing was changed".
6. **Storage protection.**
   - `persist()` is called once, after the first save.
   - The production build ignores `__storageFullSaveHook`.
   - On dev: the banner shows on a failed rename, survives navigation, stays on the same take's save, and clears on another take's save (DS1's rule, observed).
   - **Not checked:** the granted-persist state.

**Observed:**
- The recovery banner uses 12-hour time ("9:39 pm"), while titles and rows use 24-hour.
- A take still `recording` cannot be renamed or deleted from the Library until it is recovered.

## Previous-retro follow-through

There was nothing to follow through on: the previous epic in build order, `epic-tab-editing` (id 8), has no retrospective file (`epic-tab-editing-retrospective.md` does not exist). This is a missing file, not a record of zero outstanding items.

## Action items

These are proposed only; nothing was applied. The human decides what runs, and the dev loop executes it.

| # | Action | Kind | Owner | Source findings |
|---|--------|------|-------|-----------------|
| B1 | **Storage-full status:**<br>• clear it when space is actually freed (take deleted, audio deleted), or on a re-check of `estimate()`, not on a rename, a `createTake` or a 0-take restore;<br>• re-read usage after the files are removed;<br>• one source of truth shared by Record and the Library;<br>• the Library banner built on `StorageFullBannerView` and the announcer;<br>• one string. | Remediation (story) | Dev | DS1, DS2, AV3, DM1, PD2 |
| B2 | **Restore correctness:**<br>• missing-audio takes imported with `audioMime: null` (confirm the reading of Decision :47 first);<br>• request persistence after a restore with imports;<br>• `schemaVersion` in the manifest and migrations run on import, before any v4 migration;<br>• validator lists `satisfies` the model unions, plus domain checks and a test for every stop reason;<br>• tolerate re-zipped backups;<br>• no orphan-scan race, and no audio left for skipped ids;<br>• a size cap or streaming unzip so every backup can be restored;<br>• report skipped unfinished takes. | Remediation (story) | Dev, with the architect for the format and size limit | DS3–DS8, DM3 |
| B3 | **Library robustness:**<br>• the session refuses or queues writes during backup and restore;<br>• a longer object-URL lifetime for large downloads;<br>• `pickFile` always settles;<br>• no backup download after leaving the Library. | Remediation | Dev | DS9, DS14 |
| B4 | **Verification:**<br>• backup and restore on the production build (CSP, worker chunk, sub-path);<br>• add `__storageFullSaveHook` and `assertDevSaveSpace` to the CI dist grep;<br>• the search gate on the deployed build;<br>• a manual check of Ctrl/⌘+Shift+C in Chrome, Edge and Firefox, and a rebind if it clashes;<br>• the CRLF export on a Windows user agent. | Remediation (tests) | Dev; the owner for the manual shortcut check | DS10–DS12, SR1, SR2 |
| B5 | **Next sweep:**<br>• move `MANIFEST_NAME` into `storage/paths.ts` (breaks the cycle);<br>• split `Library.tsx`;<br>• one "persisted" read;<br>• one delete-audio cleanup;<br>• duplicate strings;<br>• px literals to tokens;<br>• `AppError` in `platform.ts` and the worker;<br>• the footer pinning;<br>• the 6.9 deferred platform sniff. | Remediation (sweep) | Dev | AV2, GC1, DM2, DM3, PD1, PD3, SR5 |
| B6 | **Spec reconciliations for a human to apply:**<br>• SPEC.md:81 (p95 per keystroke) and SPEC.md:87 / US :900 (raw and unfinished takes are not backed up);<br>• EXPERIENCE:87 (errors only as toasts), :86 vs :114 (the one-time persist notice), :117 (restore-failed copy), and the Confirm skipped when nothing is new;<br>• spine AD-3 (search placement; library-session writes a pref), AD-5 (own-event filtering), AD-11 (restore and record shape), AD-14 (`importTakes` skips existing ids), AD-2 (`persistence.ts`), the structural seed;<br>• epic: promote the Assumption line :45 to a Decision, widen Boundaries :30;<br>• state that restore never fills in audio for existing takes (DS13, user 2026-10-06). | Spec reconciliation | Architect (Winston) for the spine; UX (Sally) for EXPERIENCE and DESIGN; product owner for SPEC, US and the epic file | SR1, SR3, SR5–SR7, AV4, DS13 |
| B7 | **Process:**<br>• when a ticket blocks on a question, the loop notifies the user and moves on to unblocked tickets;<br>• a fix applied under a user ruling that adds state gets a short re-review;<br>• stylelint with Node 24 in every story's local verification, and never push a fix whose check didn't run;<br>• before done: Auto Run Result counts equal the triage rows, open assumptions are closed, no unchecked boxes;<br>• fix or quarantine the tuner and count-in flakes;<br>• still open from the Recording retro (A7): a non-destructive `bad_plan` revert, and a dedicated `cacheDir` for Playwright's dev webServer and for probes. | Process lesson | Product owner (workflow), with the dev | PL1–PL6 |

**Still deferred and tracked:**
- 6.7's `persisted()` waiting on a pending `persist()` (medium, unverified; it would hit Firefox);
- 6.9 item 4, the platform sniff;
- the residuals in the plans: `listTabs` loads every tab's notes on each read; rows that aren't rendered can't be found by find-in-page or a screen reader; `unzipSync` holds about twice the file in memory; usage in the footer is origin-wide; storage-full status is lost on reload.

## Acceptance verdict

**Machine verdict: accepted-with-open-items. Criteria: declared** (epic file, Done when 1–4).

- **Ticket status:** all 9 tickets are done; `pending_tickets` is empty.
- **Done when 1:** met. The behaviour check on a production build had every one of 34 keystrokes under 50 ms (max 28.6 ms) with 503 takes, and new takes appeared without a reload. The CI tests run on the dev server and gate p95 (B4).
- **Done when 2:** met. Clipboard and `.txt` are byte-identical, with aligned columns.
- **Done when 3:** met for every take, tab and audio file in a backup, including WAV. A second restore imports nothing. Raw files and unfinished takes are left out of a backup by design, which is a spec reconciliation (B6).
- **Done when 4:** met.
- **Open items:**
  - **No blocking finding** stands between the epic and its criteria.
  - **Real defects outside the criteria's paths:** DS1 (storage-full status), DS3 (restored takes pointing at missing audio) and DS5 (no schema version in backups). They are routed to B1 and B2 as fix-now stories.
  - **Gaps in the criteria's own checks:** nothing runs on the production build (B4).

**Human decision (user, 2026-10-06): accepted.** The epic is accepted with the open items above. B1 and B2 open the Offline, accessibility and budgets epic.

## Open questions

Answered by the user on 2026-10-06:
- **Verdict:** the epic is accepted.
- **Next stories:** B1 (storage-full status) and B2 (restore correctness) are the opening stories of the Offline, accessibility and budgets epic. This is recorded as a Decision in that epic's Notes.
- **DS3:** a take whose audio is missing from the zip is restored as "Audio deleted" (`audioMime: null`). This settles how B2 reads Decision :47.
- **DS8:** restore reads the zip in pieces (a streaming unzip), so any backup that can be made can be restored. Backups are not capped.
- **DS13:** restore never adds audio to a take that is already in the library. This is an accepted behaviour; later retros should not re-flag it.
