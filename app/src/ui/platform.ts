// The one owner of the browser's file and clipboard APIs (spine AD-2): clipboard writes,
// downloads (a temporary `<a download>`) and the file picker (a temporary `<input type=file>`).
// Nothing else in the app touches `navigator.clipboard` or builds those elements. Object URLs
// made for a download are revoked after use (`REVOKE_DELAY_MS`, or on `pagehide`).

/** Writes `text` to the clipboard; rejects when the browser refuses. */
export async function copyText(text: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) {
    throw new Error('Clipboard unavailable');
  }
  await navigator.clipboard.writeText(text);
}

/**
 * How long a download's object URL is kept before it is revoked (story 7.17): long enough for a
 * large backup to be taken by the browser; `pagehide` revokes it sooner.
 */
export const REVOKE_DELAY_MS = 60_000;

/** Saves `blob` as a download named `fileName`. */
export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.append(a);
  try {
    a.click();
  } finally {
    a.remove();
    // Revoked once the browser has surely taken the URL (revoking at once can cancel the
    // download), or as the page goes, whichever comes first.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const revoke = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      window.removeEventListener('pagehide', revoke);
      URL.revokeObjectURL(url);
    };
    timer = setTimeout(revoke, REVOKE_DELAY_MS);
    window.addEventListener('pagehide', revoke);
  }
}

/** Saves `text` as a `text/plain;charset=utf-8` download named `fileName`. */
export function downloadText(fileName: string, text: string): void {
  downloadBlob(fileName, new Blob([text], { type: 'text/plain;charset=utf-8' }));
}

/**
 * How long after the window regains focus (or the page becomes visible again) pickFile waits for
 * the input's `change` before it takes the picker as closed with no file (the fallback for
 * browsers with no `cancel` event, Chromium < 113): the `change` of a chosen file arrives after
 * the focus.
 */
export const PICK_FOCUS_GRACE_MS = 500;

export interface PickFileOptions {
  /**
   * A file chosen after pickFile already resolved null through its fallback (the focus or
   * visibility grace passed with no `change`): it is delivered here instead.
   */
  onLate?(file: File): void;
}

/** The latest pickFile's input, while it is open or kept for a late `change`. */
let pendingPick: { supersede(): void } | null = null;

/**
 * Opens the file picker for one file of the `accept` types; resolves with the chosen file, or
 * null when the player cancels (the input's `cancel` event) or, as a fallback, when the window
 * regains focus or the page becomes visible again and no file arrives within
 * `PICK_FOCUS_GRACE_MS`. After a fallback null the hidden input is kept: a late `change` still
 * delivers its file through `onLate`. A new pickFile call supersedes a pending one (it resolves
 * null; its kept input goes, with no late file). The input is removed once nothing waits on it.
 */
export function pickFile(accept: string, { onLate }: PickFileOptions = {}): Promise<File | null> {
  pendingPick?.supersede();
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    let settled = false;
    /** The input is gone: nothing more is delivered from it. */
    let released = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const chosen = () => input.files?.[0] ?? null;
    const arm = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(fallback, PICK_FOCUS_GRACE_MS);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') arm();
    };
    const stopWatching = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      window.removeEventListener('focus', arm);
      document.removeEventListener('visibilitychange', onVisible);
    };
    /** Nothing waits on the input any more: it goes. */
    const release = () => {
      released = true;
      stopWatching();
      input.remove();
      if (pendingPick === self) pendingPick = null;
    };
    const settle = (file: File | null) => {
      if (settled) return;
      settled = true;
      release();
      resolve(file);
    };
    /** The grace passed with no `change`: null now, the input kept for a late one. */
    const fallback = () => {
      const file = chosen();
      if (file) {
        settle(file);
        return;
      }
      settled = true;
      stopWatching();
      resolve(null);
    };
    const self = {
      supersede() {
        if (settled) release();
        else settle(null);
      },
    };
    input.addEventListener('change', () => {
      if (released) return;
      if (!settled) {
        settle(chosen());
        return;
      }
      const file = chosen();
      release();
      if (file) onLate?.(file);
    });
    input.addEventListener('cancel', () => {
      if (settled) release();
      else settle(null);
    });
    document.body.append(input);
    pendingPick = self;
    try {
      input.click();
    } catch {
      settle(null);
      return;
    }
    // Added after the click: the picker taking focus away comes first, then its return.
    window.addEventListener('focus', arm);
    document.addEventListener('visibilitychange', onVisible);
  });
}

/** Where the platform name is read from: `navigator` (tests pass their own). */
export type PlatformSource = Pick<Navigator, 'platform'> & {
  userAgentData?: { platform?: string } | undefined;
};

/** Whether the platform is Windows (`userAgentData.platform`, else `navigator.platform`). */
export function isWindowsPlatform(
  source: PlatformSource | undefined = typeof navigator === 'undefined'
    ? undefined
    : (navigator as PlatformSource),
): boolean {
  if (!source) return false;
  return /^win/i.test(source.userAgentData?.platform || source.platform || '');
}
