// A take title's length rule (spine AD-14: take-session and library-session both rename a take),
// shared so both writers cap a title the same way.

/** The longest take title, in characters. */
export const TITLE_MAX = 100;

/** `title` cut to `TITLE_MAX` code points, so a surrogate pair (an emoji) is never split. */
export function capTitle(title: string): string {
  const points = Array.from(title);
  return points.length <= TITLE_MAX ? title : points.slice(0, TITLE_MAX).join('');
}

/**
 * The title a rename stores: trimmed and capped (then trimmed again, should the cap leave a
 * trailing space). Null when nothing should be written: empty, or the same as `current`.
 */
export function renamedTitle(raw: string, current: string): string | null {
  const title = capTitle(raw.trim()).trim();
  return title === '' || title === current ? null : title;
}
