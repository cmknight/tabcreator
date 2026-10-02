import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANALYSER_FFT_SIZE, openInput, requestMic } from '../../src/audio/mic';
import { AppError } from '../../src/model/errors';

// jsdom has no media devices or Web Audio: these stubs stand in for them.

function stubGetUserMedia(impl: (c: MediaStreamConstraints) => Promise<MediaStream>) {
  const getUserMedia = vi.fn(impl);
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia },
    configurable: true,
  });
  return getUserMedia;
}

function fakeStream() {
  const track = { stop: vi.fn() };
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, track };
}

class FakeAnalyser {
  fftSize = 2048;
  frameValue = 0;
  connectedFrom: unknown = null;
  getFloatTimeDomainData(out: Float32Array) {
    out.fill(this.frameValue);
  }
}

class FakeAudioContext {
  static last: FakeAudioContext | null = null;
  static failSource = false;
  analyser = new FakeAnalyser();
  closed = false;
  constructor() {
    FakeAudioContext.last = this;
  }
  createAnalyser() {
    return this.analyser;
  }
  createMediaStreamSource() {
    if (FakeAudioContext.failSource) throw new Error('no source');
    return { connect: (node: FakeAnalyser) => (node.connectedFrom = this) };
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeAudioContext.failSource = false;
  FakeAudioContext.last = null;
});

describe('requestMic', () => {
  const OFF = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  };

  it('asks for the default device with all processing off', async () => {
    const { stream } = fakeStream();
    const gum = stubGetUserMedia(() => Promise.resolve(stream));
    await expect(requestMic()).resolves.toBe(stream);
    expect(gum).toHaveBeenCalledTimes(1);
    expect(gum.mock.calls[0]?.[0]).toStrictEqual({ audio: { deviceId: undefined, ...OFF } });
  });

  it('pins the device exactly when one is given', async () => {
    const gum = stubGetUserMedia(() => Promise.resolve(fakeStream().stream));
    await requestMic('dev1');
    expect(gum.mock.calls[0]?.[0]).toStrictEqual({
      audio: { deviceId: { exact: 'dev1' }, ...OFF },
    });
  });

  it('rejects with AppError mic-failed carrying the cause', async () => {
    const cause = new DOMException('no', 'NotAllowedError');
    stubGetUserMedia(() => Promise.reject(cause));
    const err = await requestMic().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('mic-failed');
    expect((err as AppError).cause).toBe(cause);
  });
});

describe('openInput', () => {
  it('feeds the stream into one 4096-point analyser and reads linear RMS', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const { stream, track } = fakeStream();
    const input = openInput(stream);
    const ctx = FakeAudioContext.last!;
    expect(input.analyser).toBe(ctx.analyser);
    expect(ctx.analyser.fftSize).toBe(ANALYSER_FFT_SIZE);
    expect(ANALYSER_FFT_SIZE).toBe(4096);
    expect(ctx.analyser.connectedFrom).toBe(ctx);

    expect(input.readRms()).toBe(0);
    ctx.analyser.frameValue = -0.5;
    expect(input.readRms()).toBeCloseTo(0.5, 6);

    input.close();
    expect(track.stop).toHaveBeenCalled();
    expect(ctx.closed).toBe(true);
  });

  it('stops the stream and throws mic-failed when the graph cannot be built', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    FakeAudioContext.failSource = true;
    const { stream, track } = fakeStream();
    expect(() => openInput(stream)).toThrow(expect.objectContaining({ code: 'mic-failed' }));
    expect(track.stop).toHaveBeenCalled();
    expect(FakeAudioContext.last!.closed).toBe(true);
  });
});
