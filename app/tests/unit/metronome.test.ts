import { describe, expect, it } from 'vitest';
import {
  ACCENT_HZ,
  BEAT_HZ,
  CLICK_GAIN,
  CLICK_S,
  COUNT_IN_LEAD_S,
  countInSchedule,
  scheduleClicks,
  type ClickContext,
} from '../../src/audio/metronome';

// Story 3.6: the count-in's beat schedule, and the clicks on a fake audio context.

class FakeParam {
  value = 0;
  events: [string, number, number][] = [];
  setValueAtTime(v: number, t: number) {
    this.events.push(['set', v, t]);
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.events.push(['ramp', v, t]);
  }
}

class FakeNode {
  connected: unknown[] = [];
  connect(node: unknown) {
    this.connected.push(node);
  }
  disconnect() {
    this.connected = [];
  }
}

class FakeOscillator extends FakeNode {
  type = '';
  frequency = new FakeParam();
  starts: number[] = [];
  stops: (number | undefined)[] = [];
  onended: (() => void) | null = null;
  start(t: number) {
    this.starts.push(t);
  }
  stop(t?: number) {
    this.stops.push(t);
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

function fakeContext(currentTime = 0) {
  const oscillators: FakeOscillator[] = [];
  const gains: FakeGain[] = [];
  const destination = new FakeNode();
  const ctx = {
    currentTime,
    destination,
    createOscillator: () => {
      const o = new FakeOscillator();
      oscillators.push(o);
      return o;
    },
    createGain: () => {
      const g = new FakeGain();
      gains.push(g);
      return g;
    },
  } as unknown as ClickContext;
  return { ctx, oscillators, gains, destination };
}

describe('countInSchedule', () => {
  it.each([
    [40, 1.5],
    [100, 0.6],
    [120, 0.5],
    [240, 0.25],
  ])('at %i BPM: beat k at t0 + lead + (k − 1)·%f, capture at t0 + lead + 240/bpm', (bpm, i) => {
    const { beats, captureStart } = countInSchedule(5, bpm);
    expect(beats).toHaveLength(4);
    beats.forEach((t, k) => expect(t).toBeCloseTo(5 + COUNT_IN_LEAD_S + k * i, 12));
    expect(captureStart).toBeCloseTo(5 + COUNT_IN_LEAD_S + 240 / bpm, 12);
  });

  it('beat 1 comes 15 ms after the press, and all four gaps are equal', () => {
    const { beats, captureStart } = countInSchedule(3.25, 120);
    expect(COUNT_IN_LEAD_S).toBe(0.015);
    expect(beats[0]).toBeCloseTo(3.265, 12);
    [...beats.slice(1), captureStart].forEach((t, k) => expect(t - beats[k]!).toBeCloseTo(0.5, 12));
  });

  it('at 120 BPM the capture opens 2.0 s after the press, plus the lead (within 20 ms)', () => {
    expect(countInSchedule(3.25, 120).captureStart - 3.25).toBeCloseTo(2.015, 12);
  });
});

describe('scheduleClicks', () => {
  it('plays four 30 ms sine bursts: 1500 Hz on beat 1, 1000 Hz on beats 2–4', () => {
    const f = fakeContext(1);
    scheduleClicks(f.ctx, [1, 1.5, 2, 2.5]);
    expect(f.oscillators.map((o) => o.type)).toEqual(['sine', 'sine', 'sine', 'sine']);
    expect(f.oscillators.map((o) => o.frequency.value)).toEqual([
      ACCENT_HZ,
      BEAT_HZ,
      BEAT_HZ,
      BEAT_HZ,
    ]);
    expect(f.oscillators.map((o) => o.starts)).toEqual([[1], [1.5], [2], [2.5]]);
    f.oscillators.forEach((o, k) => expect(o.stops[0]).toBeCloseTo([1, 1.5, 2, 2.5][k]! + CLICK_S));
  });

  it('peaks at −12 dBFS and starts and ends silent', () => {
    const f = fakeContext();
    scheduleClicks(f.ctx, [1]);
    const events = f.gains[0]!.gain.events;
    expect(CLICK_GAIN).toBeCloseTo(0.2512, 4);
    expect(Math.max(...events.map((e) => e[1]))).toBe(CLICK_GAIN);
    expect(events[0]).toEqual(['set', 0, 1]);
    expect(events.at(-1)![1]).toBe(0);
    expect(events.at(-1)![2]).toBeCloseTo(1 + CLICK_S);
  });

  it('connects only to the destination (never into a capture graph)', () => {
    const f = fakeContext();
    scheduleClicks(f.ctx, [1, 2]);
    f.oscillators.forEach((o, k) => expect(o.connected).toEqual([f.gains[k]]));
    f.gains.forEach((g) => expect(g.connected).toEqual([f.destination]));
  });

  it('never schedules beat 1 before now', () => {
    const f = fakeContext(4);
    scheduleClicks(f.ctx, [3.9, 4.5]);
    expect(f.oscillators[0]!.starts).toEqual([4]);
    expect(f.oscillators[1]!.starts).toEqual([4.5]);
  });

  it('cancel stops and disconnects every click; a second cancel is harmless', () => {
    const f = fakeContext();
    const cancel = scheduleClicks(f.ctx, [1, 1.5, 2, 2.5]);
    cancel();
    for (const o of f.oscillators) {
      expect(o.stops).toHaveLength(2);
      expect(o.stops[1]).toBeUndefined();
      expect(o.connected).toEqual([]);
      expect(o.onended).toBeNull();
    }
    for (const g of f.gains) expect(g.connected).toEqual([]);
    expect(() => cancel()).not.toThrow();
  });
});
