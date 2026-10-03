import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIP_LEVEL, TOO_LOUD_PEAK_DB } from '../../src/model/level-warnings';

// Story 3.8: the recorder worklet's clip count, driven with fake worklet globals (a tiny
// `sampleRate`, so a chunk is 8 frames, and 4-frame render quanta).

const RATE = 8;
const BLOCK = 4;

type Message = { type: string; samples?: Float32Array; clipped?: number };

interface FakeProcessor {
  port: { postMessage: (msg: Message) => void; onmessage: ((e: { data: unknown }) => void) | null };
  process(inputs: Float32Array[][]): boolean;
}

let frame = 0;
let Processor: new () => FakeProcessor;

beforeEach(async () => {
  vi.resetModules();
  frame = 0;
  vi.stubGlobal('sampleRate', RATE);
  Object.defineProperty(globalThis, 'currentFrame', { configurable: true, get: () => frame });
  vi.stubGlobal(
    'AudioWorkletProcessor',
    class {
      port = { postMessage: vi.fn(), onmessage: null };
    },
  );
  vi.stubGlobal('registerProcessor', (_name: string, ctor: new () => FakeProcessor) => {
    Processor = ctor;
  });
  // The worklet is excluded from the app's tsconfig; a computed path keeps it out of this one.
  const path = '../../src/audio/recorder-worklet.ts';
  await import(/* @vite-ignore */ path);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { currentFrame?: number }).currentFrame;
});

/** Runs `blocks` render quanta through a new processor started at `start` and stopped at `stop`. */
function run(blocks: number[][], start: number, stop: number): Message[] {
  const node = new Processor();
  const sent: Message[] = [];
  node.port.postMessage = (msg) => sent.push(msg);
  node.port.onmessage!({ data: { type: 'start', frame: start, clipLevel: CLIP_LEVEL } });
  node.port.onmessage!({ data: { type: 'stop', frame: stop } });
  for (const block of blocks) {
    if (!node.process([[Float32Array.from(block)]])) break;
    frame += BLOCK;
  }
  return sent;
}

const chunks = (sent: Message[]) => sent.filter((m) => m.type === 'chunk');

describe('recorder worklet clip count', () => {
  it('uses the meter Too loud threshold (−1 dBFS) as a linear level', () => {
    expect(CLIP_LEVEL).toBeCloseTo(10 ** (TOO_LOUD_PEAK_DB / 20), 12);
    expect(TOO_LOUD_PEAK_DB).toBe(-1);
  });

  it('counts captured samples with |x| ≥ −1 dBFS in each chunk, both signs', () => {
    const hot = 0.9;
    const sent = run(
      [
        [0, hot, -1, 0.5],
        [0, 0, 0, 0],
        [-hot, 0.88, 0, 0],
      ],
      0,
      12,
    );
    // 8-frame first chunk: 0.9 and −1; the final 4-frame chunk: −0.9 only (0.88 < 0.891).
    expect(chunks(sent).map((m) => [m.samples!.length, m.clipped])).toEqual([
      [8, 2],
      [4, 1],
    ]);
    expect(sent.at(-1)!.type).toBe('stopped');
  });

  it('does not count clipping before the start frame or after the stop frame', () => {
    const sent = run(
      [
        [1, 1, 1, 1],
        [1, 1, 0, 0],
        [0, 0, 1, 1],
      ],
      6,
      10,
    );
    // Frames 6–9 are captured: 0, 0, 0, 0.
    expect(chunks(sent).map((m) => [Array.from(m.samples!), m.clipped])).toEqual([
      [[0, 0, 0, 0], 0],
    ]);
  });

  it('counts nothing before a start message gives the level', () => {
    const node = new Processor();
    const sent: Message[] = [];
    node.port.postMessage = (msg) => sent.push(msg);
    node.port.onmessage!({ data: { type: 'start', frame: 0 } });
    node.port.onmessage!({ data: { type: 'stop', frame: 4 } });
    node.process([[Float32Array.from([1, 1, 1, 1])]]);
    expect(chunks(sent).map((m) => m.clipped)).toEqual([0]);
  });
});
