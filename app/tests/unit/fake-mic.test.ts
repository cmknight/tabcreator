import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeMic, RESUME_TIMEOUT_MS } from '../../src/audio/fake-mic';

// jsdom has no Web Audio or media devices: these stubs stand in for them so the start-up path
// (no user gesture, then a retry) can be driven with fake timers.

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  /** What the next context's resume() does. */
  static resumeMode: 'never' | 'run' = 'never';
  state: AudioContextState = 'suspended';
  closed = false;
  resumeCalled = false;
  started = false;
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  resume(): Promise<void> {
    this.resumeCalled = true;
    if (FakeAudioContext.resumeMode === 'never') return new Promise<void>(() => {});
    this.state = 'running';
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed = true;
    this.state = 'closed';
    return Promise.resolve();
  }
  decodeAudioData() {
    return Promise.resolve({});
  }
  createMediaStreamDestination() {
    return {
      channelCount: 2,
      stream: { getAudioTracks: () => [{ clone: () => ({ kind: 'audio' }) }] },
    };
  }
  createBufferSource() {
    return {
      buffer: null,
      connect: () => {},
      start: () => {
        this.started = true;
      },
    };
  }
}

class FakeMediaStream {
  constructor(public tracks: unknown[]) {}
}

/** Lets real I/O (the lazy fixture import) and promise chains run without advancing timers. */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000; // Date is not faked
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(condition()).toBe(true);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeAudioContext.instances = [];
  FakeAudioContext.resumeMode = 'never';
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fetchMock = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('MediaStream', FakeMediaStream);
  Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'mediaDevices');
});

describe('fake mic start-up', () => {
  it('rejects NotAllowedError when audio cannot start without a gesture, then retries', async () => {
    installFakeMic('bend_up');
    const first = navigator.mediaDevices.getUserMedia({ audio: true }).then(
      () => null,
      (err: unknown) => err,
    );
    await until(() => FakeAudioContext.instances[0]?.resumeCalled === true);
    const ctx = FakeAudioContext.instances[0]!;

    let settled = false;
    void first.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(RESUME_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = await first;
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('NotAllowedError');
    expect(ctx.closed).toBe(true);
    expect(ctx.started).toBe(false);

    // The failed start is not cached: the next call builds a new context and succeeds.
    FakeAudioContext.resumeMode = 'run';
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    expect(FakeAudioContext.instances).toHaveLength(2);
    const retry = FakeAudioContext.instances[1]!;
    expect(retry.state).toBe('running');
    expect(retry.started).toBe(true);
    expect(retry.closed).toBe(false);
    expect(stream).toBeInstanceOf(FakeMediaStream);
    expect((stream as unknown as FakeMediaStream).tracks).toEqual([{ kind: 'audio' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
