import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/model/errors';
import { OPEN_STRING_HZ } from '../../src/audio/tuner';
import type { StringNo } from '../../src/model/types';
import type { OpenedInput } from '../../src/session/input-derivation';
import { createRecordingSession, type RecordingDeps } from '../../src/session/recording-session';

const stream = {} as MediaStream;
const RATE = 48_000;
/** The tuner reads only the analyser's context sample rate. */
const analyser = { context: { sampleRate: RATE } } as unknown as AnalyserNode;
/** The frame the fake input returns; tests fill it per reading. */
let frame = new Float32Array(4096);
const SILENT = { peakDb: -Infinity, rmsDb: -Infinity };
/**
 * The device and input quality fields of a snapshot when no device is listed and the input is
 * fine (and always outside `live`, before any Dismiss).
 */
const IDLE = {
  devices: [],
  activeDeviceId: null,
  inputQualityPoor: false,
  inputQualityDismissed: false,
  tunedStrings: [],
  recording: 'idle',
  activeTakeId: null,
  countIn: { on: false, bpm: 100 },
};

/** The prefs' analysis defaults the fakes return; `record()` copies them into the take. */
const ANALYSIS_DEFAULTS = { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 };
/** The capture method of an input no test records from. */
const noCapture = () => Promise.reject(new Error('not recording'));

/** The recording deps (storage, navigation, clock, ids) for tests that never record. */
function recordingFakes(): Pick<
  RecordingDeps,
  'createTake' | 'patchTake' | 'openRawWriter' | 'writeCompressed' | 'navigate' | 'now' | 'newId'
> {
  const unused = () => Promise.reject(new Error('not recording'));
  return {
    createTake: vi.fn(unused),
    patchTake: vi.fn(unused),
    openRawWriter: vi.fn(unused),
    writeCompressed: vi.fn(unused),
    navigate: vi.fn(),
    now: () => 0,
    newId: () => 'take-1',
  };
}

/** Lets pending promise callbacks and timers at 0 ms run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A constant frame at `amplitude`: peak and RMS both `20·log10(amplitude)`. */
function level(amplitude: number) {
  frame = new Float32Array(4096).fill(amplitude);
}

/** A sine frame at `cents` from open string `s` (−12 dBFS peak). */
function tone(s: StringNo, cents = 0) {
  const hz = OPEN_STRING_HZ[s] * 2 ** (cents / 1200);
  frame = new Float32Array(4096).map((_, i) => 0.25 * Math.sin((2 * Math.PI * hz * i) / RATE));
}

/** Reads the tuner every 50 ms from `from` up to and including `to`; returns the last reading. */
function tuneEvery(
  session: { readTuner(now: number): unknown },
  from: number,
  to: number,
): unknown {
  for (let t = from; t < to; t += 50) session.readTuner(t);
  return session.readTuner(to);
}

/** Reads levels every 16 ms from `from` up to and including `to`, as the meter's frames do. */
function readEvery(session: { readLevels(now: number): unknown }, from: number, to: number) {
  for (let t = from; t < to; t += 16) session.readLevels(t);
  session.readLevels(to);
}

function setup(overrides: Partial<RecordingDeps> = {}) {
  frame = new Float32Array(4096);
  const input = {
    analyser,
    readFrame: vi.fn(() => frame),
    clock: () => 0,
    clicks: () => () => {},
    capture: vi.fn<OpenedInput['capture']>(noCapture),
    close: vi.fn(),
    deviceId: null,
    groupId: null,
    label: '',
    sampleRate: null,
  };
  let onEnded: ((error: AppError) => void) | null = null;
  const deps = {
    requestMic: vi.fn(() => Promise.resolve(stream)),
    openInput: vi.fn((_stream: MediaStream, ended: (error: AppError) => void) => {
      onEnded = ended;
      return input;
    }),
    listMics: vi.fn<RecordingDeps['listMics']>(() => Promise.resolve([])),
    onDeviceChange: vi.fn<RecordingDeps['onDeviceChange']>(() => () => {}),
    updatePrefs: vi.fn(),
    loadPrefs: vi.fn<RecordingDeps['loadPrefs']>(() => ({
      analysisDefaults: ANALYSIS_DEFAULTS,
      micGranted: false,
    })),
    micPermission: vi.fn<RecordingDeps['micPermission']>(() => Promise.resolve('prompt')),
    ...recordingFakes(),
    ...overrides,
  };
  const session = createRecordingSession(deps);
  const listener = vi.fn();
  session.subscribe(listener);
  /** Ends the live track on its own, as audio/ reports it, and lets the store react. */
  const endTrack = async () => {
    onEnded?.(new AppError('mic-lost', 'ended'));
    await flush();
  };
  return { session, deps, input, listener, endTrack };
}

describe('recording session', () => {
  it('starts in setup without touching the mic', () => {
    const { session, deps } = setup();
    expect(session.getSnapshot()).toEqual({ mic: 'setup', levelWarning: null, ...IDLE });
    expect(session.readLevels(0)).toEqual(SILENT);
    expect(session.getAnalyser()).toBeNull();
    expect(deps.requestMic).not.toHaveBeenCalled();
  });

  it('goes setup → requesting → live, opens the input and records micGranted', async () => {
    const { session, deps, listener } = setup();
    const done = session.allowMic();
    expect(session.getSnapshot()).toEqual({ mic: 'requesting', levelWarning: null, ...IDLE });
    await done;
    expect(session.getSnapshot()).toEqual({ mic: 'live', levelWarning: null, ...IDLE });
    expect(deps.requestMic).toHaveBeenCalledTimes(1);
    expect(deps.openInput).toHaveBeenCalledWith(stream, expect.any(Function));
    expect(deps.updatePrefs).toHaveBeenCalledWith({ micGranted: true });
    level(0.25);
    expect(session.readLevels(0).rmsDb).toBeCloseTo(20 * Math.log10(0.25), 6);
    expect(session.getAnalyser()).toBe(analyser);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('requests once even when Allow is clicked again while requesting or live', async () => {
    const { session, deps } = setup();
    const first = session.allowMic();
    await session.allowMic();
    await first;
    await session.allowMic();
    expect(deps.requestMic).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().mic).toBe('live');
  });

  it('maps a non-AppError rejection to mic-failed, and Try again retries once', async () => {
    const requestMic = vi
      .fn<RecordingDeps['requestMic']>()
      .mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
      .mockResolvedValueOnce(stream);
    const { session, deps } = setup({ requestMic });
    await session.allowMic();
    expect(session.getSnapshot()).toEqual({
      mic: 'error',
      errorCode: 'mic-failed',
      levelWarning: null,
      ...IDLE,
    });
    expect(deps.updatePrefs).not.toHaveBeenCalled();
    expect(session.readLevels(0)).toEqual(SILENT);

    const retry = session.allowMic();
    // The error card stays in place while the retry runs.
    expect(session.getSnapshot()).toEqual({
      mic: 'requesting',
      errorCode: 'mic-failed',
      levelWarning: null,
      ...IDLE,
    });
    await retry;
    expect(requestMic).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot()).toEqual({ mic: 'live', levelWarning: null, ...IDLE });
  });

  it.each(['mic-denied', 'mic-no-device', 'mic-in-use', 'mic-failed'] as const)(
    'keeps %s from audio/ and never retries by itself',
    async (code) => {
      vi.useFakeTimers();
      try {
        const requestMic = vi.fn(() => Promise.reject(new AppError(code, 'gum')));
        const { session } = setup({ requestMic });
        await session.allowMic();
        expect(session.getSnapshot()).toEqual({
          mic: 'error',
          errorCode: code,
          levelWarning: null,
          ...IDLE,
        });
        await session.resume();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(requestMic).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("keeps an AppError's code from audio/", async () => {
    const { session } = setup({
      openInput: vi.fn(() => {
        throw new AppError('mic-failed', 'graph');
      }),
    });
    await session.allowMic();
    expect(session.getSnapshot()).toEqual({
      mic: 'error',
      errorCode: 'mic-failed',
      levelWarning: null,
      ...IDLE,
    });
  });

  it('stays live when saving micGranted fails', async () => {
    const { session } = setup({
      updatePrefs: vi.fn(() => {
        throw new AppError('storage-full', 'full');
      }),
    });
    await session.allowMic();
    expect(session.getSnapshot()).toEqual({ mic: 'live', levelWarning: null, ...IDLE });
  });

  it('closes the input, then shows mic-lost when the live track ends; Try again recovers', async () => {
    const { session, deps, input, endTrack } = setup();
    await session.allowMic();
    const order: string[] = [];
    input.close.mockImplementation(() => order.push('close'));
    session.subscribe(() => order.push(session.getSnapshot().mic));
    await endTrack();
    expect(order).toEqual(['close', 'error']);
    expect(session.getSnapshot()).toEqual({
      mic: 'error',
      errorCode: 'mic-lost',
      levelWarning: null,
      ...IDLE,
    });
    expect(session.readLevels(0)).toEqual(SILENT);
    expect(session.getAnalyser()).toBeNull();

    await session.allowMic();
    expect(deps.requestMic).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot()).toEqual({ mic: 'live', levelWarning: null, ...IDLE });
  });

  it('ignores an ended report from an input it no longer holds', async () => {
    const { session, input, endTrack } = setup();
    await session.allowMic();
    await endTrack();
    await endTrack();
    expect(input.close).toHaveBeenCalledTimes(1);
  });

  describe('resume', () => {
    it('requests once without a click when micGranted and the permission is granted', async () => {
      const { session, deps } = setup({
        loadPrefs: vi.fn(() => ({ analysisDefaults: ANALYSIS_DEFAULTS, micGranted: true })),
        micPermission: vi.fn(() => Promise.resolve('granted' as const)),
      });
      await Promise.all([session.resume(), session.resume()]);
      expect(deps.requestMic).toHaveBeenCalledTimes(1);
      expect(session.getSnapshot()).toEqual({ mic: 'live', levelWarning: null, ...IDLE });
      await session.resume();
      expect(deps.requestMic).toHaveBeenCalledTimes(1);
    });

    it.each(['prompt', 'denied', 'unknown'] as const)(
      'stays in setup when the permission is %s',
      async (state) => {
        const { session, deps } = setup({
          loadPrefs: vi.fn(() => ({ analysisDefaults: ANALYSIS_DEFAULTS, micGranted: true })),
          micPermission: vi.fn(() => Promise.resolve(state)),
        });
        await session.resume();
        expect(deps.requestMic).not.toHaveBeenCalled();
        expect(session.getSnapshot()).toEqual({ mic: 'setup', levelWarning: null, ...IDLE });
      },
    );

    it('stays in setup on a first visit without asking the browser', async () => {
      const { session, deps } = setup();
      await session.resume();
      expect(deps.micPermission).not.toHaveBeenCalled();
      expect(deps.requestMic).not.toHaveBeenCalled();
      expect(session.getSnapshot()).toEqual({ mic: 'setup', levelWarning: null, ...IDLE });
    });

    it('stays in setup when prefs cannot be read', async () => {
      const { session, deps } = setup({
        loadPrefs: vi.fn(() => {
          throw new Error('nope');
        }),
        micPermission: vi.fn(() => Promise.resolve('granted' as const)),
      });
      await session.resume();
      expect(deps.requestMic).not.toHaveBeenCalled();
    });

    it('does nothing when Allow was clicked while the permission check ran', async () => {
      let grant: (state: 'granted') => void = () => {};
      const { session, deps } = setup({
        loadPrefs: vi.fn(() => ({ analysisDefaults: ANALYSIS_DEFAULTS, micGranted: true })),
        micPermission: vi.fn(() => new Promise<'granted'>((r) => (grant = r))),
      });
      const resumed = session.resume();
      await Promise.resolve();
      await session.allowMic();
      grant('granted');
      await resumed;
      expect(deps.requestMic).toHaveBeenCalledTimes(1);
    });

    it('does not retry from mic-lost', async () => {
      const { session, deps, endTrack } = setup({
        loadPrefs: vi.fn(() => ({ analysisDefaults: ANALYSIS_DEFAULTS, micGranted: true })),
        micPermission: vi.fn(() => Promise.resolve('granted' as const)),
      });
      await session.resume();
      await endTrack();
      await session.resume();
      expect(deps.requestMic).toHaveBeenCalledTimes(1);
      expect(session.getSnapshot()).toEqual({
        mic: 'error',
        errorCode: 'mic-lost',
        levelWarning: null,
        ...IDLE,
      });
    });
  });

  describe('levels and warnings', () => {
    it('reads peak and RMS in dBFS from the input frame', async () => {
      const { session } = setup();
      await session.allowMic();
      expect(session.readLevels(0)).toEqual(SILENT);
      frame = new Float32Array(4096);
      frame[0] = 0.5;
      const { peakDb, rmsDb } = session.readLevels(10);
      expect(peakDb).toBeCloseTo(20 * Math.log10(0.5), 6);
      expect(rmsDb).toBeCloseTo(20 * Math.log10(Math.sqrt(0.25 / 4096)), 6);
    });

    it('sets Too loud at once, notifying once, and clears it 2 s after the last loud peak', async () => {
      const { session, listener } = setup();
      await session.allowMic();
      listener.mockClear();
      level(0.1); // −20 dBFS
      readEvery(session, 0, 984);
      expect(listener).not.toHaveBeenCalled();
      level(1);
      session.readLevels(1000);
      expect(session.getSnapshot().levelWarning).toBe('loud');
      level(0.1);
      for (let t = 1016; t < 2900; t += 16) session.readLevels(t);
      session.readLevels(2900);
      expect(session.getSnapshot().levelWarning).toBe('loud');
      expect(listener).toHaveBeenCalledTimes(1);
      session.readLevels(3000);
      expect(session.getSnapshot().levelWarning).toBeNull();
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('sets Too quiet after 3 s below −45 dBFS, then a loud peak replaces it', async () => {
      const { session } = setup();
      await session.allowMic();
      level(0); // silence
      readEvery(session, 0, 2900);
      expect(session.getSnapshot().levelWarning).toBeNull();
      session.readLevels(3000);
      expect(session.getSnapshot().levelWarning).toBe('quiet');
      frame = new Float32Array(4096);
      frame[0] = 1; // a loud peak with a quiet RMS
      session.readLevels(3100);
      expect(session.getSnapshot().levelWarning).toBe('loud');
    });

    it('starts afresh after a gap in reads: no stale warning, and Too quiet needs 3 s of new quiet', async () => {
      const { session, listener } = setup();
      await session.allowMic();
      level(0);
      readEvery(session, 0, 3000);
      expect(session.getSnapshot().levelWarning).toBe('quiet');
      listener.mockClear();
      // The meter was away for 10 s: the first read clears the old warning.
      session.readLevels(13_000);
      expect(session.getSnapshot().levelWarning).toBeNull();
      expect(listener).toHaveBeenCalledTimes(1);
      for (let t = 13_016; t < 16_000; t += 16) session.readLevels(t);
      expect(session.getSnapshot().levelWarning).toBeNull();
      session.readLevels(16_000);
      expect(session.getSnapshot().levelWarning).toBe('quiet');
    });

    it('drops a stale Too loud after a gap', async () => {
      const { session } = setup();
      await session.allowMic();
      level(1);
      session.readLevels(0);
      expect(session.getSnapshot().levelWarning).toBe('loud');
      level(0.1);
      session.readLevels(600);
      expect(session.getSnapshot().levelWarning).toBeNull();
    });

    it('clears the warning and starts afresh when the mic leaves live', async () => {
      const { session, endTrack } = setup();
      await session.allowMic();
      level(1);
      session.readLevels(0);
      expect(session.getSnapshot().levelWarning).toBe('loud');
      await endTrack();
      expect(session.getSnapshot()).toEqual({
        mic: 'error',
        errorCode: 'mic-lost',
        levelWarning: null,
        ...IDLE,
      });
      await session.allowMic();
      level(0.1);
      session.readLevels(100);
      expect(session.getSnapshot().levelWarning).toBeNull();
    });
  });

  describe('devices', () => {
    const A = { deviceId: 'a', label: 'Mic A', groupId: 'ga' };
    const B = { deviceId: 'b', label: 'Mic B', groupId: 'gb' };

    /**
     * A fake audio/ with listed devices: the default request opens the first listed device,
     * an exact id that is not listed rejects `mic-no-device`. Logs every call in order.
     */
    function devicesSetup(
      options: {
        listed?: (typeof A)[];
        saved?: string | null;
        /** Track sample rates by device id; 48 000 for any other. */
        rates?: Record<string, number>;
      } = {},
    ) {
      let listed = options.listed ?? [A, B];
      const rates = options.rates ?? {};
      let saved = options.saved ?? null;
      const log: string[] = [];
      const inputs: {
        deviceId: string;
        close: ReturnType<typeof vi.fn>;
        end: () => void;
      }[] = [];
      let deviceChange: (() => void) | null = null;
      const deps: RecordingDeps = {
        requestMic: vi.fn((deviceId?: string) => {
          log.push(`request ${deviceId ?? 'default'}`);
          const device = deviceId ? listed.find((d) => d.deviceId === deviceId) : listed[0];
          if (!device) return Promise.reject(new AppError('mic-no-device', 'gone'));
          return Promise.resolve({ id: device.deviceId } as unknown as MediaStream);
        }),
        openInput: vi.fn((s: MediaStream, ended: (error: AppError) => void) => {
          const deviceId = (s as unknown as { id: string }).id;
          const entry = {
            deviceId,
            close: vi.fn(() => log.push(`close ${deviceId}`)),
            end: () => ended(new AppError('mic-lost', 'ended')),
          };
          inputs.push(entry);
          return {
            analyser,
            readFrame: () => frame,
            clock: () => 0,
            clicks: () => () => {},
            capture: noCapture,
            close: entry.close,
            deviceId,
            groupId: `g${deviceId}`,
            label: `track ${deviceId}`,
            sampleRate: rates[deviceId] ?? 48_000,
          };
        }),
        listMics: vi.fn(() => Promise.resolve([...listed])),
        onDeviceChange: vi.fn((listener: () => void) => {
          deviceChange = listener;
          return () => {
            deviceChange = null;
          };
        }),
        updatePrefs: vi.fn((patch: { micDeviceId?: string | null }) => {
          if (patch.micDeviceId !== undefined) saved = patch.micDeviceId;
        }),
        loadPrefs: vi.fn(() => ({
          analysisDefaults: ANALYSIS_DEFAULTS,
          micGranted: true,
          micDeviceId: saved,
        })),
        micPermission: vi.fn(() => Promise.resolve('granted' as const)),
        ...recordingFakes(),
      };
      const session = createRecordingSession(deps);
      return {
        session,
        deps,
        log,
        inputs,
        saved: () => saved,
        /** Removes a device from the list, ends its live input and fires `devicechange`. */
        unplug: async (id: string) => {
          listed = listed.filter((d) => d.deviceId !== id);
          for (const input of inputs) if (input.deviceId === id) input.end();
          deviceChange?.();
          await flush();
        },
        /** Ends every input; the devices stay listed. */
        revoke: async () => {
          for (const input of inputs) input.end();
          await flush();
        },
        setListed: (next: (typeof A)[]) => (listed = next),
        fireDeviceChange: async () => {
          deviceChange?.();
          await flush();
        },
        hasDeviceChangeListener: () => deviceChange !== null,
      };
    }

    it('lists the devices with the live one active once live', async () => {
      const { session } = devicesSetup();
      await session.allowMic();
      expect(session.getSnapshot()).toMatchObject({
        mic: 'live',
        devices: [A, B],
        activeDeviceId: 'a',
      });
    });

    it('resolves a track reporting an unlisted id (Chrome default) by groupId', async () => {
      const { deps } = devicesSetup();
      deps.openInput = vi.fn(() => ({
        analyser,
        readFrame: () => frame,
        clock: () => 0,
        clicks: () => () => {},
        capture: noCapture,
        close: vi.fn(),
        deviceId: 'default',
        groupId: 'gb',
        label: 'Default - Mic B',
        sampleRate: 48_000,
      }));
      const s2 = createRecordingSession(deps);
      await s2.allowMic();
      expect(s2.getSnapshot().activeDeviceId).toBe('b');
    });

    it('switch: closes the old input before one exact request, then saves micDeviceId', async () => {
      const { session, deps, log, saved } = devicesSetup();
      await session.allowMic();
      log.length = 0;
      const switching = session.selectMic('b');
      // The select shows the choice while the new input opens.
      expect(session.getSnapshot()).toMatchObject({ mic: 'live', activeDeviceId: 'b' });
      await switching;
      expect(log).toEqual(['close a', 'request b']);
      expect(deps.requestMic).toHaveBeenLastCalledWith('b');
      expect(saved()).toBe('b');
      expect(session.getSnapshot()).toMatchObject({ mic: 'live', activeDeviceId: 'b' });
    });

    it('ignores choosing the active device, or choosing while not live', async () => {
      const { session, deps } = devicesSetup();
      await session.selectMic('b');
      expect(deps.requestMic).not.toHaveBeenCalled();
      await session.allowMic();
      await session.selectMic('a');
      expect(deps.requestMic).toHaveBeenCalledTimes(1);
    });

    it('a failed switch shows its error card and keeps the saved device', async () => {
      const { session, saved, setListed, deps } = devicesSetup({ saved: 'a' });
      await session.allowMic();
      setListed([A]);
      await session.selectMic('b');
      expect(session.getSnapshot()).toMatchObject({ mic: 'error', errorCode: 'mic-no-device' });
      expect(saved()).toBe('a');
      expect(deps.updatePrefs).not.toHaveBeenCalledWith({ micDeviceId: null });
    });

    it('a choice while a switch runs is ignored; one input ends live, the rest closed', async () => {
      const C = { deviceId: 'c', label: 'Mic C', groupId: 'gc' };
      const { session, deps, inputs } = devicesSetup({ listed: [A, B, C] });
      await session.allowMic();
      const request = vi.mocked(deps.requestMic);
      const real = request.getMockImplementation()!;
      let release: () => void = () => {};
      request.mockClear();
      request.mockImplementationOnce(
        (id) => new Promise((resolve) => (release = () => resolve(real(id)))),
      );
      const first = session.selectMic('b');
      await session.selectMic('c');
      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith('b');
      release();
      await first;
      expect(session.getSnapshot()).toMatchObject({ mic: 'live', activeDeviceId: 'b' });
      const open = inputs.filter((i) => i.close.mock.calls.length === 0);
      expect(open.map((i) => i.deviceId)).toEqual(['b']);
      expect(inputs.map((i) => i.deviceId)).toEqual(['a', 'b']);
    });

    it('remember: opening the mic uses the saved device', async () => {
      const { session, deps } = devicesSetup({ saved: 'b' });
      await session.resume();
      expect(deps.requestMic).toHaveBeenCalledTimes(1);
      expect(deps.requestMic).toHaveBeenCalledWith('b');
      expect(session.getSnapshot()).toMatchObject({ mic: 'live', activeDeviceId: 'b' });
    });

    it('saved device gone: opens the default and clears micDeviceId', async () => {
      const { session, log, saved, deps } = devicesSetup({ saved: 'gone' });
      await session.allowMic();
      expect(log).toEqual(['request gone', 'request default']);
      expect(saved()).toBeNull();
      expect(deps.updatePrefs).toHaveBeenCalledWith({ micDeviceId: null });
      expect(session.getSnapshot()).toMatchObject({ mic: 'live', activeDeviceId: 'a' });
    });

    it('saved device failing otherwise shows that error without a fallback', async () => {
      const { deps } = devicesSetup({ saved: 'b' });
      deps.requestMic = vi.fn(() => Promise.reject(new AppError('mic-in-use', 'busy')));
      const s2 = createRecordingSession(deps);
      await s2.allowMic();
      expect(deps.requestMic).toHaveBeenCalledTimes(1);
      expect(s2.getSnapshot()).toMatchObject({ mic: 'error', errorCode: 'mic-in-use' });
    });

    it('unplug of the active device with another left: opens the default and posts a notice', async () => {
      const { session, log, inputs, unplug, saved } = devicesSetup();
      await session.allowMic();
      await session.selectMic('b');
      log.length = 0;
      await unplug('b');
      expect(log).toEqual(['close b', 'request default']);
      expect(inputs.at(-1)?.close).not.toHaveBeenCalled();
      expect(session.getSnapshot()).toMatchObject({
        mic: 'live',
        devices: [A],
        activeDeviceId: 'a',
        notice: { kind: 'switched', label: 'Mic A', seq: 1 },
      });
      expect(session.getSnapshot().errorCode).toBeUndefined();
      // The chosen device stays saved, for when it is plugged back in.
      expect(saved()).toBe('b');
    });

    it('a second switch-over posts a new notice sequence number', async () => {
      const C = { deviceId: 'c', label: 'Mic C', groupId: 'gc' };
      const { session, unplug } = devicesSetup({ listed: [A, B, C] });
      await session.allowMic();
      await unplug('a');
      expect(session.getSnapshot().notice).toEqual({ kind: 'switched', label: 'Mic B', seq: 1 });
      await unplug('b');
      expect(session.getSnapshot().notice).toEqual({ kind: 'switched', label: 'Mic C', seq: 2 });
    });

    it('unplug of the only device shows the lost card, no notice', async () => {
      const { session, unplug, log } = devicesSetup({ listed: [A] });
      await session.allowMic();
      log.length = 0;
      await unplug('a');
      expect(log).toEqual(['close a']);
      expect(session.getSnapshot()).toEqual({
        mic: 'error',
        errorCode: 'mic-lost',
        levelWarning: null,
        ...IDLE,
      });
    });

    it('revoke (devices still listed) shows the lost card, no notice', async () => {
      const { session, revoke, log } = devicesSetup();
      await session.allowMic();
      log.length = 0;
      await revoke();
      expect(log).toEqual(['close a']);
      expect(session.getSnapshot()).toMatchObject({ mic: 'error', errorCode: 'mic-lost' });
      expect(session.getSnapshot().notice).toBeUndefined();
    });

    it('a failing fallback after an unplug shows that failure', async () => {
      const { session, deps, unplug } = devicesSetup();
      await session.allowMic();
      vi.mocked(deps.requestMic).mockRejectedValueOnce(new AppError('mic-in-use', 'busy'));
      await unplug('a');
      expect(session.getSnapshot()).toMatchObject({ mic: 'error', errorCode: 'mic-in-use' });
    });

    /** Live on an input whose track reports `deviceId`/`groupId`, resolving to nothing listed. */
    async function liveUnresolved(deviceId: string | null) {
      const setup = devicesSetup();
      setup.deps.openInput = vi.fn(() => ({
        analyser,
        readFrame: () => frame,
        clock: () => 0,
        clicks: () => () => {},
        capture: noCapture,
        close: vi.fn(),
        deviceId,
        groupId: null,
        label: '',
        sampleRate: null,
      }));
      const session = createRecordingSession(setup.deps);
      await session.allowMic();
      return { ...setup, session };
    }

    it.each([
      ['an unresolved id (Chrome default)', 'default'],
      ['no id', null],
    ])('a track with %s ending shows the lost card, not a switch', async (_what, id) => {
      const { session, deps } = await liveUnresolved(id);
      expect(session.getSnapshot()).toMatchObject({ mic: 'live', activeDeviceId: id });
      const ended = vi.mocked(deps.openInput).mock.calls[0]![1];
      ended(new AppError('mic-lost', 'ended'));
      await flush();
      expect(deps.requestMic).toHaveBeenCalledTimes(1);
      expect(session.getSnapshot()).toMatchObject({ mic: 'error', errorCode: 'mic-lost' });
      expect(session.getSnapshot().notice).toBeUndefined();
    });

    it('a fallback input that resolves to nothing clears the active id and has an empty label', async () => {
      const { session, deps, unplug } = devicesSetup();
      await session.allowMic();
      const opened = vi.mocked(deps.openInput).getMockImplementation()!;
      vi.mocked(deps.openInput).mockImplementationOnce((s, ended) => ({
        ...opened(s, ended),
        deviceId: null,
        groupId: null,
        label: '',
      }));
      await unplug('a');
      expect(session.getSnapshot()).toMatchObject({
        mic: 'live',
        activeDeviceId: null,
        notice: { kind: 'switched', label: '', seq: 1 },
      });
    });

    /** Live on 'a' with Too loud showing and string 6 In tune (ticked). */
    async function liveLoudAndInTune(setup: ReturnType<typeof devicesSetup>) {
      await setup.session.allowMic();
      level(1);
      setup.session.readLevels(0);
      expect(setup.session.getSnapshot().levelWarning).toBe('loud');
      tone(6);
      expect(tuneEvery(setup.session, 0, 500)).toMatchObject({ inTune: true });
      expect(setup.session.getSnapshot().tunedStrings).toEqual([6]);
    }

    /** After a reset, a silent read 50 ms later has no held reading and is not In tune. */
    function expectFreshTuner(session: { readTuner(now: number): unknown }) {
      level(0);
      expect(session.readTuner(550)).toEqual({ reading: null, held: false, inTune: false });
    }

    it('a live → live switch resets the level warning and the tuner; ticks are kept', async () => {
      const s = devicesSetup();
      await liveLoudAndInTune(s);
      await s.session.selectMic('b');
      expect(s.session.getSnapshot()).toMatchObject({
        mic: 'live',
        activeDeviceId: 'b',
        levelWarning: null,
        tunedStrings: [6],
      });
      expectFreshTuner(s.session);
    });

    it('an unplug fallback resets the level warning and the tuner; ticks are kept', async () => {
      const s = devicesSetup();
      await liveLoudAndInTune(s);
      await s.unplug('a');
      expect(s.session.getSnapshot()).toMatchObject({
        mic: 'live',
        activeDeviceId: 'b',
        levelWarning: null,
        tunedStrings: [6],
        notice: { kind: 'switched', label: 'Mic B', seq: 1 },
      });
      expectFreshTuner(s.session);
    });

    describe('one notify per transition, carrying quality and ticks', () => {
      const HEADSET = { deviceId: 'h', label: 'AirPods Pro (Hands-Free)', groupId: 'gh' };

      /** Live on the headset (poor) with string 6 ticked; records each notified snapshot. */
      async function liveWatched() {
        const s = devicesSetup({ listed: [HEADSET, A] });
        await s.session.allowMic();
        tone(6);
        tuneEvery(s.session, 0, 500);
        const seen: ReturnType<typeof s.session.getSnapshot>[] = [];
        s.session.subscribe(() => seen.push(s.session.getSnapshot()));
        return { ...s, seen };
      }

      it('allow: requesting, then live, one notify each', async () => {
        const s = devicesSetup({ listed: [HEADSET, A] });
        const seen: ReturnType<typeof s.session.getSnapshot>[] = [];
        s.session.subscribe(() => seen.push(s.session.getSnapshot()));
        await s.session.allowMic();
        expect(seen.map((x) => x.mic)).toEqual(['requesting', 'live']);
        expect(seen[1]).toMatchObject({
          devices: [HEADSET, A],
          activeDeviceId: 'h',
          levelWarning: null,
          inputQualityPoor: true,
          tunedStrings: [],
        });
      });

      it('switch: the pending choice, then live, one notify each', async () => {
        const { session, seen } = await liveWatched();
        await session.selectMic('a');
        expect(seen).toHaveLength(2);
        expect(seen[0]).toMatchObject({
          mic: 'live',
          activeDeviceId: 'a',
          inputQualityPoor: true, // kept while the new input opens
          tunedStrings: [6],
        });
        expect(seen[1]).toMatchObject({
          mic: 'live',
          activeDeviceId: 'a',
          levelWarning: null,
          inputQualityPoor: false,
          tunedStrings: [6],
        });
      });

      it('fallback: one notify with the new device, quality and ticks', async () => {
        const { seen, setListed, inputs } = await liveWatched();
        setListed([A]);
        inputs[0]!.end();
        await flush();
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
          mic: 'live',
          devices: [A],
          activeDeviceId: 'a',
          levelWarning: null,
          inputQualityPoor: false,
          tunedStrings: [6],
          notice: { kind: 'switched', label: 'Mic A', seq: 1 },
        });
      });

      it('lost: one notify, quality false, ticks kept', async () => {
        const { session, seen, revoke } = await liveWatched();
        await revoke();
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
          mic: 'error',
          errorCode: 'mic-lost',
          devices: [],
          levelWarning: null,
          inputQualityPoor: false,
          tunedStrings: [6],
        });
        expect(session.getSnapshot()).toBe(seen[0]);
      });
    });

    it('devicechange while live refreshes the list; listening stops off live', async () => {
      const C = { deviceId: 'c', label: 'Mic C', groupId: 'gc' };
      const { session, setListed, fireDeviceChange, hasDeviceChangeListener, revoke } =
        devicesSetup();
      expect(hasDeviceChangeListener()).toBe(false);
      await session.allowMic();
      expect(hasDeviceChangeListener()).toBe(true);
      setListed([A, B, C]);
      await fireDeviceChange();
      expect(session.getSnapshot()).toMatchObject({ devices: [A, B, C], activeDeviceId: 'a' });
      await revoke();
      expect(hasDeviceChangeListener()).toBe(false);
      expect(session.getSnapshot().devices).toEqual([]);
    });

    describe('input quality', () => {
      const HEADSET = { deviceId: 'h', label: 'AirPods Pro (Hands-Free)', groupId: 'gh' };
      const quality = (session: { getSnapshot(): { inputQualityPoor: boolean } }) =>
        session.getSnapshot().inputQualityPoor;

      it('a normal input at 48 kHz is fine', async () => {
        const { session } = devicesSetup();
        await session.allowMic();
        expect(session.getSnapshot()).toMatchObject({
          mic: 'live',
          inputQualityPoor: false,
          inputQualityDismissed: false,
        });
      });

      it('a rate below 44.1 kHz is poor; exactly 44 100 is fine', async () => {
        const low = devicesSetup({ rates: { a: 16_000 } });
        await low.session.allowMic();
        expect(quality(low.session)).toBe(true);
        const edge = devicesSetup({ rates: { a: 44_100 } });
        await edge.session.allowMic();
        expect(quality(edge.session)).toBe(false);
      });

      it('an unknown rate with a normal label is fine', async () => {
        const { session } = await liveUnresolved('a');
        // liveUnresolved's track reports no rate, no label and a listed id 'a' ("Mic A").
        expect(session.getSnapshot()).toMatchObject({ mic: 'live', activeDeviceId: 'a' });
        expect(quality(session)).toBe(false);
      });

      it("a headset label on the listed device is poor, even with the track's label fine", async () => {
        const { session } = devicesSetup({ listed: [HEADSET, A] });
        await session.allowMic();
        expect(session.getSnapshot()).toMatchObject({
          activeDeviceId: 'h',
          inputQualityPoor: true,
        });
      });

      it('falls back to the track label when the input is not listed', async () => {
        const { deps } = devicesSetup();
        deps.openInput = vi.fn(() => ({
          analyser,
          readFrame: () => frame,
          clock: () => 0,
          clicks: () => () => {},
          capture: noCapture,
          close: vi.fn(),
          deviceId: 'default',
          groupId: null,
          label: 'Bluetooth Headset',
          sampleRate: null,
        }));
        const s2 = createRecordingSession(deps);
        await s2.allowMic();
        expect(s2.getSnapshot()).toMatchObject({
          activeDeviceId: 'default',
          inputQualityPoor: true,
        });
      });

      it('switching away from a poor input clears it; switching to one sets it', async () => {
        const { session } = devicesSetup({ listed: [HEADSET, A] });
        await session.allowMic();
        expect(quality(session)).toBe(true);
        const switching = session.selectMic('a');
        // Kept while the new input opens.
        expect(quality(session)).toBe(true);
        await switching;
        expect(quality(session)).toBe(false);
        await session.selectMic('h');
        expect(quality(session)).toBe(true);
      });

      it('recomputes on devicechange when the active input is relabelled', async () => {
        const { session, setListed, fireDeviceChange } = devicesSetup();
        const listener = vi.fn();
        session.subscribe(listener);
        await session.allowMic();
        expect(quality(session)).toBe(false);
        listener.mockClear();
        setListed([{ ...A, label: 'Headset' }, B]);
        await fireDeviceChange();
        expect(quality(session)).toBe(true);
        expect(listener).toHaveBeenCalledTimes(1);
        setListed([A, B]);
        await fireDeviceChange();
        expect(quality(session)).toBe(false);
      });

      it('is false whenever the mic is not live', async () => {
        const { session, revoke } = devicesSetup({ listed: [HEADSET, A] });
        expect(quality(session)).toBe(false);
        await session.allowMic();
        expect(quality(session)).toBe(true);
        await revoke();
        expect(session.getSnapshot()).toMatchObject({ mic: 'error', inputQualityPoor: false });
      });

      it('Dismiss lasts for the session, across switches and mic transitions, notifying once', async () => {
        const { session, revoke } = devicesSetup({ listed: [HEADSET, A], rates: { a: 16_000 } });
        const listener = vi.fn();
        session.subscribe(listener);
        await session.allowMic();
        listener.mockClear();
        session.dismissInputQuality();
        session.dismissInputQuality();
        expect(listener).toHaveBeenCalledTimes(1);
        expect(session.getSnapshot()).toMatchObject({
          inputQualityPoor: true,
          inputQualityDismissed: true,
        });
        // Another poor device: still dismissed.
        await session.selectMic('a');
        expect(session.getSnapshot()).toMatchObject({
          activeDeviceId: 'a',
          inputQualityPoor: true,
          inputQualityDismissed: true,
        });
        await revoke();
        await session.allowMic();
        expect(session.getSnapshot().inputQualityDismissed).toBe(true);
      });

      it('Dismiss is never saved to prefs', async () => {
        const { session, deps } = devicesSetup({ listed: [HEADSET] });
        await session.allowMic();
        vi.mocked(deps.updatePrefs).mockClear();
        session.dismissInputQuality();
        expect(deps.updatePrefs).not.toHaveBeenCalled();
      });
    });

    it('an older device list answer never replaces a newer one', async () => {
      const C = { deviceId: 'c', label: 'Mic C', groupId: 'gc' };
      const { session, deps, fireDeviceChange } = devicesSetup();
      await session.allowMic();
      let answerOld: (list: (typeof A)[]) => void = () => {};
      vi.mocked(deps.listMics)
        .mockImplementationOnce(() => new Promise((r) => (answerOld = r)))
        .mockImplementationOnce(() => Promise.resolve([A, B, C]));
      await fireDeviceChange();
      await fireDeviceChange();
      answerOld([A]);
      await flush();
      expect(session.getSnapshot().devices).toEqual([A, B, C]);
    });

    describe('serialised transitions', () => {
      const C = { deviceId: 'c', label: 'Mic C', groupId: 'gc' };

      /**
       * Holds the next call of `fn` until the returned release runs; it then answers as the
       * fake would at release time.
       */
      function hold<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
        const mock = vi.mocked(fn);
        const real = mock.getMockImplementation()!;
        let release: () => void = () => {};
        mock.mockImplementationOnce(
          (...args: A) => new Promise<R>((resolve) => (release = () => resolve(real(...args)))),
        );
        return () => release();
      }

      /** The fake inputs never closed, by device id. */
      const openIds = (inputs: { deviceId: string; close: ReturnType<typeof vi.fn> }[]) =>
        inputs.filter((i) => i.close.mock.calls.length === 0).map((i) => i.deviceId);

      it('a choice during an unplug fallback is ignored; only the default ends open', async () => {
        const { session, deps, inputs, unplug } = devicesSetup({ listed: [A, B, C] });
        await session.allowMic();
        const releaseRequest = hold(deps.requestMic);
        await unplug('a');
        await session.selectMic('c');
        releaseRequest();
        await flush();
        expect(deps.requestMic).not.toHaveBeenCalledWith('c');
        expect(session.getSnapshot()).toMatchObject({ mic: 'live', activeDeviceId: 'b' });
        expect(openIds(inputs)).toEqual(['b']);
      });

      it('a track ending during a switch is handled after it; one input open at rest', async () => {
        const { session, deps, inputs, unplug } = devicesSetup({ listed: [A, B, C] });
        await session.allowMic();
        const releaseList = hold(deps.listMics);
        const switching = session.selectMic('b');
        await flush();
        // B's track ends while the post-switch device list is pending; the fallback's default
        // request is held so a later choice could race it.
        const releaseRequest = hold(deps.requestMic);
        await unplug('b');
        releaseList();
        await switching;
        await flush();
        await session.selectMic('c');
        releaseRequest();
        await flush();
        expect(deps.requestMic).not.toHaveBeenCalledWith('c');
        expect(session.getSnapshot()).toMatchObject({
          mic: 'live',
          activeDeviceId: 'a',
          notice: { kind: 'switched', label: 'Mic A', seq: 1 },
        });
        expect(openIds(inputs)).toEqual(['a']);
      });

      it('an unplug while requesting falls back to the other device with a notice', async () => {
        const { session, deps, inputs, unplug } = devicesSetup();
        const releaseList = hold(deps.listMics);
        const allowing = session.allowMic();
        await flush();
        expect(session.getSnapshot().mic).toBe('requesting');
        await unplug('a');
        releaseList();
        await allowing;
        await flush();
        expect(session.getSnapshot()).toMatchObject({
          mic: 'live',
          devices: [B],
          activeDeviceId: 'b',
          notice: { kind: 'switched', label: 'Mic B', seq: 1 },
        });
        expect(openIds(inputs)).toEqual(['b']);
      });

      it('a revoke while requesting shows the lost card with no input open', async () => {
        const { session, deps, inputs, revoke } = devicesSetup();
        const releaseList = hold(deps.listMics);
        const allowing = session.allowMic();
        await flush();
        await revoke();
        releaseList();
        await allowing;
        await flush();
        expect(session.getSnapshot()).toMatchObject({ mic: 'error', errorCode: 'mic-lost' });
        expect(session.getSnapshot().notice).toBeUndefined();
        expect(openIds(inputs)).toEqual([]);
      });

      /** Makes the next opened input report Chrome's `default` id with `groupId`. */
      function nextOpensDefault(deps: RecordingDeps, groupId: string) {
        const opened = vi.mocked(deps.openInput).getMockImplementation()!;
        vi.mocked(deps.openInput).mockImplementationOnce((s, ended) => ({
          ...opened(s, ended),
          deviceId: 'default',
          groupId,
        }));
      }

      it('an ended `default` input resolved by groupId at go-live falls back when unplugged', async () => {
        const { session, deps, inputs, setListed } = devicesSetup({ listed: [B, A] });
        nextOpensDefault(deps, 'gb');
        await session.allowMic();
        expect(session.getSnapshot().activeDeviceId).toBe('b');
        setListed([A]);
        inputs[0]!.end();
        await flush();
        expect(session.getSnapshot()).toMatchObject({
          mic: 'live',
          activeDeviceId: 'a',
          notice: { kind: 'switched', label: 'Mic A', seq: 1 },
        });
        expect(openIds(inputs)).toEqual(['a']);
      });

      it('an ended `default` input resolved only by a later devicechange falls back when unplugged', async () => {
        const { session, deps, inputs, setListed, fireDeviceChange } = devicesSetup({
          listed: [B, A],
        });
        nextOpensDefault(deps, 'gc');
        await session.allowMic();
        expect(session.getSnapshot().activeDeviceId).toBe('default');
        setListed([B, A, C]);
        await fireDeviceChange();
        expect(session.getSnapshot().activeDeviceId).toBe('c');
        setListed([B, A]);
        inputs[0]!.end();
        await flush();
        expect(session.getSnapshot()).toMatchObject({
          mic: 'live',
          activeDeviceId: 'b',
          notice: { kind: 'switched', label: 'Mic B', seq: 1 },
        });
        expect(openIds(inputs)).toEqual(['b']);
      });

      it('an ended input reporting `default` with no listed match shows the lost card', async () => {
        const { session, deps, setListed } = await liveUnresolved('default');
        const opened = vi.mocked(deps.openInput).mock.results[0]!.value as { close: () => void };
        // Another device remains listed, but the ended one cannot be judged unplugged.
        setListed([B]);
        vi.mocked(deps.openInput).mock.calls[0]![1](new AppError('mic-lost', 'ended'));
        await flush();
        expect(deps.requestMic).toHaveBeenCalledTimes(1);
        expect(session.getSnapshot()).toMatchObject({ mic: 'error', errorCode: 'mic-lost' });
        expect(opened.close).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('tuner', () => {
    it('gives no reading when not live, and never reads the input', async () => {
      const { session, deps, input } = setup({
        requestMic: vi.fn(() => Promise.reject(new AppError('mic-denied', 'no'))),
      });
      expect(session.readTuner(0)).toBeNull();
      await session.allowMic();
      expect(session.getSnapshot().mic).toBe('error');
      expect(session.readTuner(50)).toBeNull();
      expect(input.readFrame).not.toHaveBeenCalled();
      expect(deps.openInput).not.toHaveBeenCalled();
    });

    it('reads the string and cents of the live frame at the analyser rate', async () => {
      const { session } = setup();
      await session.allowMic();
      tone(5, 12);
      const shown = session.readTuner(0) as { reading: { string: number; cents: number } };
      expect(shown.reading.string).toBe(5);
      expect(shown.reading.cents).toBeCloseTo(12, 0);
    });

    it('silence from the start is no pitch', async () => {
      const { session } = setup();
      await session.allowMic();
      expect(tuneEvery(session, 0, 1000)).toEqual({ reading: null, held: false, inTune: false });
    });

    it('ticks a string at 500 ms In tune, notifying once; ticks persist and grow', async () => {
      const { session, listener } = setup();
      await session.allowMic();
      listener.mockClear();
      tone(6);
      expect(tuneEvery(session, 0, 450)).toMatchObject({ inTune: false });
      expect(session.getSnapshot().tunedStrings).toEqual([]);
      expect(session.readTuner(500)).toMatchObject({ inTune: true });
      expect(session.getSnapshot().tunedStrings).toEqual([6]);
      expect(listener).toHaveBeenCalledTimes(1);
      // Staying In tune, or re-tuning a ticked string, does not notify again.
      tuneEvery(session, 550, 2000);
      expect(listener).toHaveBeenCalledTimes(1);
      tone(5);
      tuneEvery(session, 2050, 3000);
      expect(session.getSnapshot().tunedStrings).toEqual([6, 5]);
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('never notifies per poll', async () => {
      const { session, listener } = setup();
      await session.allowMic();
      listener.mockClear();
      tone(4, 20);
      tuneEvery(session, 0, 3000);
      level(0);
      tuneEvery(session, 3050, 8000);
      expect(listener).not.toHaveBeenCalled();
    });

    it('a gap of more than 500 ms between reads restarts the machine', async () => {
      const { session } = setup();
      await session.allowMic();
      tone(3, 20);
      tuneEvery(session, 0, 400);
      // Silence after the gap would hold the reading; a restarted machine has none to hold.
      level(0);
      expect(session.readTuner(901)).toEqual({ reading: null, held: false, inTune: false });
    });

    it('after a gap, In tune needs 500 ms of reads from the gap on', async () => {
      const { session } = setup();
      await session.allowMic();
      tone(3);
      tuneEvery(session, 0, 400); // in range since 0: In tune at 500 without the gap
      // 550 ms gap: the run restarts at 950, so In tune comes at 1450, polled every 50 ms.
      expect(session.readTuner(950)).toMatchObject({ reading: { string: 3 }, inTune: false });
      expect(tuneEvery(session, 1000, 1400)).toMatchObject({ inTune: false });
      expect(session.getSnapshot().tunedStrings).toEqual([]);
      expect(session.readTuner(1450)).toMatchObject({ inTune: true });
      expect(session.getSnapshot().tunedStrings).toEqual([3]);
    });

    it('a gap of exactly 500 ms keeps the timing', async () => {
      const { session } = setup();
      await session.allowMic();
      tone(2);
      session.readTuner(0);
      expect(session.readTuner(500)).toMatchObject({ inTune: true });
    });

    it('keeps the ticks across mic transitions and restarts the machine', async () => {
      const { session, endTrack } = setup();
      await session.allowMic();
      tone(1);
      tuneEvery(session, 0, 500);
      expect(session.getSnapshot().tunedStrings).toEqual([1]);
      await endTrack();
      expect(session.getSnapshot()).toMatchObject({ mic: 'error', tunedStrings: [1] });
      await session.allowMic();
      expect(session.getSnapshot()).toMatchObject({ mic: 'live', tunedStrings: [1] });
      // A fresh machine: the first read after going live is not yet In tune.
      expect(session.readTuner(550)).toMatchObject({ inTune: false });
    });

    it('never saves the ticks to prefs', async () => {
      const { session, deps } = setup();
      await session.allowMic();
      vi.mocked(deps.updatePrefs).mockClear();
      tone(6);
      tuneEvery(session, 0, 600);
      expect(session.getSnapshot().tunedStrings).toEqual([6]);
      expect(deps.updatePrefs).not.toHaveBeenCalled();
    });
  });

  it('stops notifying after unsubscribe', async () => {
    const { session } = setup();
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);
    unsubscribe();
    await session.allowMic();
    expect(listener).not.toHaveBeenCalled();
  });
});
