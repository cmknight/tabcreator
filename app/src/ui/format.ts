// Display formats shared by screens (EXPERIENCE.md voice): durations, clock times and input names.

import { strings } from './strings';

/** `m:ss` for a duration in ms, rounded down to the second. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * A take's recording date and time in local time on a 24-hour clock: "Sun 27 Sep 2026, 21:14"
 * (EXPERIENCE.md Tab row). `date` is a Date or an ISO 8601 string.
 */
export function formatTakeDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`;
}

/**
 * A signed number with U+2212 for minus and `+` for plus: "+12", "−1", "0" (−0 is "0"). Callers
 * round first; level readings are never positive, so they show no `+`.
 */
export function formatSigned(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0';
}

/** A local clock time as a lowercase 12-hour clock: "9:14 pm", "12:05 am". */
export function formatClockTime(date: Date): string {
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours % 12 || 12}:${minutes} ${hours < 12 ? 'am' : 'pm'}`;
}

/**
 * An input's display name: its label, or "Microphone N" when the browser gives none, where `n`
 * is its 1-based place in the device list. The Microphone select and the switched-input toast
 * both name inputs this way.
 */
export function inputDisplayName(label: string, n: number): string {
  return label || strings['global.microphoneUnnamed'](n);
}
