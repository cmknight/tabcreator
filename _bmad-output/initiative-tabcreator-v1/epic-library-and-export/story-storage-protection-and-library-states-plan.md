---
title: 'Storage protection and Library states'
type: 'feature'
ticket: '7'
created: '2026-10-06'
status: 'draft'
route: 'full'
route_source: 'auto'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The rest of CAP-19 and CAP-25 for the Library is missing:
- the browser may evict takes, and the app never asks it not to;
- the player isn't told when it refuses;
- Settings shows no storage status;
- the Library has no usage footer;
- a save that failed for lack of space is invisible from the Library.

**Approach:** A new `storage/persistence.ts` (AD-2: `navigator.storage` lives in `storage/`) gives four things:
- `requestPersistOnce()`, called by recording-session after a take is saved;
- `persisted()` and `estimateUsage()`;
- a storage-full status (set when a storage write fails with `storage-full`, cleared by the next committed save).

library-session and settings-session read it (AD-3) and drive four pieces of UI:
- the one-time Library warning;
- the Settings Storage panel;
- the Library footer;
- the Library storage-full banner.

## Boundaries & Constraints

**Always:**
- Only `storage/` touches `navigator.storage.persist/persisted/estimate`; `ui/` never imports `storage/` (ESLint enforces it).
- `navigator.storage` missing or throwing is handled as "not protected" or "no usage", and never throws into a session.
- **Persist request:** `persist()` is requested at most once per page load, only after a take is saved (recording or recovery), and only when `persisted()` is false.
- **The warning:**
  - It shows on the Library when storage is not persisted, the library has at least one take, and `prefs.persistNoticeShown` is false.
  - Showing it sets `persistNoticeShown: true` through `updatePrefs`, so it never appears on a later visit.
  - It has a "Back up library" action (starting the 6.5 backup) and a Dismiss button that hides it for this visit.
  - It uses `role="status"`.
- **Storage-full status:**
  - It is set whenever a `storage/` write rejects with `storage-full`, which is the `toStorageError` QuotaExceeded mapping and the existing dev hook path.
  - It is cleared by the next committed save (`take-put`, `tab-put` or `library-restored` emitted).
  - It is in-memory for the page's lifetime, so it survives navigation but not reload.
- **Library storage-full banner:**
  - Text: "Storage is full — delete takes or their audio, or back up and clear".
  - It is an error banner with `role="alert"`, no Dismiss and no link.
  - It sits above the `<h1>`, with the persist warning, as in the mockup.
- **Footer:**
  - Text: "n takes · X MB used" (`formatMegabytes`), from `estimate().usage`.
  - n is the whole library even while searching (`rows.length`).
  - There is no footer when the library is empty or the usage is unknown.
  - It refreshes after library storage events.
- **Settings:** a Storage panel between Defaults and About shows "Storage: protected" (check icon) or "Storage: may be cleared by the browser" (warning icon), with a link to the Library ("Back up library", `#/library`) when it isn't protected.

**Never:**
- No change to the `Prefs` shape (`persistNoticeShown` already exists).
- No new AppError code.
- No new `StorageEvent` type.
- No persisted storage-full flag.
- No Library storage-full action link.
- No calling `persist()` on app start or before any take is saved.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First save, granted | persist() → true | Settings "Storage: protected"; no Library warning | — |
| First save, refused | persist() → false, notice not shown | Library shows the warning once; prefs.persistNoticeShown becomes true; a later visit shows none | — |
| Already persisted | persisted() → true | persist() is never called | — |
| Second save, same page | persist already requested | No second persist() call | — |
| Warning action | Click Back up library in the warning | Starts the backup (same as the header button) | — |
| No storage API | `navigator.storage.persist` undefined, or it throws | Treated as not protected; nothing throws; no persist call | caught, logged in dev |
| Empty library | 0 takes | No footer; no warning | — |
| Searching | Query filters 3 of 23 rows | Footer still reads "23 takes · …" | — |
| Storage full | A storage write rejects storage-full | The Library banner shows (also when the Library is opened later in the same page load) | — |
| Save succeeds later | A committed take-put/tab-put/library-restored | Banner clears | — |
| Estimate unavailable | estimate() missing or throws | No footer | caught |

</intent-contract>

## Code Map

- **`app/src/storage/README.md`:** storage owns `navigator.storage` (AD-2).
  - Add `persistence.ts` with injectable `navigator.storage`.
  - Add the storage-full status with its own `subscribe` (not a `StorageEvent`).
  - It clears itself by subscribing to `events.ts`.
- **`app/src/storage/write-guard.ts:32` `toStorageError`:** the QuotaExceeded → `storage-full` mapping. Set the status there.
  - The dev hook `src/dev/hooks/storage-full.ts` (`window.__storageFullHook`) rejects raw appends in `audio-store.ts:250-253`; set the status there too.
  - For the e2e, add a DEV-only way to make a save fail with storage-full: extend `storage-full.ts` with a second flag that makes `writeCompressed` and `db` take writes (patchTake, putTab) reject with storage-full (through the same status-setting path) until cleared. Keep it `import.meta.env.DEV`-gated so the prod bundle has none (the CI dev-code grep).
- **`app/src/storage/prefs.ts`:** `loadPrefs`, `updatePrefs({persistNoticeShown: true})`.
- **`app/src/session/recording-session.ts:839`** (deps wiring, interface :221):
  - add a `requestPersist` dep;
  - call it after a successful `saveTake` in `take-lifecycle.ts` (:833) and in recovery (`recording-recovery.ts:333`, through its deps);
  - fire and forget, never awaited into the save's outcome.
- **`app/src/session/library-session.ts`:**
  - add to the snapshot `storage: { protected: boolean | null; usageBytes: number | null; full: boolean }` and `persistNotice: boolean`;
  - read them on attach, refresh usage after storage events, and follow the storage-full status;
  - add a method to mark the notice shown.
  - Injected deps, as for the 6.5/6.6 additions.
- **`app/src/session/settings-session.ts:58`:** add `storageProtected: boolean | null` to the snapshot, read on subscribe, with deps injected.
- **`app/src/ui/screens/Library.tsx`:**
  - the render order is at :775-870; put the banners above `h1` and a `<footer>` after the body;
  - the 6.6 restore banner shows the banner/announce pattern;
  - `StorageFullBannerView` links to `#/library`, so it's unsuitable as is; reuse the `banner` styles.
  - The mockup is `mockups/library.html` :632-724 (the notice markup, the `.libfoot` footer, the storage-full banner).
- **`app/src/ui/screens/Settings.tsx`** and its `.module.css`: the panel pattern (`section.panel`, `h2.panelTitle`). The mockup is `mockups/settings.html` :315-374, with `.stat` and the ok/warn icon colours.
- **`app/src/ui/strings.ts`, `icons.tsx`:** add the strings and icons; check and warn icons may already exist.
- **Tests:**
  - unit: a new `persistence.test.ts`, plus `library-session`, `settings-session`, `library-screen` and the Settings screen tests, and the recording-session/take-lifecycle tests (`requestPersist` called after a save, not after a failed one);
  - e2e: a new `tests/e2e/storage-states.dev.spec.ts`, stubbing `navigator.storage.persist`/`persisted`/`estimate` with `page.addInitScript` and recording takes via `library.dev.spec.ts`'s helpers.

## Tasks & Acceptance

**Execution:**
- [ ] `app/src/storage/persistence.ts` (new), `write-guard.ts`, `audio-store.ts`, `dev/hooks/storage-full.ts`, `storage/README.md` -- persist-once, persisted, estimate, and the storage-full status with set and clear -- owned by `storage/` (AD-2).
- [ ] `app/src/session/recording-session.ts`, `take-lifecycle.ts`, `recording-recovery.ts` -- call `requestPersist` after a successful save -- "after the first take is saved".
- [ ] `app/src/session/library-session.ts`, `settings-session.ts` (+ README) -- the new snapshot fields and the notice-shown method -- screens read only stores (AD-3).
- [ ] `app/src/ui/screens/Library.tsx`, `Settings.tsx`, `.module.css`, `strings.ts`, `icons.tsx` -- the warning, the storage-full banner, the footer, and the Storage panel -- per the mockups.
- [ ] Unit tests -- every matrix row.
- [ ] `app/tests/e2e/storage-states.dev.spec.ts` (new) -- the ticket's Verify.

**Acceptance Criteria:**
- Given persist() stubbed to refuse, when a take is recorded and the Library opened, then the warning shows; its Back up library starts a backup; after a reload (or a new visit) it no longer shows.
- Given persist() stubbed to grant, when a take is recorded, then Settings shows "Storage: protected".
- Given takes in the library, then the footer shows their count and the stubbed usage in MB, and it keeps the full count while a search narrows the list.
- Given the storage-full dev hook making a save fail, when the Library is opened, then the storage-full banner shows; after the hook is cleared and a save succeeds (for example a rename), the banner is gone.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

- **The ticket's unknown** (how the Library learns of a failed save, given AD-3): `storage/` itself keeps the status. Every failing write passes through its error mapping, and every committed save already emits an AD-5 event, which clears it. Both stores read `storage/`, never each other.
  - The status lives in memory, so after a reload the banner returns only when a save fails again. A persisted flag could go stale after the user frees space outside the app.
  - Recorded as an assumption for review.
- **"Once":** persist is requested once per page load. The visible "once ever" is the warning, through `persistNoticeShown`. Chrome grants or refuses without a prompt, so repeated calls on later loads are harmless and let a later grant take effect.
- **Rename counts as a save** for clearing the banner: it is a committed take write.

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass.
- `cd app && npx -y -p node@24.21.0 -p pnpm@12.6.0 -- pnpm stylelint` -- expected: clean.
- `cd app && npx -y pnpm@12.6.0 build && grep -rl "__storageFull" dist` -- expected: no match (dev hooks stripped).
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test --project=dev tests/e2e/storage-states.dev.spec.ts tests/e2e/library.dev.spec.ts tests/e2e/record.dev.spec.ts tests/e2e/backup.dev.spec.ts` -- expected: pass.
