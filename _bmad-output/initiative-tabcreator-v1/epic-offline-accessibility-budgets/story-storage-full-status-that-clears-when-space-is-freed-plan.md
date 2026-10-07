---
title: 'Storage-full status that clears when space is freed'
type: 'bugfix'
ticket: '1'
created: '2026-10-07'
status: done
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: 'f2497444bbbe78c5271c6061c61684fda304b7a5'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The storage-full status (Library retro B1; findings DS1, DS2, AV3, DM1, PD2) clears on the wrong events:
- A rename of another take, a `createTake`, or a restore that imported 0 takes clears it.
- Deleting a take, or deleting the audio of the take that failed, never clears it, although the banner tells the player to do exactly that.

There are also these defects:
- The footer's usage is re-read before the files are removed.
- Record keeps a second, separate storage-full flag.
- The Library banner is hand-built `role="alert"` markup, outside the announcer (AD-18).
- Three strings hold the same text.
- CI's production-bundle grep misses the 6.7 dev hooks.

**Approach:** `storage/persistence.ts` becomes the one source of the storage-full status.
- It is set by a `storage-full` write error and at startup by an `estimate()` re-check.
- It is cleared only when space is freed: after a take's files or a take's audio are actually removed, or when an `estimate()` re-check shows room.
- Record and the Library read the status from it, and Story 11 will too.
- The Library banner moves onto `StorageFullBannerView` and the announcer.

This replaces the epic 6 Decision for story 6.7 ("cleared by a committed save of any other take").

## Boundaries & Constraints

**Always:**
- **One source (`storage/persistence.ts`).** It exposes the status (`isStorageFull()`, `subscribeStorageFull()`, or a small snapshot) and a function that re-checks and clears. Record's snapshot `storageFull` stops being its own flag:
  - Record's banner visibility comes from the shared status.
  - Record keeps only which text to show: `storageFullSaved`, meaning the stopped take was saved or not.
- **Set:** any `storage-full` write error through `toStorageError` (as now), and the startup re-check when free space is below the room threshold.
- **Clear.** Only these clear the status:
  - **Take delete:** after `db.deleteTake` has removed the take's audio and raw files.
  - **Audio delete:** after `library-session.deleteAudio` has removed the take's audio.
  - **Room re-check:** an `estimate()` re-check showing room, which runs at startup and after each delete above.

  These never clear it:
  - a rename or any title-only patch;
  - `createTake` or the start of a new take (Record's "a new take clears the banner" rule goes);
  - an analysis or edit save;
  - a `library-restored` event with `count === 0`.

  A restore that imported takes does not clear it either, since it used space.
- **Room** (plan decision; no spec defines it): `estimate()` gives `quota − usage ≥ 5% of quota`.
  - An `estimate()` that is unavailable or throws neither sets nor clears the status.
  - The threshold is one named constant.
- **Footer usage:** `library-session` re-reads usage after the delete's file removals finish, not only on the storage event.
- **Library banner:** built on `StorageFullBannerView`.
  - It has no `role`, and is announced once per showing through `announce(…, 'assertive')`, as Record's banner is.
  - It shows no "Go to Library" link: the view gains an optional link prop, which defaults to the current behaviour (EXPERIENCE :113, no action on the Library itself).
- **One string:** `record.storageFullUnsaved`, `tab.storageFull` and `library.storageFull` become one shared key, e.g. `global.storageFull`, with the same text. `record.storageFull` (the "saved" text) stays.
- **CI:** the dist grep in `.github/workflows/ci.yml` gains `__storageFullSaveHook|assertDevSaveSpace`.
- **Tab's banners:** they keep their own source (an analysis or edit save that failed with `storage-full`) and only switch to the shared string.

**Never:**
- No new storage event variant just to carry the clear; explicit calls after the removals are enough.
- No change to how appends stop on `storage-full` mid-take (`ActiveTake.storageFull` stays).
- No any-screen announcement; that is story 11.
- No Tab screen banner redesign.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Delete take clears | status full; Delete take on any take | the status clears after its files are removed; the footer usage drops | removal failure: the status stays |
| Delete audio clears | status full (also for the take that failed); Delete audio | clears after the audio is removed | as above |
| Rename keeps | status full; rename any take | status stays full | none |
| New take keeps | status full; Record starts a take | Record's banner stays | none |
| 0-take restore keeps | status full; restore imports 0 | stays | none |
| Startup re-check | reload with quota − usage < 5% | status full; banners show | estimate unavailable: no change |
| Room re-check | full; after a delete, `estimate()` shows room | cleared | none |
| Record text | storage-full stop saved vs not | "recording stopped and saved" vs the shared text | none |
| Library banner | status full | `StorageFullBannerView`, no role, no link, announced once | none |

</intent-contract>

## Code Map

- **`app/src/storage/persistence.ts`:**
  - `createPersistence` (:39): `estimateUsage` (:82-92) drops `quota`, though `StorageManagerLike.estimate` (:23) types it.
  - Module state: `storageFull`, `fullTakeIds`, `fullListeners` (:103-140).
  - The clear rule is a module-load `subscribeStorage` listener (:143-150). Rewrite it.
  - The header comment (:7-12) describes the old rule.
- **`app/src/storage/write-guard.ts:39-43`:** `toStorageError` calls `markStorageFull(takeId)`; keep this. `assertDevSaveSpace` is at :50-53.
- **`app/src/storage/db.ts`:**
  - `deleteTake` (:336-347) emits `take-deleted` (:343) before `deleteAudio`/`deleteRaw` (:345-346).
  - `importTakes` (:331) always emits `library-restored`.
  - Events are defined in `storage/events.ts:7-11`; they carry no patch fields.
- **`app/src/session/library-session.ts`:**
  - `deleteAudio` (:462-479): it calls `patchTake({audioMime:null})`, then removes the files (:473-478).
  - `readUsage` (:290-301) runs on attach (:405) and on every event (:375).
  - The storage-full deps are at :165-167 and :606-607; `onStorageFull` is at :396.
- **Record:**
  - `RecordingSnapshot.storageFull` and `storageFullSaved` (`session/recording-types.ts:80-86`; `recording-session.ts:308`, :424-427).
  - They are set in `take-lifecycle.ts` `transition` at `failStart` :452, too-short :814, save-failed :837 and saved :847, and cleared at :540 and :612 (the new-take rule, which goes).
  - `ActiveTake.storageFull` (:261, :406-412) stays.
- **UI:**
  - `ui/components/StorageFullBanner.tsx:16-38`: reads `recordingSession`, announces once per showing, mounted in `Record.tsx:19`.
  - `StorageFullBannerView.tsx:7-15,36-38`: the link is always rendered.
  - `ui/screens/Library.tsx:828-837`: the role=alert banner (testId `library-storage-full`).
  - `Tab.tsx:180,330,501`: uses `tab.storageFull`.
  - `ui/strings.ts:173,178,230,553`.
- **`.github/workflows/ci.yml:195` and `app/src/dev/hooks/storage-full.ts:6`** (its header claims CI covers the hooks).
- **Tests that pin the old rule and must change:**
  - unit: `tests/unit/persistence.test.ts:144-161,168-187,218`; `library-screen.test.tsx:1078`; `storage-full-and-notices.test.tsx:56-70`; `recording-take.test.ts:360-417,619-659`; `recording-session.test.ts:32`;
  - e2e: `tests/e2e/storage-states.dev.spec.ts:183-257`; `record.dev.spec.ts:724-792` ("the next take clears it").
  - The dev hook `__storageFullSaveHook` drives the storage-full e2e.

## Tasks & Acceptance

**Execution:**
- [x] `app/src/storage/persistence.ts` and `write-guard.ts` — the single status, the clear and re-check API, the room threshold, the startup re-check (called from `main.tsx`, or at module load in production only) — with unit tests for every matrix rule.
- [x] `app/src/storage/db.ts` and `app/src/session/library-session.ts` — clear and re-check after the file removals of delete take and delete audio; read usage after the removals.
- [x] `app/src/session/take-lifecycle.ts`, `recording-types.ts` and `recording-session.ts` — Record's banner visibility from the shared status; `storageFullSaved` kept; the new-take clear removed.
- [x] `app/src/ui/components/StorageFullBannerView.tsx` (optional link), `StorageFullBanner.tsx`, `ui/screens/Library.tsx`, `ui/strings.ts`, `Tab.tsx` — the shared banner and string.
- [x] `.github/workflows/ci.yml` and the `dev/hooks/storage-full.ts` header — the grep.
- [x] Update the pinned tests listed in the Code Map, and add the e2e for the clear-on-Delete-take and stay-on-rename rows, with axe on the Library banner.

**Acceptance Criteria:**
- Given the Library with the storage-full banner (dev hook), when a take is deleted, then the banner clears; when another take is renamed instead, it stays. Record's banner follows the same status.
- Given a production build, when `dist` is grepped for the dev hook names, then nothing is found, and the CI grep names both new hooks.
- Given the full verification, when it runs, then it exits 0.

## Implementation Notes

- **API (`storage/persistence.ts`):** `ROOM_FRACTION = 0.05`; `Persistence.hasRoom()` (null when the estimate is missing, throws, or lacks a usable usage/quota, or quota is 0); `markStorageFull()`, `isStorageFull()`, `subscribeStorageFull()`; `recheckStorageFull(source?)` (start-up: no room sets, room clears, unknown does nothing; called from `main.tsx`); `storageFreed(removed, source?)` (clears when `removed`, then a re-check that only clears). A re-check that read before a new `markStorageFull` never clears it (`fullSeq` guard). The old module-load event listener and the per-take memory (`fullTakeIds`) are gone.
- **`takeId` threading removed:** with no per-take rule left, `toStorageError`, `assertDevSaveSpace`, db.ts `write`/`storageError` and audio-store's pending map no longer carry a take id.
- **db.ts `deleteTake`** calls `freed(removed)` (option, default `storageFreed`) after both file removals; `removed` is false if either removal rejected. **library-session `deleteAudio`** does the same through a new `storageFreed` dep; both deletes re-read usage after the removals.
- **Record:** `RecordingDeps` gains optional `isStorageFull`/`subscribeStorageFull`; the snapshot's `storageFull` mirrors the shared status (initial value plus a permanent subscription); when it clears, `storageFullSaved` is dropped so a later status set elsewhere shows the shared text. take-lifecycle sets only `storageFullSaved`; the new-take/count-in clears are gone. Side effect: the banner now appears as soon as a raw append fails, before the stop has saved, with the shared text; `StorageFullBanner` therefore announces again when its text changes while showing (the "stopped and saved" text once the stop saves), still once per showing otherwise.
- **Too-short storage-full take:** superseded in review round 1: an automatic delete does not clear the status, so the banner stays on (tested with the production `db.deleteTake`).
- **Library banner:** `StorageFullBannerView` with `link={false}`, announced once per showing via `announce(…, 'assertive')`.
- **Strings:** `global.storageFull` replaces `record.storageFullUnsaved`, `tab.storageFull`, `library.storageFull`.
- **e2e:** storage-states: delete clears / renames keep (Library and Record banners, axe with the banner shown, assertive announcement), mid-recording variant, and a start-up re-check test (4% free). record.dev: "the next take keeps it"; the Library's announcement now also appears when following the banner's link.

## Plan Change Log

- **Review round 1 (coordinator):** only the player's delete clears the status (`db.deleteTake` with writer `library-session`, for a take that existed, and `deleteAudio`); recording's too-short delete and recovery's deletes do not, so the too-short storage-full banner stays on again. `storageFreed` became `beginFreeing()` → `freed(removed)`, which captures the failure count at the start of the delete (a new failure meanwhile is not cleared) and does not await the re-check. Room is free ≥ min(5% of quota, `ROOM_BYTES` 500 MB). `storageFullSaved` resets to false when a take starts and is only kept while the status is full. `resetStorageFullForTests` notifies, resets the count and drops listeners. Added the Delete audio e2e case.

## Review Triage Log

### 2026-10-07 — Review pass
- verdicts: 31 findings — high 0, medium 3, low 26, false 2, maybe-false 0 (grouped G1–G9; the CAP-25 count-in e2e flake recurred under full-suite load and passed 6/6 alone; it is not this change)
- findings:
  - `medium` `patch` (intent) G1: a too-short storage-full take, deleted through `db.deleteTake`, clears the shared status in the composed app; the unit test passes only because its fake delete never frees — only a Library delete (writer `library-session`) reports freed space; the test uses the production behaviour.
  - `low` `patch` (intent) G3: Delete audio clearing is pinned only against a fake `storageFreed` — e2e added.
  - `low` `reject` (intent) the Delete-take e2e can't tell a clear from removal apart from a clear from the estimate re-check — the unit tests pin each path; the e2e checks the user-visible result.
  - `low` `reject` (intent) a reload after a real quota failure with ≥ the room threshold free shows no banner — the room rule is the plan's decision; the next failed write sets it again.
  - `false` `reject` (intent) scope additions (takeId removed, Tab strings migrated, re-announce on text change) contradict nothing — consistent with one source and one string.
  - `false` `reject` (intent) story 11 is not wired — the ticket says story 11 reads this source; a subscribable module-level status is that source.
  - `medium` `patch` (edge) G1: automatic deletes (short-take, recovery cleanup and discard) clear the status — same fix.
  - `low` `patch` (edge) G2: `storageFreed` skips the `fullSeq` guard, so a fresh failure during a delete is wiped — guard added.
  - `low` `patch` (edge) G4: `storageFullSaved` can be written after the status cleared — set only while full, and cleared when a take starts.
  - `low` `patch` (edge) G5: recording-session listeners accumulate across unit tests — the test reset clears listeners.
  - `low` `patch` (edge) G5: `resetStorageFullForTests` neither notifies nor resets `fullSeq` — fixed.
  - `low` `reject` (edge) an injected `deps.storageFreed` that rejects fails `deleteAudio` — the production implementation never rejects; a defensive catch guards a state not demonstrated.
  - `low` `patch` (edge) G6: `removed` is true when nothing existed — freed is reported only when the record existed.
  - `medium` `patch` (edge, claim) G1: recovery's automatic short-take cleanup can clear a status set by the startup re-check — same fix.
  - `low` `patch` (blind) G1: a short take that hit a full disk clears the status — same fix.
  - `low` `reject` (blind) `storageFreed(true)` clears without asking the estimate — the ticket makes a delete itself the clearing event; the next failed write or a reload re-sets it.
  - `low` `patch` (blind) G2: no `fullSeq` guard in `storageFreed` — same fix.
  - `low` `patch` (blind) G6: deleting a missing take reports freed space — same fix.
  - `low` `patch` (blind) G4: stale "stopped and saved" text — same fix.
  - `low` `reject` (blind) other removals (orphan scan, restore rollback, trim) never report freed space — only the player's delete counts, by design; automatic cleanup must not clear.
  - `low` `reject` (blind) no re-check after startup (focus, visibility, periodic) — the ticket asks for startup only; a later failed write re-sets it.
  - `low` `patch` (blind) G7: 5% of quota alone is wrong on large quotas — room is free ≥ min(5% of quota, 500 MB).
  - `low` `patch` (blind) G5: listeners and reset — same fix.
  - `low` `patch` (blind) G8: deletes await `estimate()` with no timeout — the re-check runs without awaiting.
  - `low` `reject` (blind) two assertive announcements in quick succession (the shared text, then "stopped and saved") — both are informative, and the second replaces the first as intended.
  - `low` `patch` (blind) missing tests — short-take (G1) and Delete audio (G3) added; a test that `main.tsx` calls the re-check is rejected (the startup e2e covers it).
  - `low` `patch` (blind) G9: the header's "story 11" reference is unclear — named.
  - `low` `patch` (blind) G9: duplicated text assertion in `library-screen.test.tsx` — dropped.
  - `low` `patch` (verification) G1: the short storage-full take test mocks away the deciding integration — same fix.
  - `low` `patch` (verification) G3: no e2e for Delete audio clearing — same fix.
  - `low` `patch` (verification) G6: `removed` true when files were absent — same fix.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` (repo root, `~/.cargo/bin` on PATH) — expected: all exit 0.
- `grep -rE '__storageFullSaveHook|assertDevSaveSpace' app/dist` — expected: no output.

## Auto Run Result

- **Summary:** `storage/persistence.ts` is now the one storage-full source.
  - **Set:** by any `storage-full` write error, and at startup by an `estimate()` re-check (room = free ≥ min(5% of quota, 500 MB)).
  - **Cleared:** only by the player's Delete take or Delete audio in the Library, once its files are removed and only if no new failure landed meanwhile. An estimate re-check showing room also clears it, and runs after the delete without blocking it.
  - **Not cleared:** by a rename, a new take, an analysis or edit save, any restore, or the automatic deletes (too-short takes, recovery cleanup).
  - **Record:** its banner follows the shared status and keeps only which text to show (`storageFullSaved`, reset when a take starts).
  - **Library:** its banner is `StorageFullBannerView` with no role and no link, announced once.
  - **Strings and CI:** three identical strings became `global.storageFull`; the CI dist grep gains `__storageFullSaveHook|assertDevSaveSpace`.
- **Files changed:**
  - **Storage:** `app/src/storage/{persistence,write-guard,db,audio-store}.ts`.
  - **Session:** `app/src/session/{library-session,recording-session,recording-types,take-lifecycle}.ts`.
  - **UI:** `app/src/ui/components/{StorageFullBanner,StorageFullBannerView}.tsx`, `app/src/ui/screens/{Library,Record,Tab}.tsx`, `app/src/ui/strings.ts`.
  - **Startup:** `app/src/main.tsx`, which runs the startup re-check.
  - **Dev hooks:** `app/src/dev/hooks/storage-full.ts`.
  - **CI and docs:** `.github/workflows/ci.yml`; the storage and session READMEs.
  - **Tests:** persistence, recording-take, recording-session, library-session, library-screen, storage-full-and-notices, tab-screen; e2e `storage-states.dev` and `record.dev`.
- **Review:** 31 findings (medium 3, low 26, false 2), in 9 patch groups.
  - The main fix: automatic deletes no longer clear the status. Only a Library delete of an existing take does, guarded against a failure that lands mid-delete.
  - Also: the room floor, the non-blocking re-check, `storageFullSaved` hygiene, the test reset, a Delete audio e2e, and wording.
  - Nothing deferred; rejected rows carry their reasons in the triage log.
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 3 (one root cause, G1), low 6 groups.
- **Verification:**
  - The full plan command passed install, engine build, format, lint, stylelint, typecheck, 1788 unit tests and build.
  - e2e passed on the re-run: 213 passed, 2 flaky (count-in, c_major re-fit) passing on retry.
  - The first runs failed on load-dependent timing tests (count-in; the playback cursor at 50 ms; level-meter 30 fps). Each passed alone (6/6 and 3/3 runs) and none touches storage.
  - `grep` for the dev hook names in `app/dist` printed nothing.
- **Residual risks:**
  - The room threshold is the plan's choice; no spec defines it.
  - After a reload, a disk that is still over the threshold shows no banner until the next failed write.
  - The timing-based e2e tests are increasingly flaky under full-suite load (the epic 6 retro's PL3).
