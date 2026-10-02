import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/model/errors';
import { createRecordingSession, type RecordingDeps } from '../../src/session/recording-session';

const stream = {} as MediaStream;
const analyser = {} as AnalyserNode;
/** The frame the fake input returns; tests fill it per reading. */
let frame = new Float32Array(4096);
const SILENT = { peakDb: -Infinity, rmsDb: -Infinity };

/** A constant frame at `amplitude`: peak and RMS both `20·log10(amplitude)`. */
function level(amplitude: number) {
  frame = new Float32Array(4096).fill(amplitude);
}

function setup(overrides: Partial<RecordingDeps> = {}) {
  frame = new Float32Array(4096);
  const input = { analyser, readFrame: vi.fn(() => frame), close: vi.fn() };
  let onEnded: ((error: AppError) => void) | null = null;
  const deps = {
    requestMic: vi.fn(() => Promise.resolve(stream)),
    openInput: vi.fn((_stream: MediaStream, ended: (error: AppError) => void) => {
      onEnded = ended;
      return input;
    }),
    updatePrefs: vi.fn(),
    loadPrefs: vi.fn(() => ({ micGranted: false })),
    micPermission: vi.fn<RecordingDeps['micPermission']>(() => Promise.resolve('prompt')),
    ...overrides,
  };
  const session = createRecordingSession(deps);
  const listener = vi.fn();
  session.subscribe(listener);
  /** Ends the live track on its own, as audio/ reports it. */
  const endTrack = () => onEnded?.(new AppError('mic-lost', 'ended'));
  return { session, deps, input, listener, endTrack };
}

describe('recording session', () => {
  it('starts in setup without touching the mic', () => {
    const { session, deps } = setup();
    expect(session.getSnapshot()).toEqual({ mic: 'setup', levelWarning: null });
    expect(session.readLevels(0)).toEqual(SILENT);
    expect(session.getAnalyser()).toBeNull();
    expect(deps.requestMic).not.toHaveBeenCalled();
  });

  it('goes setup → requesting → live, opens the input and records micGranted', async () => {
    const { session, deps, listener } = setup();
    const done = session.allowMic();
    expect(session.getSnapshot()).toEqual({ mic: 'requesting', levelWarning: null });
    await done;
    expect(session.getSnapshot()).toEqual({ mic: 'live', levelWarning: null });
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
    });
    expect(deps.updatePrefs).not.toHaveBeenCalled();
    expect(session.readLevels(0)).toEqual(SILENT);

    const retry = session.allowMic();
    // The error card stays in place while the retry runs.
    expect(session.getSnapshot()).toEqual({
      mic: 'requesting',
      errorCode: 'mic-failed',
      levelWarning: null,
    });
    await retry;
    expect(requestMic).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot()).toEqual({ mic: 'live', levelWarning: null });
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
    });
  });

  it('stays live when saving micGranted fails', async () => {
    const { session } = setup({
      updatePrefs: vi.fn(() => {
        throw new AppError('storage-full', 'full');
      }),
    });
    await session.allowMic();
    expect(session.getSnapshot()).toEqual({ mic: 'live', levelWarning: null });
  });

  it('closes the input, then shows mic-lost when the live track ends; Try again recovers', async () => {
    const { session, deps, input, endTrack } = setup();
    await session.allowMic();
    const order: string[] = [];
    input.close.mockImplementation(() => order.push('close'));
    session.subscribe(() => order.push(session.getSnapshot().mic));
    endTrack();
    expect(order).toEqual(['close', 'error']);
    expect(session.getSnapshot()).toEqual({
      mic: 'error',
      errorCode: 'mic-lost',
      levelWarning: null,
    });
    expect(session.readLevels(0)).toEqual(SILENT);
    expect(session.getAnalyser()).toBeNull();

    await session.allowMic();
    expect(deps.requestMic).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot()).toEqual({ mic: 'live', levelWarning: null });
  });

  it('ignores an ended report from an input it no longer holds', async () => {
    const { session, input, endTrack } = setup();
    await session.allowMic();
    endTrack();
    endTrack();
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
      expect(session.getSnapshot()).toEqual({ mic: 'live', levelWarning: null });
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
        expect(session.getSnapshot()).toEqual({ mic: 'setup', levelWarning: null });
      },
    );

    it('stays in setup on a first visit without asking the browser', async () => {
      const { session, deps } = setup();
      await session.resume();
      expect(deps.micPermission).not.toHaveBeenCalled();
      expect(deps.requestMic).not.toHaveBeenCalled();
      expect(session.getSnapshot()).toEqual({ mic: 'setup', levelWarning: null });
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
      endTrack();
      await session.resume();
      expect(deps.requestMic).toHaveBeenCalledTimes(1);
      expect(session.getSnapshot()).toEqual({
        mic: 'error',
        errorCode: 'mic-lost',
        levelWarning: null,
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
      session.readLevels(0);
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
      session.readLevels(0);
      session.readLevels(2900);
      expect(session.getSnapshot().levelWarning).toBeNull();
      session.readLevels(3000);
      expect(session.getSnapshot().levelWarning).toBe('quiet');
      frame = new Float32Array(4096);
      frame[0] = 1; // a loud peak with a quiet RMS
      session.readLevels(3100);
      expect(session.getSnapshot().levelWarning).toBe('loud');
    });

    it('clears the warning and starts afresh when the mic leaves live', async () => {
      const { session, endTrack } = setup();
      await session.allowMic();
      level(1);
      session.readLevels(0);
      expect(session.getSnapshot().levelWarning).toBe('loud');
      endTrack();
      expect(session.getSnapshot()).toEqual({
        mic: 'error',
        errorCode: 'mic-lost',
        levelWarning: null,
      });
      await session.allowMic();
      level(0.1);
      session.readLevels(100);
      expect(session.getSnapshot().levelWarning).toBeNull();
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
