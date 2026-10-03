import { describe, expect, it } from 'vitest';
import { formatSigned, inputDisplayName } from '../../src/ui/format';

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
