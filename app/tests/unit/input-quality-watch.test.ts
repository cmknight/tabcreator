import { describe, expect, it, vi } from 'vitest';
import { createInputQualityWatch } from '../../src/session/input-quality-watch';

const A = { deviceId: 'a', label: 'Mic A', groupId: 'ga' };
const HEADSET = { deviceId: 'h', label: 'AirPods Pro (Hands-Free)', groupId: 'gh' };

function opened(
  deviceId: string | null,
  extra: { label?: string; sampleRate?: number | null } = {},
) {
  return {
    analyser: {} as AnalyserNode,
    readFrame: () => new Float32Array(0),
    close: () => {},
    deviceId,
    groupId: null,
    label: extra.label ?? '',
    sampleRate: extra.sampleRate === undefined ? 48_000 : extra.sampleRate,
  };
}

function setup() {
  const patch = vi.fn();
  return { watch: createInputQualityWatch(patch), patch };
}

describe('input quality watch', () => {
  it('is fine for a normal input at 48 kHz', () => {
    const { watch } = setup();
    expect(watch.transition({ live: true, input: opened('a'), devices: [A] })).toEqual({
      inputQualityPoor: false,
      inputQualityDismissed: false,
    });
  });

  it("uses the listed device's label, else the track's, and the track rate", () => {
    const { watch } = setup();
    const t = (input: ReturnType<typeof opened>, devices = [A, HEADSET]) =>
      watch.transition({ live: true, input, devices }).inputQualityPoor;
    expect(t(opened('h'))).toBe(true);
    expect(t(opened('default', { label: 'Bluetooth Headset' }))).toBe(true);
    expect(t(opened('a', { sampleRate: 16_000 }))).toBe(true);
    expect(t(opened('a', { sampleRate: 44_100 }))).toBe(false);
    expect(t(opened('a', { sampleRate: null }))).toBe(false);
  });

  it('keeps its last answer while a switch has no input; false when not live', () => {
    const { watch } = setup();
    watch.transition({ live: true, input: opened('h'), devices: [HEADSET] });
    expect(watch.transition({ live: true, input: null, devices: [HEADSET] }).inputQualityPoor).toBe(
      true,
    );
    expect(watch.transition({ live: false, input: null, devices: [] }).inputQualityPoor).toBe(
      false,
    );
  });

  it('recomputes on a device change with a settled input, keeps it otherwise', () => {
    const { watch } = setup();
    const input = opened('a');
    watch.transition({ live: true, input, devices: [A] });
    expect(watch.devicesChanged({ input, devices: [{ ...A, label: 'Headset' }] })).toEqual({
      inputQualityPoor: true,
    });
    expect(watch.devicesChanged({ input: null, devices: [A] })).toEqual({ inputQualityPoor: true });
    expect(watch.devicesChanged({ input, devices: [A] })).toEqual({ inputQualityPoor: false });
  });

  it('Dismiss publishes once and lasts across transitions', () => {
    const { watch, patch } = setup();
    watch.dismiss();
    watch.dismiss();
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith({ inputQualityDismissed: true });
    expect(watch.transition({ live: false, input: null, devices: [] })).toEqual({
      inputQualityPoor: false,
      inputQualityDismissed: true,
    });
  });
});
