import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeDevice,
  ANALYSER_FFT_SIZE,
  listMics,
  micErrorCode,
  micPermission,
  onDeviceChange,
  openInput,
  requestMic,
} from '../../src/audio/mic';
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

function fakeStream(settings: MediaTrackSettings = {}, label = '') {
  const track = Object.assign(new EventTarget(), {
    stop: vi.fn(),
    readyState: 'live' as MediaStreamTrackState,
    label,
    getSettings: () => settings,
  });
  /** Ends the track on its own, as a revoke or unplug does. */
  const end = () => {
    track.readyState = 'ended';
    track.dispatchEvent(new Event('ended'));
  };
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, track, end };
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

const permissionsDescriptor = Object.getOwnPropertyDescriptor(navigator, 'permissions');

afterEach(() => {
  vi.unstubAllGlobals();
  if (permissionsDescriptor) Object.defineProperty(navigator, 'permissions', permissionsDescriptor);
  else delete (navigator as { permissions?: unknown }).permissions;
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

  it.each([
    ['NotAllowedError', 'mic-denied'],
    ['SecurityError', 'mic-denied'],
    ['NotFoundError', 'mic-no-device'],
    ['OverconstrainedError', 'mic-no-device'],
    ['NotReadableError', 'mic-in-use'],
    ['AbortError', 'mic-in-use'],
    ['TypeError', 'mic-failed'],
    ['SomethingNew', 'mic-failed'],
  ])('rejects %s as AppError %s carrying the cause', async (name, code) => {
    const cause = new DOMException('no', name);
    stubGetUserMedia(() => Promise.reject(cause));
    const err = await requestMic().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
    expect((err as AppError).cause).toBe(cause);
  });
});

describe('listMics', () => {
  const info = (kind: MediaDeviceKind, deviceId: string, label = '', groupId = '') =>
    ({ kind, deviceId, label, groupId }) as MediaDeviceInfo;

  function stubEnumerate(impl: () => Promise<MediaDeviceInfo[]>) {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { enumerateDevices: vi.fn(impl) },
      configurable: true,
    });
  }

  it('keeps audio inputs with a real id, without the default and communications aliases', async () => {
    stubEnumerate(() =>
      Promise.resolve([
        info('audioinput', 'default', 'Default - USB', 'g1'),
        info('audioinput', 'communications', 'Communications - USB', 'g1'),
        info('audioinput', 'usb', 'USB', 'g1'),
        info('audiooutput', 'spk', 'Speakers', 'g2'),
        info('videoinput', 'cam', 'Camera', 'g3'),
        info('audioinput', '', '', ''),
        info('audioinput', 'builtin', 'Built-in', 'g4'),
      ]),
    );
    await expect(listMics()).resolves.toEqual([
      { deviceId: 'usb', label: 'USB', groupId: 'g1' },
      { deviceId: 'builtin', label: 'Built-in', groupId: 'g4' },
    ]);
  });

  it('is empty when enumerateDevices rejects', async () => {
    stubEnumerate(() => Promise.reject(new Error('no')));
    await expect(listMics()).resolves.toEqual([]);
  });
});

describe('onDeviceChange', () => {
  it('calls the listener on each devicechange until unsubscribed', () => {
    const target = new EventTarget();
    Object.defineProperty(navigator, 'mediaDevices', { value: target, configurable: true });
    const listener = vi.fn();
    const stop = onDeviceChange(listener);
    target.dispatchEvent(new Event('devicechange'));
    target.dispatchEvent(new Event('devicechange'));
    stop();
    target.dispatchEvent(new Event('devicechange'));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('activeDevice', () => {
  const usb = { deviceId: 'usb', label: 'USB', groupId: 'g1' };
  const builtin = { deviceId: 'builtin', label: 'Built-in', groupId: 'g2' };

  it('matches the track device id first, then its group, else null', () => {
    expect(activeDevice({ deviceId: 'builtin', groupId: 'g1' }, [usb, builtin])).toBe(builtin);
    expect(activeDevice({ deviceId: 'default', groupId: 'g1' }, [usb, builtin])).toBe(usb);
    expect(activeDevice({ deviceId: 'default', groupId: null }, [usb, builtin])).toBeNull();
    expect(activeDevice({ deviceId: null, groupId: 'g9' }, [usb])).toBeNull();
  });
});

describe('micErrorCode', () => {
  it('maps by name, whatever the error class', () => {
    expect(micErrorCode(new TypeError('x'))).toBe('mic-failed');
    expect(micErrorCode({ name: 'OverconstrainedError', constraint: 'deviceId' })).toBe(
      'mic-no-device',
    );
    expect(micErrorCode('NotAllowedError')).toBe('mic-failed');
    expect(micErrorCode(null)).toBe('mic-failed');
    expect(micErrorCode({ name: 'toString' })).toBe('mic-failed');
  });
});

describe('micPermission', () => {
  function stubPermissions(query: (d: PermissionDescriptor) => Promise<unknown>) {
    const fn = vi.fn(query);
    Object.defineProperty(navigator, 'permissions', { value: { query: fn }, configurable: true });
    return fn;
  }

  it.each(['granted', 'prompt', 'denied'] as const)('reports %s', async (state) => {
    const query = stubPermissions(() => Promise.resolve({ state }));
    await expect(micPermission()).resolves.toBe(state);
    expect(query).toHaveBeenCalledWith({ name: 'microphone' });
  });

  it('reports unknown when the query rejects', async () => {
    stubPermissions(() => Promise.reject(new TypeError('microphone is not a valid name')));
    await expect(micPermission()).resolves.toBe('unknown');
  });

  it('reports unknown for an undefined state', async () => {
    stubPermissions(() => Promise.resolve({ state: 'weird' }));
    await expect(micPermission()).resolves.toBe('unknown');
  });

  it('reports unknown without the Permissions API', async () => {
    Object.defineProperty(navigator, 'permissions', { value: undefined, configurable: true });
    await expect(micPermission()).resolves.toBe('unknown');
  });
});

describe('openInput', () => {
  it('feeds the stream into one 4096-point analyser and reads its frame', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const { stream, track } = fakeStream();
    const input = openInput(stream);
    const ctx = FakeAudioContext.last!;
    expect(input.analyser).toBe(ctx.analyser);
    expect(ctx.analyser.fftSize).toBe(ANALYSER_FFT_SIZE);
    expect(ANALYSER_FFT_SIZE).toBe(4096);
    expect(ctx.analyser.connectedFrom).toBe(ctx);

    expect(input.readFrame().every((v) => v === 0)).toBe(true);
    ctx.analyser.frameValue = -0.5;
    const frame = input.readFrame();
    expect(frame).toHaveLength(ANALYSER_FFT_SIZE);
    expect(frame[0]).toBe(-0.5);

    input.close();
    expect(track.stop).toHaveBeenCalled();
    expect(ctx.closed).toBe(true);
  });

  it('reports the live track device id, group, label and sample rate', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const { stream } = fakeStream({ deviceId: 'usb', groupId: 'g1', sampleRate: 16000 }, 'USB');
    expect(openInput(stream)).toMatchObject({
      deviceId: 'usb',
      groupId: 'g1',
      label: 'USB',
      sampleRate: 16000,
    });
    const bare = openInput(fakeStream().stream);
    expect(bare).toMatchObject({ deviceId: null, groupId: null, label: '', sampleRate: null });
    expect(openInput(fakeStream({ sampleRate: 0 }).stream).sampleRate).toBeNull();
    const odd = { sampleRate: '48000' } as unknown as MediaTrackSettings;
    expect(openInput(fakeStream(odd).stream).sampleRate).toBeNull();
  });

  it('calls onEnded once with mic-lost when a track ends on its own', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const { stream, end } = fakeStream();
    const onEnded = vi.fn();
    openInput(stream, onEnded);
    end();
    end();
    expect(onEnded).toHaveBeenCalledTimes(1);
    const error = onEnded.mock.calls[0]?.[0] as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('mic-lost');
  });

  it('does not call onEnded for a track ended after close', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const { stream, end } = fakeStream();
    const onEnded = vi.fn();
    openInput(stream, onEnded).close();
    end();
    expect(onEnded).not.toHaveBeenCalled();
  });

  it('reports a track that had already ended', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const { stream, track } = fakeStream();
    track.readyState = 'ended';
    const onEnded = vi.fn();
    openInput(stream, onEnded);
    await Promise.resolve();
    expect(onEnded).toHaveBeenCalledTimes(1);
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
