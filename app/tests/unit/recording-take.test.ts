import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Capture } from '../../src/audio/mic';
import { AppError } from '../../src/model/errors';
import type { Take } from '../../src/model/types';
import type { OpenedInput } from '../../src/session/input-derivation';
import {
  createRecordingSession,
  takeTitle,
  type RecordingDeps,
} from '../../src/session/recording-session';
import type { RawWriter } from '../../src/storage/audio-store';
import { loadPrefs, updatePrefs } from '../../src/storage/prefs';
import { COUNT_IN_LEAD_S } from '../../src/audio/metronome';

// Stories 3.4 and 3.6: record() and stop('user') in the recording store, and the count-in, with a
// fake capture that emits chunks before and after createTake resolves, and fake storage that logs
// the stop pipeline.

const RATE = 48_000;
const ANALYSIS_DEFAULTS = { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 };
const DEVICE = { deviceId: 'mic-a', label: 'USB Interface', groupId: 'g-a' };
/** 2026-10-02 21:14:05 local time. */
const NOW = new Date(2026, 9, 2, 21, 14, 5).getTime();

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A chunk of `n` samples, all `value`, so the raw file's order can be checked. */
const chunk = (value: number, n = RATE) => new Float32Array(n).fill(value);

/** Fakes; `overrides` replace deps, and `captureError` makes `input.capture` reject with it. */
function setup(overrides: Partial<RecordingDeps> = {}, captureError?: AppError) {
  const log: string[] = [];
  let emit: ((samples: Float32Array) => void) | null = null;
  let elapsed = 0;
  /** The input's audio clock, s. */
  let audioTime = 10;
  const capture: Capture = {
    sampleRate: RATE,
    startTime: 0,
    elapsedMs: () => elapsed,
    stop: vi.fn(async () => {
      log.push('capture.stop');
      // The final partial chunk arrives before stop resolves.
      emit?.(chunk(9, RATE / 2));
      return { parts: [new Blob(['webm'])] };
    }),
    abort: vi.fn(() => log.push('capture.abort')),
  };
  let onEnded: ((error: AppError) => void) | null = null;
  const cancelClicks = vi.fn(() => log.push('clicks.cancel'));
  const input: OpenedInput = {
    analyser: { context: { sampleRate: RATE } } as unknown as AnalyserNode,
    readFrame: () => new Float32Array(4096),
    clock: () => audioTime,
    clicks: vi.fn((beats: readonly number[]) => {
      log.push(`clicks ${beats.length}`);
      return cancelClicks;
    }),
    capture: vi.fn((onChunk: (samples: Float32Array) => void, startAt?: number) => {
      emit = onChunk;
      (capture as { startTime: number }).startTime = startAt ?? audioTime + 0.05;
      return captureError ? Promise.reject(captureError) : Promise.resolve(capture);
    }),
    close: vi.fn(() => log.push('input.close')),
    deviceId: DEVICE.deviceId,
    groupId: DEVICE.groupId,
    label: 'track label',
    sampleRate: RATE,
  };
  const appended: number[] = [];
  const writer: RawWriter = {
    append: vi.fn(async (samples: Float32Array) => {
      appended.push(samples[0]!);
    }),
    close: vi.fn(async () => {
      log.push(`writer.close after ${appended.length} appends`);
    }),
  };
  const created = deferred<void>();
  const prefs: ReturnType<RecordingDeps['loadPrefs']> = {
    micGranted: true,
    analysisDefaults: { ...ANALYSIS_DEFAULTS },
  };
  const deps: RecordingDeps = {
    requestMic: vi.fn(() => Promise.resolve({} as MediaStream)),
    openInput: vi.fn((_s: MediaStream, ended: (error: AppError) => void) => {
      onEnded = ended;
      return input;
    }),
    listMics: vi.fn(() => Promise.resolve([DEVICE, { ...DEVICE, deviceId: 'mic-b' }])),
    onDeviceChange: vi.fn(() => () => {}),
    updatePrefs: vi.fn(),
    loadPrefs: vi.fn(() => prefs),
    micPermission: vi.fn(() => Promise.resolve('granted' as const)),
    createTake: vi.fn((take: Take) => {
      log.push(`createTake ${take.id}`);
      return created.promise;
    }),
    patchTake: vi.fn(async (id: string) => {
      log.push(`patchTake ${id}`);
    }),
    openRawWriter: vi.fn(async (id: string) => {
      log.push(`openRawWriter ${id}`);
      return writer;
    }),
    writeCompressed: vi.fn(async (id: string, blob: Blob) => {
      log.push(`writeCompressed ${id} ${blob.type}`);
    }),
    navigate: vi.fn((id: string) => log.push(`navigate ${id}`)),
    now: () => NOW,
    newId: vi.fn(() => 'take-1'),
    ...overrides,
  };
  const session = createRecordingSession(deps);
  return {
    session,
    deps,
    input,
    capture,
    writer,
    appended,
    log,
    prefs,
    created,
    cancelClicks,
    emit: (samples: Float32Array) => emit?.(samples),
    setElapsed: (ms: number) => (elapsed = ms),
    setClock: (s: number) => (audioTime = s),
    endTrack: async () => {
      onEnded?.(new AppError('mic-lost', 'ended'));
      await flush();
    },
  };
}

/** Live, then recording with the take created; one chunk held before and one after. */
async function recording(overrides: Partial<RecordingDeps> = {}) {
  const t = setup(overrides);
  await t.session.allowMic();
  const started = t.session.record();
  await flush();
  t.emit(chunk(1));
  t.created.resolve();
  await started;
  t.emit(chunk(2));
  await flush();
  return t;
}

describe('recording a take', () => {
  it('titles a take "Take YYYY-MM-DD HH:mm" in local time', () => {
    expect(takeTitle(new Date(2026, 0, 5, 7, 3))).toBe('Take 2026-01-05 07:03');
  });

  it('does nothing when the mic is not live', async () => {
    const t = setup();
    await t.session.record();
    expect(t.deps.createTake).not.toHaveBeenCalled();
    expect(t.input.capture).not.toHaveBeenCalled();
    expect(t.session.getSnapshot()).toMatchObject({ recording: 'idle', activeTakeId: null });
  });

  it('creates the take at the click with the copied defaults and starts the capture', async () => {
    const t = setup();
    await t.session.allowMic();
    const listener = vi.fn();
    t.session.subscribe(listener);
    void t.session.record();
    expect(t.session.getSnapshot()).toMatchObject({
      recording: 'starting',
      activeTakeId: 'take-1',
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(t.input.capture).toHaveBeenCalledTimes(1);
    expect(t.deps.createTake).toHaveBeenCalledTimes(1);
    const take = vi.mocked(t.deps.createTake).mock.calls[0]![0];
    expect(take).toEqual({
      id: 'take-1',
      title: 'Take 2026-10-02 21:14',
      createdAt: new Date(NOW).toISOString(),
      status: 'recording',
      durationMs: 0,
      sampleRate: RATE,
      tuning: 'EADGBE',
      micLabel: 'USB Interface',
      audioMime: null,
      trimStartMs: 0,
      trimEndMs: null,
      settings: ANALYSIS_DEFAULTS,
      analysisVersion: null,
      updatedAt: new Date(NOW).toISOString(),
    });
    // A copy, never linked to prefs afterwards (AD-14).
    expect(take.settings).not.toBe(t.prefs.analysisDefaults);
    t.prefs.analysisDefaults.sensitivity = 0.9;
    expect(take.settings.sensitivity).toBe(0.5);
  });

  it('holds chunks that arrive before the take exists and appends them first, in order', async () => {
    const t = setup();
    await t.session.allowMic();
    const started = t.session.record();
    await flush();
    t.emit(chunk(1));
    t.emit(chunk(2));
    expect(t.deps.openRawWriter).not.toHaveBeenCalled();
    expect(t.appended).toEqual([]);
    t.created.resolve();
    await started;
    t.emit(chunk(3));
    await flush();
    expect(t.appended).toEqual([1, 2, 3]);
    expect(t.session.getSnapshot()).toMatchObject({
      recording: 'recording',
      activeTakeId: 'take-1',
    });
  });

  it('starts one take when record() is called twice', async () => {
    const t = setup();
    await t.session.allowMic();
    const a = t.session.record();
    const b = t.session.record();
    t.created.resolve();
    await Promise.all([a, b]);
    await t.session.record();
    expect(t.deps.createTake).toHaveBeenCalledTimes(1);
    expect(t.input.capture).toHaveBeenCalledTimes(1);
  });

  it('ignores a microphone switch while recording', async () => {
    const t = await recording();
    await t.session.selectMic('mic-b');
    expect(t.deps.requestMic).toHaveBeenCalledTimes(1);
    expect(t.input.close).not.toHaveBeenCalled();
    expect(t.session.getSnapshot().activeDeviceId).toBe('mic-a');
  });

  it('reads the elapsed time from the capture, and 0 with none running', async () => {
    const t = await recording();
    t.setElapsed(4321);
    expect(t.session.readElapsedMs()).toBe(4321);
    await t.session.stop('user');
    expect(t.session.readElapsedMs()).toBe(0);
  });

  it('stops: capture, final chunk, compressed copy, writer closed, patch, then the Tab', async () => {
    const t = await recording();
    const done = t.session.stop('user');
    expect(t.session.getSnapshot().recording).toBe('stopping');
    // A second Stop while saving does nothing.
    await t.session.stop('user');
    await done;
    expect(t.appended).toEqual([1, 2, 9]);
    expect(t.log).toEqual([
      'createTake take-1',
      'openRawWriter take-1',
      'capture.stop',
      'writeCompressed take-1 audio/webm;codecs=opus',
      'writer.close after 3 appends',
      'patchTake take-1',
      'navigate take-1',
    ]);
    // 2.5 s of samples at 48 kHz.
    expect(t.deps.patchTake).toHaveBeenCalledWith(
      'take-1',
      {
        status: 'recorded',
        durationMs: 2500,
        audioMime: 'audio/webm;codecs=opus',
        stopReason: 'user',
      },
      'recording-session',
    );
    expect(t.session.getSnapshot()).toMatchObject({
      mic: 'live',
      recording: 'idle',
      activeTakeId: null,
    });
    expect(t.input.close).not.toHaveBeenCalled();
  });

  it('does nothing on stop() when not recording', async () => {
    const t = setup();
    await t.session.allowMic();
    await t.session.stop('user');
    expect(t.deps.patchTake).not.toHaveBeenCalled();
    expect(t.deps.navigate).not.toHaveBeenCalled();
  });

  it('stops the capture and shows the error when createTake fails', async () => {
    const t = setup({
      createTake: vi.fn(() => Promise.reject(new AppError('storage-full', 'full'))),
    });
    await t.session.allowMic();
    await t.session.record();
    expect(t.capture.abort).toHaveBeenCalledTimes(1);
    expect(t.deps.openRawWriter).not.toHaveBeenCalled();
    expect(t.session.getSnapshot()).toMatchObject({
      mic: 'error',
      errorCode: 'storage-full',
      recording: 'idle',
      activeTakeId: null,
    });
    expect(t.input.close).toHaveBeenCalledTimes(1);
  });

  it('keeps the take recording and shows the error when saving it fails', async () => {
    const t = await recording({
      writeCompressed: vi.fn(() => Promise.reject(new AppError('storage-full', 'full'))),
    });
    await t.session.stop('user');
    await flush();
    expect(t.deps.patchTake).not.toHaveBeenCalled();
    expect(t.deps.navigate).not.toHaveBeenCalled();
    expect(t.capture.abort).toHaveBeenCalledTimes(1);
    expect(t.writer.close).toHaveBeenCalledTimes(1);
    expect(t.input.close).toHaveBeenCalledTimes(1);
    expect(t.session.getSnapshot()).toMatchObject({
      mic: 'error',
      errorCode: 'storage-full',
      recording: 'idle',
      activeTakeId: null,
    });
  });

  it('closes the writer and shows the error when the capture fails to start', async () => {
    const t = setup({}, new AppError('mic-failed', 'no worklet'));
    await t.session.allowMic();
    const started = t.session.record();
    t.created.resolve();
    await started;
    await flush();
    expect(t.deps.openRawWriter).toHaveBeenCalledTimes(1);
    expect(t.writer.close).toHaveBeenCalledTimes(1);
    expect(t.session.getSnapshot()).toMatchObject({
      mic: 'error',
      errorCode: 'mic-failed',
      recording: 'idle',
      activeTakeId: null,
    });
  });

  it('leaves the take recording, with its raw chunks, when the track ends mid-take', async () => {
    const t = await recording();
    await t.endTrack();
    expect(t.capture.abort).toHaveBeenCalledTimes(1);
    expect(t.writer.close).toHaveBeenCalledTimes(1);
    expect(t.appended).toEqual([1, 2]);
    expect(t.deps.patchTake).not.toHaveBeenCalled();
    expect(t.deps.writeCompressed).not.toHaveBeenCalled();
    expect(t.deps.navigate).not.toHaveBeenCalled();
    expect(t.session.getSnapshot()).toMatchObject({ recording: 'idle', activeTakeId: null });
    // A later chunk from the torn-down capture is dropped.
    t.emit(chunk(5));
    await flush();
    expect(t.appended).toEqual([1, 2]);
  });
});

// Story 3.6: the count-in. The input's audio clock is set by hand; timers are faked so the wait
// for the capture start runs without real time passing.
describe('count-in', () => {
  /** The click's audio-clock time in these tests. */
  const T0 = 10;

  beforeEach(() => {
    vi.useFakeTimers();
    delete window.__recordingClock;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Live, with count-in on at `bpm`. */
  async function live(bpm: number, overrides: Partial<RecordingDeps> = {}) {
    const t = setup(overrides);
    t.prefs.countIn = { on: true, bpm };
    const session = createRecordingSession(t.deps);
    const allowed = session.allowMic();
    await vi.advanceTimersByTimeAsync(0);
    await allowed;
    return { ...t, session };
  }

  /** Moves the audio clock to `s` and lets the timers aimed at it run. */
  async function clockTo(t: { setClock: (s: number) => void }, s: number) {
    t.setClock(s);
    await vi.advanceTimersByTimeAsync(2_500);
  }

  it('at 120 BPM: clicks on the 4 beats, capture at beat five, the take created then', async () => {
    const t = await live(120);
    const started = t.session.record();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.session.getSnapshot()).toMatchObject({ recording: 'count-in', activeTakeId: null });
    // Beat 1 comes COUNT_IN_LEAD_S after the press; all four gaps are equal.
    const beats = vi.mocked(t.input.clicks).mock.calls[0]![0];
    [10.015, 10.515, 11.015, 11.515].forEach((b, k) => expect(beats[k]).toBeCloseTo(b, 9));
    expect(vi.mocked(t.input.capture).mock.calls[0]![1]).toBeCloseTo(12.015, 9);
    // The dev hook keeps the press time, so capture start − click is 2.0 s plus the lead.
    expect(window.__recordingClock!.clickTime).toBe(T0);
    expect(window.__recordingClock!.captureStart - T0).toBeCloseTo(2 + COUNT_IN_LEAD_S, 9);
    // Nothing is created during the count-in, however long the timers run short of beat five.
    await clockTo(t, 12);
    expect(t.deps.createTake).not.toHaveBeenCalled();

    await clockTo(t, 12.015);
    expect(t.deps.createTake).toHaveBeenCalledTimes(1);
    expect(t.session.getSnapshot()).toMatchObject({
      recording: 'starting',
      activeTakeId: 'take-1',
    });
    expect(vi.mocked(t.deps.createTake).mock.calls[0]![0]).toMatchObject({
      id: 'take-1',
      status: 'recording',
      countInBpm: 120,
    });
    // Chunks before createTake resolves are held, then appended first.
    t.emit(chunk(1));
    t.created.resolve();
    await started;
    t.emit(chunk(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.appended).toEqual([1, 2]);
    expect(t.session.getSnapshot().recording).toBe('recording');
    expect(t.cancelClicks).not.toHaveBeenCalled();
  });

  it.each([
    [40, [10, 11.5, 13, 14.5], 16],
    [100, [10, 10.6, 11.2, 11.8], 12.4],
    [240, [10, 10.25, 10.5, 10.75], 11],
  ])('at %i BPM schedules the beats and the capture start', async (bpm, beats, start) => {
    const t = await live(bpm);
    void t.session.record();
    await vi.advanceTimersByTimeAsync(0);
    const scheduled = vi.mocked(t.input.clicks).mock.calls[0]![0];
    scheduled.forEach((time, k) => expect(time).toBeCloseTo(beats[k]! + COUNT_IN_LEAD_S, 9));
    expect(vi.mocked(t.input.capture).mock.calls[0]![1]).toBeCloseTo(start + COUNT_IN_LEAD_S, 9);
    await t.session.stop('user');
  });

  it('reads the beat number counting down 4, 3, 2, 1, and null when not counting', async () => {
    const t = await live(60);
    expect(t.session.readCountInBeat()).toBeNull();
    void t.session.record();
    await vi.advanceTimersByTimeAsync(0);
    const listener = vi.fn();
    t.session.subscribe(listener);
    const beats: (number | null)[] = [];
    for (const s of [10, 10.5, 11.015, 12.2, 13.015, 14]) {
      t.setClock(s);
      beats.push(t.session.readCountInBeat());
    }
    expect(beats).toEqual([4, 4, 3, 2, 1, 1]);
    // Read on demand: no notify per read.
    expect(listener).not.toHaveBeenCalled();
    await t.session.stop('user');
    expect(t.session.readCountInBeat()).toBeNull();
  });

  it('stop() cancels: clicks cancelled, capture aborted, no take, idle', async () => {
    const t = await live(120);
    const started = t.session.record();
    await vi.advanceTimersByTimeAsync(0);
    await clockTo(t, 11);
    await t.session.stop('user');
    expect(window.__recordingClock).toBeDefined();
    expect(t.cancelClicks).toHaveBeenCalledTimes(1);
    expect(t.capture.abort).toHaveBeenCalledTimes(1);
    expect(t.session.getSnapshot()).toMatchObject({ recording: 'idle', activeTakeId: null });
    await clockTo(t, 20);
    await started;
    expect(t.deps.createTake).not.toHaveBeenCalled();
    expect(t.deps.openRawWriter).not.toHaveBeenCalled();
    expect(t.input.close).not.toHaveBeenCalled();
    // A later chunk from the aborted capture is dropped; a new take can start.
    t.emit(chunk(5));
    expect(t.appended).toEqual([]);
    void t.session.record();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.session.getSnapshot().recording).toBe('count-in');
    expect(t.input.capture).toHaveBeenCalledTimes(2);
  });

  it('a cancel before the capture has started aborts it once it has', async () => {
    const t = await live(120);
    let resolveCapture!: (c: Capture) => void;
    vi.mocked(t.input.capture).mockImplementationOnce(
      () => new Promise<Capture>((resolve) => (resolveCapture = resolve)),
    );
    const started = t.session.record();
    await t.session.stop('user');
    expect(t.session.getSnapshot().recording).toBe('idle');
    resolveCapture(t.capture);
    await started;
    expect(t.capture.abort).toHaveBeenCalledTimes(1);
    expect(t.deps.createTake).not.toHaveBeenCalled();
  });

  it('an ended track during the count-in cancels it at once', async () => {
    const t = await live(120);
    void t.session.record();
    await vi.advanceTimersByTimeAsync(0);
    const ending = t.endTrack();
    await vi.advanceTimersByTimeAsync(0);
    await ending;
    expect(t.cancelClicks).toHaveBeenCalledTimes(1);
    expect(t.capture.abort).toHaveBeenCalled();
    await clockTo(t, 20);
    expect(t.deps.createTake).not.toHaveBeenCalled();
  });

  /** Expects the count-in to have failed with the error card and left nothing running. */
  function expectFailed(t: ReturnType<typeof setup>, session = t.session) {
    expect(t.cancelClicks).toHaveBeenCalled();
    expect(session.getSnapshot()).toMatchObject({
      mic: 'error',
      errorCode: 'mic-failed',
      recording: 'idle',
      activeTakeId: null,
    });
    expect(session.readCountInBeat()).toBeNull();
  }

  it('a capture that fails to start during the count-in shows the error', async () => {
    const t = await live(120);
    vi.mocked(t.input.capture).mockImplementationOnce(() =>
      Promise.reject(new AppError('mic-failed', 'no worklet')),
    );
    await t.session.record();
    expectFailed(t);
    expect(t.deps.createTake).not.toHaveBeenCalled();
  });

  it('a capture that opens after beat five is aborted: no take with a wrong bar grid', async () => {
    const t = await live(240);
    vi.mocked(t.input.capture).mockImplementationOnce(async (_onChunk, startAt) => {
      (t.capture as { startTime: number }).startTime = startAt! + 0.05;
      return t.capture;
    });
    await t.session.record();
    expect(t.capture.abort).toHaveBeenCalledTimes(1);
    expectFailed(t);
    expect(t.deps.createTake).not.toHaveBeenCalled();
  });

  it('a stopped audio clock fails the count-in after the expected wait plus 2 s', async () => {
    vi.setSystemTime(NOW);
    const t = await live(120, { now: () => Date.now() });
    const started = t.session.record();
    // The clock stays at the press time: beat five never comes.
    await vi.advanceTimersByTimeAsync(3_900);
    expect(t.session.getSnapshot().recording).toBe('count-in');
    await vi.advanceTimersByTimeAsync(200);
    await started;
    expect(t.capture.abort).toHaveBeenCalledTimes(1);
    expectFailed(t);
    expect(t.deps.createTake).not.toHaveBeenCalled();
  });

  it('createTake failing at beat five aborts the capture and shows the error', async () => {
    const t = await live(120, {
      createTake: vi.fn(() => Promise.reject(new AppError('storage-full', 'full'))),
    });
    const started = t.session.record();
    await vi.advanceTimersByTimeAsync(0);
    await clockTo(t, 12.015);
    await started;
    expect(t.capture.abort).toHaveBeenCalledTimes(1);
    expect(t.deps.openRawWriter).not.toHaveBeenCalled();
    expect(t.session.getSnapshot()).toMatchObject({
      mic: 'error',
      errorCode: 'storage-full',
      recording: 'idle',
      activeTakeId: null,
    });
  });

  it('clears the dev clock hook when a take starts without a count-in', async () => {
    const t = await live(120);
    void t.session.record();
    await vi.advanceTimersByTimeAsync(0);
    await t.session.stop('user');
    await vi.advanceTimersByTimeAsync(0);
    expect(window.__recordingClock).toBeDefined();
    t.session.setCountIn({ on: false });
    void t.session.record();
    expect(window.__recordingClock).toBeUndefined();
  });

  it('off: the take is created at the click, with no countInBpm', async () => {
    const t = setup();
    t.prefs.countIn = { on: false, bpm: 90 };
    const session = createRecordingSession(t.deps);
    await session.allowMic();
    vi.useRealTimers();
    void session.record();
    expect(session.getSnapshot().recording).toBe('starting');
    expect(t.input.clicks).not.toHaveBeenCalled();
    expect(t.deps.createTake).toHaveBeenCalledTimes(1);
    expect(vi.mocked(t.deps.createTake).mock.calls[0]![0]).not.toHaveProperty('countInBpm');
    expect(vi.mocked(t.input.capture).mock.calls[0]![1]).toBeUndefined();
  });
});

describe('the count-in pref', () => {
  it('starts from the stored pref, and from the default when there is none', () => {
    const t = setup();
    expect(t.session.getSnapshot().countIn).toEqual({ on: false, bpm: 100 });
    t.prefs.countIn = { on: true, bpm: 90 };
    expect(createRecordingSession(t.deps).getSnapshot().countIn).toEqual({ on: true, bpm: 90 });
  });

  it.each([
    [300, 240],
    [12, 40],
    [90.4, 90],
    [NaN, 100],
  ])('clamps a typed %d BPM to %d', (typed, stored) => {
    const t = setup();
    t.session.setCountIn({ bpm: typed });
    expect(t.session.getSnapshot().countIn).toEqual({ on: false, bpm: stored });
    if (stored === 100) expect(t.deps.updatePrefs).not.toHaveBeenCalled();
    else expect(t.deps.updatePrefs).toHaveBeenCalledWith({ countIn: { on: false, bpm: stored } });
  });

  it('notifies on a change and keeps working when saving fails', () => {
    const t = setup({
      updatePrefs: vi.fn(() => {
        throw new AppError('storage-failed', 'no');
      }),
    });
    const listener = vi.fn();
    t.session.subscribe(listener);
    t.session.setCountIn({ on: true });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(t.session.getSnapshot().countIn).toEqual({ on: true, bpm: 100 });
  });

  it('cannot change during a count-in', async () => {
    const t = setup();
    t.prefs.countIn = { on: true, bpm: 120 };
    const session = createRecordingSession(t.deps);
    await session.allowMic();
    void session.record();
    await flush();
    expect(session.getSnapshot().recording).toBe('count-in');
    session.setCountIn({ on: false, bpm: 60 });
    expect(t.deps.updatePrefs).not.toHaveBeenCalledWith(
      expect.objectContaining({ countIn: expect.anything() }),
    );
    expect(session.getSnapshot().countIn).toEqual({ on: true, bpm: 120 });
    await session.stop('user');
  });

  it('cannot change while recording', async () => {
    const t = await recording();
    t.session.setCountIn({ on: true, bpm: 60 });
    expect(t.deps.updatePrefs).not.toHaveBeenCalledWith(
      expect.objectContaining({ countIn: expect.anything() }),
    );
    expect(t.session.getSnapshot().countIn).toEqual({ on: false, bpm: 100 });
  });

  it('persists through prefs: on at 90 BPM survives a reload', () => {
    localStorage.clear();
    const deps = { ...setup().deps, loadPrefs, updatePrefs };
    const before = createRecordingSession(deps);
    before.setCountIn({ on: true });
    before.setCountIn({ bpm: 90 });
    expect(loadPrefs().countIn).toEqual({ on: true, bpm: 90 });
    // A reload: a new store reads the saved pref.
    expect(createRecordingSession(deps).getSnapshot().countIn).toEqual({ on: true, bpm: 90 });
    localStorage.clear();
  });
});
