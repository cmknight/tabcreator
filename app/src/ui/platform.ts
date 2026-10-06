// The one owner of the browser's file and clipboard APIs (spine AD-2): clipboard writes,
// downloads (a temporary `<a download>`) and the file picker (a temporary `<input type=file>`).
// Nothing else in the app touches `navigator.clipboard` or builds those elements. Object URLs
// made for a download are revoked after use.

/** Writes `text` to the clipboard; rejects when the browser refuses. */
export async function copyText(text: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) {
    throw new Error('Clipboard unavailable');
  }
  await navigator.clipboard.writeText(text);
}

/** How long a download's object URL is kept before it is revoked (the click starts the download). */
const REVOKE_DELAY_MS = 1000;

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
    // Revoked once the browser has taken the URL (revoking at once can cancel the download).
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }
}

/** Saves `text` as a `text/plain;charset=utf-8` download named `fileName`. */
export function downloadText(fileName: string, text: string): void {
  downloadBlob(fileName, new Blob([text], { type: 'text/plain;charset=utf-8' }));
}

/**
 * How long after the window regains focus pickFile waits for the input's `change` before it
 * takes the picker as cancelled (the fallback for browsers with no `cancel` event, Chromium <
 * 113): the `change` of a chosen file arrives after the focus.
 */
export const PICK_FOCUS_GRACE_MS = 500;

/**
 * Opens the file picker for one file of the `accept` types; resolves with the chosen file, or
 * null when the player cancels (the input's `cancel` event, or, where there is none, the window
 * regaining focus with no file chosen). The hidden input is removed once settled.
 */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onFocus = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => settle(input.files?.[0] ?? null), PICK_FOCUS_GRACE_MS);
    };
    const settle = (file: File | null) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => settle(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => settle(null));
    document.body.append(input);
    try {
      input.click();
    } catch {
      settle(null);
      return;
    }
    // Added after the click: the picker taking focus away comes first, then its return.
    window.addEventListener('focus', onFocus);
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
