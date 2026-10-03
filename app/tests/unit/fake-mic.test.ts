import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeMic, RESUME_TIMEOUT_MS } from '../../src/dev/fake-mic';

// jsdom has no Web Audio or media devices: these stubs stand in for them so the start-up path
// (no user gesture, then a retry) can be driven with fake timers.

/** A patchable stand-in for MediaStreamTrack: an EventTarget whose only own field is `kind`. */
class FakeTrack extends EventTarget {
  kind = 'audio';
  #state: MediaStreamTrackState = 'live';
  get readyState(): MediaStreamTrackState {
    return this.#state;
  }
  stop(): void {
    this.#state = 'ended';
  }
  getSettings(): MediaTrackSettings {
    return { echoCancellation: false };
  }
}

class FakeSource {
  buffer: unknown = null;
  started = false;
  stopped = false;
  disconnected = false;
  constructor(private readonly ctx: FakeAudioContext) {}
  connect(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
  start(): void {
    this.started = true;
    this.ctx.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  /** What the next context's resume() does. */
  static resumeMode: 'never' | 'run' = 'never';
  state: AudioContextState = 'suspended';
  closed = false;
  resumeCalled = false;
  started = false;
  sampleRate: number;
  sources: FakeSource[] = [];
  constructor(options?: AudioContextOptions) {
    this.sampleRate = options?.sampleRate ?? 44_100;
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
    const track = new FakeTrack();
    return { channelCount: 2, stream: { getAudioTracks: () => [track] } };
  }
  createBufferSource() {
    const source = new FakeSource(this);
    this.sources.push(source);
    return source;
  }
}

class FakeMediaStream {
  constructor(public tracks: MediaStreamTrack[]) {}
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
  Object.defineProperty(navigator, 'mediaDevices', {
    value: new EventTarget(),
    configurable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'mediaDevices');
});

describe('fake mic start-up', () => {
  it('rejects NotAllowedError when audio cannot start without a gesture, then retries', async () => {
    installFakeMic(['bend_up']);
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
    expect((stream as unknown as FakeMediaStream).tracks.map((t) => t.kind)).toEqual(['audio']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/** The single track of a stream returned by the fake mic. */
function trackOf(stream: MediaStream): MediaStreamTrack {
  const track = (stream as unknown as FakeMediaStream).tracks[0];
  if (!track) throw new Error('stream has no track');
  return track;
}

/** Resolves to the rejection of `promise`, or fails if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<DOMException> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DOMException);
  return err as DOMException;
}

const OPEN = 'fake-mic-open_strings';
const SILENCE = 'fake-mic-silence_60s';

describe('fake mic devices', () => {
  beforeEach(() => {
    FakeAudioContext.resumeMode = 'run';
  });

  it('lists one device per known fixture, in order, with duplicates and unknowns dropped', async () => {
    installFakeMic(['open_strings', 'open_strings', 'nope', 'silence_60s']);
    const devices = await navigator.mediaDevices.enumerateDevices();
    expect(devices.map(({ deviceId, kind, label }) => ({ deviceId, kind, label }))).toEqual([
      { deviceId: OPEN, kind: 'audioinput', label: 'Fake mic: open_strings' },
      { deviceId: SILENCE, kind: 'audioinput', label: 'Fake mic: silence_60s' },
    ]);
    expect(devices[0]!.groupId).not.toBe(devices[1]!.groupId);

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    expect(trackOf(stream).getSettings().deviceId).toBe(OPEN);
  });

  it('lists nothing and rejects NotFoundError when every fixture is unknown', async () => {
    installFakeMic(['nope', 'nope']);
    expect(await navigator.mediaDevices.enumerateDevices()).toEqual([]);
    const err = await rejection(navigator.mediaDevices.getUserMedia({ audio: true }));
    expect(err.name).toBe('NotFoundError');
  });

  it('honours exact deviceId constraints and rejects unknown ones with OverconstrainedError', async () => {
    installFakeMic(['open_strings', 'silence_60s']);
    const md = navigator.mediaDevices;
    const exact = await md.getUserMedia({ audio: { deviceId: { exact: SILENCE } } });
    expect(trackOf(exact).getSettings()).toMatchObject({
      deviceId: SILENCE,
      sampleRate: 48_000,
      channelCount: 1,
      echoCancellation: false,
    });
    expect(trackOf(exact).label).toBe('Fake mic: silence_60s');
    const list = await md.getUserMedia({ audio: { deviceId: { exact: ['nope', SILENCE] } } });
    expect(trackOf(list).getSettings().deviceId).toBe(SILENCE);

    const err = await rejection(md.getUserMedia({ audio: { deviceId: { exact: 'nope' } } }));
    expect(err.name).toBe('OverconstrainedError');
    expect((err as OverconstrainedError).constraint).toBe('deviceId');
  });

  it('treats bare and ideal deviceIds as preferences', async () => {
    installFakeMic(['open_strings', 'silence_60s']);
    const md = navigator.mediaDevices;
    const id = async (audio: MediaTrackConstraints) =>
      trackOf(await md.getUserMedia({ audio })).getSettings().deviceId;
    expect(await id({ deviceId: SILENCE })).toBe(SILENCE);
    expect(await id({ deviceId: ['nope', SILENCE] })).toBe(SILENCE);
    expect(await id({ deviceId: { ideal: SILENCE } })).toBe(SILENCE);
    expect(await id({ deviceId: 'nope' })).toBe(OPEN);
    expect(await id({ deviceId: { ideal: ['nope'] } })).toBe(OPEN);
  });

  it('starts each stream on a new source from the start of the fixture', async () => {
    installFakeMic(['open_strings']);
    await navigator.mediaDevices.getUserMedia({ audio: true });
    await navigator.mediaDevices.getUserMedia({ audio: true });
    expect(FakeAudioContext.instances).toHaveLength(1);
    const sources = FakeAudioContext.instances[0]!.sources;
    expect(sources).toHaveLength(2);
    expect(sources.every((s) => s.started)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('fake mic hooks', () => {
  beforeEach(() => {
    FakeAudioContext.resumeMode = 'run';
  });

  it('failNext rejects the next call only', async () => {
    const controls = installFakeMic(['open_strings']);
    controls.failNext('NotReadableError', 'busy');
    const err = await rejection(navigator.mediaDevices.getUserMedia({ audio: true }));
    expect(err.name).toBe('NotReadableError');
    expect(err.message).toBe('busy');
    await expect(navigator.mediaDevices.getUserMedia({ audio: true })).resolves.toBeInstanceOf(
      FakeMediaStream,
    );
  });

  it('unplug ends the device tracks, drops the device and fires devicechange', async () => {
    const controls = installFakeMic(['open_strings', 'silence_60s']);
    const md = navigator.mediaDevices;
    const open = trackOf(await md.getUserMedia({ audio: { deviceId: { exact: OPEN } } }));
    const silence = trackOf(await md.getUserMedia({ audio: { deviceId: { exact: SILENCE } } }));
    const ended = vi.fn();
    open.addEventListener('ended', ended);
    const silenceEnded = vi.fn();
    silence.addEventListener('ended', silenceEnded);
    const changed = vi.fn();
    md.addEventListener('devicechange', changed);

    controls.unplug(OPEN);

    expect(open.readyState).toBe('ended');
    expect(ended).toHaveBeenCalledTimes(1);
    expect(silence.readyState).toBe('live');
    expect(silenceEnded).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(1);
    expect((await md.enumerateDevices()).map((d) => d.deviceId)).toEqual([SILENCE]);
    const source = FakeAudioContext.instances[0]!.sources[0]!;
    expect(source.stopped && source.disconnected).toBe(true);

    const err = await rejection(md.getUserMedia({ audio: { deviceId: { exact: OPEN } } }));
    expect(err.name).toBe('OverconstrainedError');
    expect(trackOf(await md.getUserMedia({ audio: true })).getSettings().deviceId).toBe(SILENCE);
    expect(() => controls.unplug('nope')).toThrow(Error);
  });

  it('rejects a pending open whose device is unplugged before it resolves', async () => {
    const controls = installFakeMic(['open_strings', 'silence_60s']);
    const md = navigator.mediaDevices;
    const exact = rejection(md.getUserMedia({ audio: { deviceId: { exact: OPEN } } }));
    const fallback = rejection(md.getUserMedia({ audio: true }));
    controls.unplug(OPEN);
    expect((await exact).name).toBe('OverconstrainedError');
    expect((await fallback).name).toBe('NotFoundError');
    expect(FakeAudioContext.instances[0]!.sources).toHaveLength(0);
  });

  it('revoke ends live tracks but not tracks the app stopped, and keeps the devices', async () => {
    const controls = installFakeMic(['open_strings']);
    const md = navigator.mediaDevices;
    const stopped = trackOf(await md.getUserMedia({ audio: true }));
    const running = trackOf(await md.getUserMedia({ audio: true }));
    const stoppedEnded = vi.fn();
    stopped.addEventListener('ended', stoppedEnded);
    const runningEnded = vi.fn();
    running.addEventListener('ended', runningEnded);

    stopped.stop();
    expect(stopped.readyState).toBe('ended');
    expect(stoppedEnded).not.toHaveBeenCalled();

    controls.revoke();
    expect(running.readyState).toBe('ended');
    expect(runningEnded).toHaveBeenCalledTimes(1);
    expect(stoppedEnded).not.toHaveBeenCalled();
    expect(await md.enumerateDevices()).toHaveLength(1);
    await expect(md.getUserMedia({ audio: true })).resolves.toBeInstanceOf(FakeMediaStream);
  });

  it('configure overrides sample rate and label for later streams', async () => {
    const controls = installFakeMic(['open_strings']);
    const md = navigator.mediaDevices;
    const before = trackOf(await md.getUserMedia({ audio: true }));
    const changed = vi.fn();
    md.addEventListener('devicechange', changed);

    controls.configure(OPEN, { sampleRate: 16_000, label: 'AirPods Pro' });

    expect(changed).toHaveBeenCalledTimes(1);
    expect((await md.enumerateDevices())[0]!.label).toBe('AirPods Pro');
    const after = trackOf(await md.getUserMedia({ audio: true }));
    expect(after.getSettings()).toMatchObject({ sampleRate: 16_000, deviceId: OPEN });
    expect(after.label).toBe('AirPods Pro');
    expect(FakeAudioContext.instances.map((c) => c.sampleRate)).toEqual([48_000, 16_000]);
    // Live streams keep their settings.
    expect(before.getSettings().sampleRate).toBe(48_000);
    expect(before.label).toBe('Fake mic: open_strings');

    controls.configure(OPEN, { sampleRate: 16_000 });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(() => controls.configure('nope', { label: 'x' })).toThrow(Error);
  });
});
