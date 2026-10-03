// The count-in metronome (story 3.6, US-3.3, spine AD-2, AD-9). Four clicks scheduled on a live
// input's own audio clock: 30 ms sine bursts at −12 dBFS, 1500 Hz on beat 1 and 1000 Hz on
// beats 2–4. The clicks are connected only to the context's destination (the speakers), never
// into the source → worklet / gate capture graph, so no click can enter a take.

/**
 * How far after the press beat 1 is scheduled, in seconds, so it is never late or clipped and
 * all four beat gaps are equal.
 */
export const COUNT_IN_LEAD_S = 0.015;
/** Beats in a count-in (one 4/4 bar). */
export const COUNT_IN_BEATS = 4;
/** Each click's length, in seconds. */
export const CLICK_S = 0.03;
/** Each click's peak gain: −12 dBFS. */
export const CLICK_GAIN = 10 ** (-12 / 20);
/** Beat 1's pitch (the accent), in Hz. */
export const ACCENT_HZ = 1500;
/** Beats 2–4's pitch, in Hz. */
export const BEAT_HZ = 1000;
/** The attack and release ramps inside each click, in seconds, so a burst does not pop. */
const RAMP_S = 0.002;

/** A count-in's times on the audio clock, in seconds. */
export interface CountInSchedule {
  /** Beat k (1–4) at `t0 + COUNT_IN_LEAD_S + (k − 1) · 60 / bpm`. */
  beats: number[];
  /** Capture opens on beat five: `t0 + COUNT_IN_LEAD_S + 4 · 60 / bpm`. */
  captureStart: number;
}

/**
 * The beats and the capture start of a count-in at `bpm` from the press's audio-clock time `t0`;
 * beat 1 comes `COUNT_IN_LEAD_S` after it.
 */
export function countInSchedule(t0: number, bpm: number): CountInSchedule {
  const interval = 60 / bpm;
  const first = t0 + COUNT_IN_LEAD_S;
  return {
    beats: Array.from({ length: COUNT_IN_BEATS }, (_, k) => first + k * interval),
    captureStart: first + COUNT_IN_BEATS * interval,
  };
}

/** The parts of an audio context the metronome uses. */
export type ClickContext = Pick<
  BaseAudioContext,
  'currentTime' | 'destination' | 'createOscillator' | 'createGain'
>;

/**
 * Schedules one click per time in `beats` (audio-clock seconds; the first is the accented beat
 * 1), each no earlier than now, into `ctx.destination` only. Returns the cancel: every click
 * not yet played is stopped and every click is disconnected. Calling it twice is harmless.
 */
export function scheduleClicks(ctx: ClickContext, beats: readonly number[]): () => void {
  const voices: { osc: OscillatorNode; gain: GainNode }[] = [];
  const quietly = (fn: () => void) => {
    try {
      fn();
    } catch {
      // Already stopped or disconnected, or the context is closed.
    }
  };
  beats.forEach((time, k) => {
    const at = Math.max(time, ctx.currentTime);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = k === 0 ? ACCENT_HZ : BEAT_HZ;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(CLICK_GAIN, at + RAMP_S);
    gain.gain.setValueAtTime(CLICK_GAIN, at + CLICK_S - RAMP_S);
    gain.gain.linearRampToValueAtTime(0, at + CLICK_S);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.onended = () => {
      quietly(() => osc.disconnect());
      quietly(() => gain.disconnect());
    };
    osc.start(at);
    osc.stop(at + CLICK_S);
    voices.push({ osc, gain });
  });
  return () => {
    for (const { osc, gain } of voices.splice(0)) {
      osc.onended = null;
      // A stop at or before a future start time means the click never sounds.
      quietly(() => osc.stop());
      quietly(() => osc.disconnect());
      quietly(() => gain.disconnect());
    }
  };
}
