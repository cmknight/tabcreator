// Number formats with no copy dependency, so `strings.ts` can use them without importing
// `format.ts` (which reads `strings`).

/**
 * A signed number with U+2212 for minus and `+` for plus: "+12", "−1", "0" (−0 is "0"). Callers
 * round first; level readings are never positive, so they show no `+`.
 */
export function formatSigned(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0';
}
