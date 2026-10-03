import { afterEach, describe, expect, it, vi } from 'vitest';
import { startCapture } from '../../src/audio/recorder';
import { CLIP_LEVEL } from '../../src/model/level-warnings';

// Story 3.8: `startCapture` sends the worklet its clip threshold with the start message (the
// worklet imports nothing, and counts nothing without it). A minimal fake audio graph.

const posted: Record<string, unknown>[] = [];

class FakeWorkletNode {
  port = {
    onmessage: null as ((e: MessageEvent) => void) | null,
    postMessage: (msg: Record<string, unknown>) => posted.push(msg),
  };
}

class FakeMediaRecorder {
  state = 'inactive';
  ondataavailable: unknown = null;
  onerror: unknown = null;
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
  }
  addEventListener() {}
}

const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });

function fakeContext() {
  return {
    state: 'running',
    currentTime: 1,
    sampleRate: 48_000,
    audioWorklet: { addModule: vi.fn(() => Promise.resolve()) },
    createGain: () => ({
      ...node(),
      gain: { value: 0, setValueAtTime: vi.fn() },
    }),
    createMediaStreamDestination: () => ({
      ...node(),
      channelCount: 2,
      stream: { getTracks: () => [] },
    }),
    resume: () => Promise.resolve(),
  } as unknown as AudioContext;
}

afterEach(() => {
  vi.unstubAllGlobals();
  posted.length = 0;
});

describe('startCapture', () => {
  it('sends the clip threshold (CLIP_LEVEL, −1 dBFS) with the start message', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    const capture = await startCapture(fakeContext(), node() as unknown as AudioNode, () => {});
    const start = posted.find((m) => m.type === 'start');
    expect(start).toMatchObject({ type: 'start', clipLevel: CLIP_LEVEL });
    expect(CLIP_LEVEL).toBeCloseTo(0.891251, 6);
    capture.abort();
  });
});
