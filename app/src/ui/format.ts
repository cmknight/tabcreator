// Display formats shared by screens (EXPERIENCE.md voice): durations and clock times.

/** `m:ss` for a duration in ms, rounded down to the second. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** A local clock time as a lowercase 12-hour clock: "9:14 pm", "12:05 am". */
export function formatClockTime(date: Date): string {
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours % 12 || 12}:${minutes} ${hours < 12 ? 'am' : 'pm'}`;
}
