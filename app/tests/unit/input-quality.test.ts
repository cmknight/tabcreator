import { describe, expect, it } from 'vitest';
import { isPoorInput, MIN_GOOD_SAMPLE_RATE, POOR_INPUT_LABEL } from '../../src/model/input-quality';

const GOOD_LABEL = 'MacBook Pro Microphone (Built-in)';

describe('isPoorInput', () => {
  it('flags a rate below 44 100 Hz', () => {
    expect(isPoorInput({ sampleRate: 16_000, label: GOOD_LABEL })).toBe(true);
    expect(isPoorInput({ sampleRate: 44_099, label: GOOD_LABEL })).toBe(true);
  });

  it('accepts exactly 44 100 Hz and above', () => {
    expect(MIN_GOOD_SAMPLE_RATE).toBe(44_100);
    expect(isPoorInput({ sampleRate: 44_100, label: GOOD_LABEL })).toBe(false);
    expect(isPoorInput({ sampleRate: 48_000, label: GOOD_LABEL })).toBe(false);
  });

  it('does not flag an unknown rate by itself', () => {
    expect(isPoorInput({ sampleRate: null, label: GOOD_LABEL })).toBe(false);
    expect(isPoorInput({ sampleRate: null, label: '' })).toBe(false);
  });

  it.each([
    'AirPods Pro',
    'Bluetooth Audio',
    'AirPods Pro (Hands-Free)',
    'Jabra Headset',
    'Galaxy Buds2',
  ])('flags the label %s', (label) => {
    expect(isPoorInput({ sampleRate: 48_000, label })).toBe(true);
  });

  it.each(['airpods', 'BLUETOOTH', 'HANDS-FREE', 'hEaDsEt', 'BUDS'])(
    'matches %s regardless of case',
    (label) => {
      expect(isPoorInput({ sampleRate: null, label })).toBe(true);
    },
  );

  it('flags a poor label even with an unknown rate', () => {
    expect(isPoorInput({ sampleRate: null, label: 'Headset Microphone' })).toBe(true);
  });

  it('exports the pattern', () => {
    expect(POOR_INPUT_LABEL.test('USB Audio CODEC')).toBe(false);
    expect(POOR_INPUT_LABEL.test('handsfree')).toBe(false);
  });
});
