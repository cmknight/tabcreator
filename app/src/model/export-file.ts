// The pure part of the tab export (story "Copy and Download on the Tab screen", CAP-18): the
// download's file name from the take's title, and the line endings the download uses. The text
// itself is `toText` (model/tab-render.ts); the clipboard and the download are ui/platform.ts.

/** The longest slug, in characters. */
export const MAX_SLUG_LENGTH = 60;

/** Letters NFD does not split, folded to ASCII (lowercase; the title is lowercased first). */
const FOLD: Record<string, string> = { ß: 'ss', ø: 'o', æ: 'ae', œ: 'oe', ł: 'l', đ: 'd' };

/** Windows reserved device names: a file named `con.txt` cannot be saved there. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

/**
 * The title as a file-name slug: NFD-normalised with diacritics stripped, lowercased, ß ø æ œ ł đ
 * folded (ss o ae oe l d), every run
 * of anything outside `a–z0–9` turned into one hyphen, hyphens trimmed from the ends, at most
 * MAX_SLUG_LENGTH characters (cut on a hyphen where one falls in the kept part). May be empty.
 * A Windows reserved name (con, prn, aux, nul, com1–9, lpt1–9) gets a `-tab` suffix.
 */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[ßøæœłđ]/g, (c) => FOLD[c]!)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return notReserved(truncate(slug));
}

/** The slug cut to MAX_SLUG_LENGTH, on a hyphen where one falls in the kept part. */
function truncate(slug: string): string {
  if (slug.length <= MAX_SLUG_LENGTH) return slug;
  const cut = slug.slice(0, MAX_SLUG_LENGTH);
  // The cut fell on a hyphen boundary already: the next character starts a new word.
  if (slug[MAX_SLUG_LENGTH] === '-') return cut.replace(/-+$/, '');
  const lastHyphen = cut.lastIndexOf('-');
  return (lastHyphen > 0 ? cut.slice(0, lastHyphen) : cut).replace(/-+$/, '');
}

/** A Windows reserved name with `-tab` appended; any other slug as it is. */
function notReserved(slug: string): string {
  return RESERVED.test(slug) ? `${slug}-tab` : slug;
}

/** The download's file name: `<slug>.txt`, or `tab.txt` when the slug is empty. */
export function exportFileName(title: string): string {
  return `${slugify(title) || 'tab'}.txt`;
}

/** The text with `\r\n` line endings on Windows, unchanged (`\n`) elsewhere. */
export function withPlatformLineEndings(text: string, windows: boolean): string {
  return windows ? text.replace(/\r?\n/g, '\r\n') : text;
}
