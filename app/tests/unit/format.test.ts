import { describe, expect, it } from 'vitest';
import {
  formatSigned,
  formatTakeDate,
  formatTrimTime,
  inputDisplayName,
} from '../../src/ui/format';

describe('formatSigned', () => {
  it('writes minus as U+2212, plus as +, and zero (also −0) bare', () => {
    expect(formatSigned(-12)).toBe('\u221212');
    expect(formatSigned(0)).toBe('0');
    expect(formatSigned(-0)).toBe('0');
    expect(formatSigned(7)).toBe('+7');
  });
});

describe('inputDisplayName', () => {
  it('uses the label, or "Microphone N" when the browser gives none', () => {
    expect(inputDisplayName('USB Interface', 2)).toBe('USB Interface');
    expect(inputDisplayName('', 2)).toBe('Microphone 2');
  });
});

describe('formatTakeDate', () => {
  it('writes local date and 24-hour time: "Sun 27 Sep 2026, 21:14"', () => {
    expect(formatTakeDate(new Date(2026, 8, 27, 21, 14))).toBe('Sun 27 Sep 2026, 21:14');
    expect(formatTakeDate(new Date(2026, 0, 5, 9, 3))).toBe('Mon 5 Jan 2026, 09:03');
    expect(formatTakeDate(new Date(2026, 11, 31, 0, 0))).toBe('Thu 31 Dec 2026, 00:00');
  });

  it('accepts an ISO string, shown in local time', () => {
    const local = new Date(2026, 8, 27, 21, 14);
    expect(formatTakeDate(local.toISOString())).toBe('Sun 27 Sep 2026, 21:14');
  });
});

describe('formatTrimTime', () => {
  it('m:ss.cc to the hundredth', () => {
    expect(formatTrimTime(0)).toBe('0:00.00');
    expect(formatTrimTime(130)).toBe('0:00.13');
    expect(formatTrimTime(2000)).toBe('0:02.00');
    expect(formatTrimTime(65_432)).toBe('1:05.43');
    expect(formatTrimTime(-5)).toBe('0:00.00');
  });
});
