// Dev-only hook (story 3.9): while `window.__storageFullHook` is true, every raw append rejects
// with `storage-full`, as when the disk fills mid-take. storage/audio-store.ts calls it only
// inside `import.meta.env.DEV`, so production builds tree-shake this module. Read through
// `globalThis`, as the OPFS worker's build also compiles audio-store.ts.

interface StorageFullHook {
  __storageFullHook?: boolean;
}

/** Whether the dev storage-full hook is on. */
export function storageFullHookOn(): boolean {
  return !!(globalThis as StorageFullHook).__storageFullHook;
}
