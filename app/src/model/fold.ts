// Latin text folding shared by the export slug (model/export-file.ts) and Library search
// (model/library.ts `searchKey`): NFD with combining marks stripped, lowercased without the
// locale (so a Turkish locale does not turn "I" into "ı"), and the letters NFD does not split
// folded to ASCII.

/** Letters NFD does not split, folded to ASCII (lowercase; the text is lowercased first). */
const FOLD: Record<string, string> = { ß: 'ss', ø: 'o', æ: 'ae', œ: 'oe', ł: 'l', đ: 'd' };

/** `text` NFD-normalised, diacritics stripped, lowercased, ß ø æ œ ł đ folded (ss o ae oe l d). */
export function foldLatin(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[ßøæœłđ]/g, (c) => FOLD[c]!);
}
