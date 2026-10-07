// Dev-only hooks. Story 3.9: while `window.__storageFullHook` is true, every raw append rejects
// with `storage-full`, as when the disk fills mid-take. Story 6.7: `window.__storageFullSaveHook`
// (below). Two importers: storage/audio-store.ts calls `storageFullHookOn` and
// storage/write-guard.ts calls `storageFullSaveHookOn`, each only inside `import.meta.env.DEV`
// (write-guard's `assertDevSaveSpace` is itself called only inside that guard), so production
// builds replace every call with dead code and tree-shake this module (the CI dist grep checks
// `__storageFullHook`, `__storageFullSaveHook` and `assertDevSaveSpace`).
// Read through `globalThis`, as the OPFS worker's build also compiles audio-store.ts.
// Every export also falls back to the production behaviour (no hook) outside dev builds, so a
// call missing its guard changes nothing in production.

interface StorageFullHook {
  __storageFullHook?: boolean;
  __storageFullSaveHook?: boolean;
}

/** Whether the dev storage-full hook is on. */
export function storageFullHookOn(): boolean {
  if (!import.meta.env.DEV) return false;
  return !!(globalThis as StorageFullHook).__storageFullHook;
}

/**
 * Whether the dev storage-full save hook is on (story "Storage protection and Library states"):
 * while `window.__storageFullSaveHook` is true, compressed audio writes and the take and tab
 * saves (`patchTake`, `putTab`) reject with `storage-full` (storage/write-guard.ts
 * `assertDevSaveSpace`), until it is cleared.
 */
export function storageFullSaveHookOn(): boolean {
  if (!import.meta.env.DEV) return false;
  return !!(globalThis as StorageFullHook).__storageFullSaveHook;
}
