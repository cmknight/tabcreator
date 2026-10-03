import { describe, expect, it, vi } from 'vitest';
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

// Story 3.4: record() and stop('user') in the recording store, with a fake capture that emits
// chunks before and after createTake resolves, and fake storage that logs the stop pipeline.

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
  const capture: Capture = {
    sampleRate: RATE,
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
  const input: OpenedInput = {
    analyser: { context: { sampleRate: RATE } } as unknown as AnalyserNode,
    readFrame: () => new Float32Array(4096),
    capture: vi.fn((onChunk: (samples: Float32Array) => void) => {
      emit = onChunk;
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
  const prefs = { micGranted: true, analysisDefaults: { ...ANALYSIS_DEFAULTS } };
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
    emit: (samples: Float32Array) => emit?.(samples),
    setElapsed: (ms: number) => (elapsed = ms),
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
