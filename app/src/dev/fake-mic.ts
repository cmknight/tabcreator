// Dev/test-only fake microphone (stories US-0.4, 2.2). `main.tsx` loads this module only inside
// an `import.meta.env.DEV` branch when the URL has `?fakeMic=<fixture>[,<fixture>…]`, so
// production builds never contain it. Each fixture from testdata/synth/ is one fake input device,
// and the returned controls (exposed as `window.__fakeMic`) simulate device loss, revoked access,
// getUserMedia failures and low-quality inputs.

import { resumeWithin } from '../audio/context-resume';

/** Fixture WAV URLs, keyed by fixture name. Lazy: nothing is fetched until it is needed. */
const FIXTURES: Record<string, () => Promise<string>> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>('../../../testdata/synth/*.wav', { query: '?url', import: 'default' }),
  ).map(([path, load]) => [path.replace(/^.*\/|\.wav$/g, ''), load]),
);

const DEFAULT_SAMPLE_RATE = 48_000;
/** How long to wait for the AudioContext to start before giving up (no user gesture yet). */
export const RESUME_TIMEOUT_MS = 2000;

/** Per-device overrides; they apply to streams opened afterwards. */
export interface FakeMicDeviceOptions {
  /** The sample rate the device's streams run at and report in `getSettings()`. */
  sampleRate?: number;
  /** The device label in `enumerateDevices()` and on its tracks. */
  label?: string;
}

/** Test hooks returned by `installFakeMic`; dev builds expose them as `window.__fakeMic`. */
export interface FakeMicControls {
  /**
   * Removes the device from the list, ends each of its live tracks (`readyState` `ended` plus an
   * `ended` event), then fires one `devicechange`. Throws on an unknown id.
   */
  unplug(deviceId: string): void;
  /** Ends every live track as `unplug` does; devices stay listed and later calls work. */
  revoke(): void;
  /** Makes the next `getUserMedia` call (only) reject with a `DOMException` named `name`. */
  failNext(name: string, message?: string): void;
  /** Overrides a device's sample rate or label; a label change fires `devicechange`. */
  configure(deviceId: string, options: FakeMicDeviceOptions): void;
}

declare global {
  interface Window {
    /** Dev-only fake mic hooks (story 2.2); set by `main.tsx` when `?fakeMic` is present. */
    __fakeMic?: FakeMicControls;
  }
}

interface Device {
  fixture: string;
  load: () => Promise<string>;
  deviceId: string;
  groupId: string;
  label: string;
  sampleRate: number;
  plugged: boolean;
}

interface LiveTrack {
  deviceId: string;
  end(): void;
}

/** Caches a promise under `key`, dropping it again if it rejects so the next call retries. */
function cached<K, V>(map: Map<K, Promise<V>>, key: K, make: () => Promise<V>): Promise<V> {
  let promise = map.get(key);
  if (!promise) {
    promise = make();
    map.set(key, promise);
    promise.catch(() => {
      if (map.get(key) === promise) map.delete(key);
    });
  }
  return promise;
}

function overconstrained(message: string): DOMException {
  if (typeof OverconstrainedError === 'function')
    return new OverconstrainedError('deviceId', message);
  return Object.assign(new DOMException(message, 'OverconstrainedError'), {
    constraint: 'deviceId',
  });
}

/** The ids in a `deviceId` constraint, and whether they are required (`exact`). */
function deviceIdConstraint(audio: boolean | MediaTrackConstraints): {
  ids: string[];
  exact: boolean;
} {
  const toIds = (value: string | readonly string[] | undefined): string[] =>
    value === undefined ? [] : typeof value === 'string' ? [value] : [...value];
  if (typeof audio !== 'object') return { ids: [], exact: false };
  const constraint = audio.deviceId;
  if (constraint === undefined || typeof constraint === 'string' || Array.isArray(constraint)) {
    return { ids: toIds(constraint), exact: false };
  }
  const { exact, ideal } = constraint as ConstrainDOMStringParameters;
  if (exact !== undefined) return { ids: toIds(exact), exact: true };
  return { ids: toIds(ideal), exact: false };
}

/**
 * Replaces `navigator.mediaDevices.getUserMedia` and `enumerateDevices` with one fake input
 * device per fixture, in list order: label "Fake mic: <fixture>", id `fake-mic-<fixture>`.
 * Unknown names are dropped and duplicates collapsed; with no devices left, `getUserMedia`
 * rejects with `NotFoundError`. A `deviceId` constraint picks the device (`exact` ids that are
 * not listed reject with `OverconstrainedError`; `ideal` ones fall back to the first device).
 * Every stream plays its fixture once from the start, then silence. Without a user gesture (or
 * Chromium's `--autoplay-policy=no-user-gesture-required`) the audio cannot start, and
 * `getUserMedia` rejects with `NotAllowedError`; a later call retries.
 */
export function installFakeMic(fixtures: string[]): FakeMicControls {
  const mediaDevices = navigator.mediaDevices;
  const devices: Device[] = [];
  for (const fixture of new Set(fixtures)) {
    const load = Object.hasOwn(FIXTURES, fixture) ? FIXTURES[fixture] : undefined;
    if (!load) continue;
    devices.push({
      fixture,
      load,
      deviceId: `fake-mic-${fixture}`,
      groupId: `fake-mic-group-${fixture}`,
      label: `Fake mic: ${fixture}`,
      sampleRate: DEFAULT_SAMPLE_RATE,
      plugged: true,
    });
  }

  /** One context per sample rate, shared by every stream at that rate. */
  const contexts = new Map<number, AudioContext>();
  /** Resolves once the context for a sample rate is running. */
  const running = new Map<number, Promise<void>>();
  /** Decoded fixtures, keyed `<sampleRate>:<fixture>`. */
  const buffers = new Map<string, Promise<AudioBuffer>>();
  const live = new Set<LiveTrack>();
  let pendingFailure: DOMException | null = null;

  function findDevice(deviceId: string): Device {
    const device = devices.find((d) => d.deviceId === deviceId);
    if (!device) throw new Error(`Fake mic: no device ${deviceId}`);
    return device;
  }

  function dropContext(rate: number, ctx: AudioContext): void {
    if (contexts.get(rate) !== ctx) return;
    contexts.delete(rate);
    running.delete(rate);
    for (const key of [...buffers.keys()]) {
      if (key.startsWith(`${rate}:`)) buffers.delete(key);
    }
    ctx.close().catch(() => {});
  }

  async function decode(device: Device, ctx: AudioContext): Promise<AudioBuffer> {
    const response = await fetch(await device.load());
    if (!response.ok) {
      throw new Error(`fake mic: fetching ${device.fixture} failed (${response.status})`);
    }
    return ctx.decodeAudioData(await response.arrayBuffer());
  }

  async function resume(ctx: AudioContext): Promise<void> {
    if (!(await resumeWithin(ctx, RESUME_TIMEOUT_MS))) {
      throw new DOMException('Fake mic needs a user gesture to start audio', 'NotAllowedError');
    }
  }

  /** The running context and decoded fixture for a device at its current sample rate. */
  async function prepare(device: Device): Promise<{ ctx: AudioContext; buffer: AudioBuffer }> {
    const rate = device.sampleRate;
    let ctx = contexts.get(rate);
    if (!ctx) {
      ctx = new AudioContext({ sampleRate: rate });
      contexts.set(rate, ctx);
    }
    const context = ctx;
    try {
      const buffer = await cached(buffers, `${rate}:${device.fixture}`, () =>
        decode(device, context),
      );
      await cached(running, rate, () => resume(context));
      return { ctx: context, buffer };
    } catch (err) {
      // A context that never started is not kept, so the next call starts afresh.
      if (context.state !== 'running') dropContext(rate, context);
      throw err;
    }
  }

  function pickDevice(audio: boolean | MediaTrackConstraints): Device {
    const listed = devices.filter((d) => d.plugged);
    const { ids, exact } = deviceIdConstraint(audio);
    const match = ids.map((id) => listed.find((d) => d.deviceId === id)).find((d) => d);
    if (match) return match;
    if (exact) throw overconstrained(`Fake mic: no device ${ids.join(', ')}`);
    const first = listed[0];
    if (!first) throw new DOMException('Fake mic: no device', 'NotFoundError');
    return first;
  }

  /** Starts the fixture from its beginning on a new track carrying the device's settings. */
  function openTrack(device: Device, ctx: AudioContext, buffer: AudioBuffer): MediaStreamTrack {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 1;
    source.connect(dest);
    source.start(0);

    const track = dest.stream.getAudioTracks()[0];
    if (!track) throw new Error('fake mic: destination has no audio track');
    const { deviceId, groupId, label } = device;
    // The rate the audio actually runs at, even if `configure` changed the device meanwhile.
    const sampleRate = ctx.sampleRate;
    const nativeStop = track.stop.bind(track);
    const nativeGetSettings = track.getSettings.bind(track);
    const entry: LiveTrack = {
      deviceId,
      end() {
        release();
        nativeStop();
        track.dispatchEvent(new Event('ended'));
      },
    };
    function release(): void {
      if (!live.delete(entry)) return;
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
      source.disconnect();
    }
    Object.defineProperties(track, {
      label: { get: () => label, configurable: true },
      getSettings: {
        value: (): MediaTrackSettings => ({
          ...nativeGetSettings(),
          deviceId,
          groupId,
          sampleRate,
          channelCount: 1,
        }),
        configurable: true,
      },
      // A track the app stops itself does not fire `ended`, as with a real device.
      stop: {
        value: () => {
          release();
          nativeStop();
        },
        configurable: true,
      },
    });
    live.add(entry);
    return track;
  }

  const getUserMedia = async (constraints?: MediaStreamConstraints): Promise<MediaStream> => {
    if (pendingFailure) {
      const failure = pendingFailure;
      pendingFailure = null;
      throw failure;
    }
    if (!constraints?.audio || constraints.video) {
      throw new DOMException('Fake mic: audio only', 'NotFoundError');
    }
    const device = pickDevice(constraints.audio);
    const { ctx, buffer } = await prepare(device);
    if (!device.plugged) {
      // Unplugged while the stream was starting.
      if (deviceIdConstraint(constraints.audio).exact) {
        throw overconstrained(`Fake mic: no device ${device.deviceId}`);
      }
      throw new DOMException('Fake mic: no device', 'NotFoundError');
    }
    return new MediaStream([openTrack(device, ctx, buffer)]);
  };

  const enumerateDevices = async (): Promise<MediaDeviceInfo[]> =>
    devices
      .filter((d) => d.plugged)
      .map((d) => {
        const info = {
          deviceId: d.deviceId,
          groupId: d.groupId,
          kind: 'audioinput' as const,
          label: d.label,
        };
        return { ...info, toJSON: () => info };
      });

  Object.defineProperty(mediaDevices, 'getUserMedia', { value: getUserMedia, configurable: true });
  Object.defineProperty(mediaDevices, 'enumerateDevices', {
    value: enumerateDevices,
    configurable: true,
  });

  const endTracks = (match: (track: LiveTrack) => boolean): void => {
    for (const track of [...live]) if (match(track)) track.end();
  };
  const deviceChange = (): void => void mediaDevices.dispatchEvent(new Event('devicechange'));

  return {
    unplug(deviceId) {
      const device = findDevice(deviceId);
      if (!device.plugged) return;
      device.plugged = false;
      endTracks((track) => track.deviceId === deviceId);
      deviceChange();
    },
    revoke() {
      endTracks(() => true);
    },
    failNext(name, message) {
      pendingFailure = new DOMException(message ?? `Fake mic: injected ${name}`, name);
    },
    configure(deviceId, options) {
      const device = findDevice(deviceId);
      if (options.sampleRate !== undefined) device.sampleRate = options.sampleRate;
      if (options.label !== undefined && options.label !== device.label) {
        device.label = options.label;
        if (device.plugged) deviceChange();
      }
    },
  };
}
