import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/model/errors';
import { createRecordingSession, type RecordingDeps } from '../../src/session/recording-session';

const stream = {} as MediaStream;
const analyser = {} as AnalyserNode;
/** The frame the fake input returns; tests fill it per reading. */
let frame = new Float32Array(4096);
const SILENT = { peakDb: -Infinity, rmsDb: -Infinity };
/** The device fields of a snapshot when no device is listed (and always outside `live`). */
const IDLE = { devices: [], activeDeviceId: null };

/** Lets pending promise callbacks and timers at 0 ms run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A constant frame at `amplitude`: peak and RMS both `20·log10(amplitude)`. */
function level(amplitude: number) {
  frame = new Float32Array(4096).fill(amplitude);
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
    close: vi.fn(),
    deviceId: null,
    groupId: null,
    label: '',
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
    loadPrefs: vi.fn<RecordingDeps['loadPrefs']>(() => ({ micGranted: false })),
    micPermission: vi.fn<RecordingDeps['micPermission']>(() => Promise.resolve('prompt')),
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
        loadPrefs: vi.fn(() => ({ micGranted: true })),
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
          loadPrefs: vi.fn(() => ({ micGranted: true })),
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
        loadPrefs: vi.fn(() => ({ micGranted: true })),
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
        loadPrefs: vi.fn(() => ({ micGranted: true })),
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
    function devicesSetup(options: { listed?: (typeof A)[]; saved?: string | null } = {}) {
      let listed = options.listed ?? [A, B];
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
            close: entry.close,
            deviceId,
            groupId: `g${deviceId}`,
            label: `track ${deviceId}`,
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
        loadPrefs: vi.fn(() => ({ micGranted: true, micDeviceId: saved })),
        micPermission: vi.fn(() => Promise.resolve('granted' as const)),
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
        close: vi.fn(),
        deviceId: 'default',
        groupId: 'gb',
        label: 'Default - Mic B',
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
        close: vi.fn(),
        deviceId,
        groupId: null,
        label: '',
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
