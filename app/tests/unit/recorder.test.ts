import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAPTURE_STOP_MARK, createCompressedOutput, startCapture } from '../../src/audio/recorder';
import { isAppError } from '../../src/model/errors';
import { CLIP_LEVEL } from '../../src/model/level-warnings';

// Story 3.8: `startCapture` sends the worklet its clip threshold with the start message (the
// worklet imports nothing, and counts nothing without it). A minimal fake audio graph.

const posted: Record<string, unknown>[] = [];

/** Every fake worklet's port, newest last. */
const ports: FakeWorkletNode['port'][] = [];

class FakeWorkletNode {
  port = {
    onmessage: null as ((e: MessageEvent) => void) | null,
    postMessage: (msg: Record<string, unknown>) => posted.push(msg),
  };
  constructor() {
    ports.push(this.port);
  }
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
  vi.restoreAllMocks();
  posted.length = 0;
  ports.length = 0;
  performance.clearMarks(CAPTURE_STOP_MARK);
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

  // CAP-25 states sweep: the stop-latency mark, set when the worklet's `stopped` message arrives.
  it('marks record-capture-stop when the worklet reports stopped, not before', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    const capture = await startCapture(fakeContext(), node() as unknown as AudioNode, () => {});
    const port = ports.at(-1)!;
    port.onmessage!({ data: { type: 'started' } } as MessageEvent);
    expect(performance.getEntriesByName(CAPTURE_STOP_MARK)).toHaveLength(0);
    port.onmessage!({ data: { type: 'stopped' } } as MessageEvent);
    expect(performance.getEntriesByName(CAPTURE_STOP_MARK)).toHaveLength(1);
    capture.abort();
  });

  it('a throwing performance.mark still settles the stop (capped resolves)', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    const mark = vi.spyOn(performance, 'mark').mockImplementation(() => {
      throw new Error('no user timing');
    });
    // With a cap, `capped` resolves once the worklet reports it has stopped.
    const capture = await startCapture(
      fakeContext(),
      node() as unknown as AudioNode,
      () => {},
      undefined,
      1000,
    );
    ports.at(-1)!.onmessage!({ data: { type: 'stopped' } } as MessageEvent);
    expect(mark).toHaveBeenCalledWith(CAPTURE_STOP_MARK);
    const settled = await Promise.race([
      capture.capped.then(() => 'capped'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 500)),
    ]);
    expect(settled).toBe('capped');
    capture.abort();
  });
});

// Refactor sweep: the compressed copy's graph is built by `createCompressedOutput`, shared with
// recovery's re-encode. A MediaRecorder that cannot be built stops the destination's tracks.
describe('createCompressedOutput', () => {
  class ThrowingMediaRecorder {
    constructor() {
      throw new DOMException('Unsupported MIME type', 'NotSupportedError');
    }
  }

  /** A context whose destination stream has one track, so its stop can be seen. */
  function contextWithTrack() {
    const track = { stop: vi.fn() };
    const ctx = fakeContext() as unknown as Record<string, unknown>;
    ctx.createMediaStreamDestination = () => ({
      ...node(),
      channelCount: 2,
      stream: { getTracks: () => [track] },
    });
    return { ctx: ctx as unknown as AudioContext, track };
  }

  it('builds a mono destination fed by the input, and a recorder that keeps non-empty data', () => {
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    const input = node();
    const parts: Blob[] = [];
    const { destination, recorder } = createCompressedOutput(
      fakeContext(),
      input as unknown as AudioNode,
      parts,
    );
    expect(destination.channelCount).toBe(1);
    expect(input.connect).toHaveBeenCalledWith(destination);
    const onData = recorder.ondataavailable as (e: { data: Blob }) => void;
    onData({ data: new Blob([]) });
    onData({ data: new Blob(['x']) });
    expect(parts).toHaveLength(1);
  });

  it('a MediaRecorder that throws: the destination tracks are stopped and the error thrown', () => {
    vi.stubGlobal('MediaRecorder', ThrowingMediaRecorder);
    const { ctx, track } = contextWithTrack();
    expect(() => createCompressedOutput(ctx, node() as unknown as AudioNode, [])).toThrow(
      'Unsupported MIME type',
    );
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('startCapture with a MediaRecorder that throws rejects mic-failed, tracks stopped', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
    vi.stubGlobal('MediaRecorder', ThrowingMediaRecorder);
    const { ctx, track } = contextWithTrack();
    const err = await startCapture(ctx, node() as unknown as AudioNode, () => {}).catch(
      (e: unknown) => e,
    );
    expect(isAppError(err) && err.code).toBe('mic-failed');
    expect(track.stop).toHaveBeenCalled();
  });
});
