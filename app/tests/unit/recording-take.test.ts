import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Capture } from '../../src/audio/mic';
import { AppError } from '../../src/model/errors';
import type { Take } from '../../src/model/types';
import type { OpenedInput } from '../../src/session/input-derivation';
import {
  createRecordingSession,
  MAX_TAKE_MS,
  readDevLimits,
  takeTitle,
  WARN_LEAD_MS,
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
  let emit: ((samples: Float32Array, clipped: number) => void) | null = null;
  /** The clipped-sample count the final partial chunk reports at stop. */
  let finalClipped = 0;
  let elapsed = 0;
  /** The input's audio clock, s. */
  let audioTime = 10;
  const capped = deferred<void>();
  const capture: Capture = {
    sampleRate: RATE,
    startTime: 0,
    capped: capped.promise,
    elapsedMs: () => elapsed,
    stop: vi.fn(async () => {
      log.push('capture.stop');
      // The final partial chunk arrives before stop resolves.
      emit?.(chunk(9, RATE / 2), finalClipped);
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
    capture: vi.fn(
      (onChunk: (samples: Float32Array, clipped: number) => void, startAt?: number) => {
        emit = onChunk;
        (capture as { startTime: number }).startTime = startAt ?? audioTime + 0.05;
        return captureError ? Promise.reject(captureError) : Promise.resolve(capture);
      },
    ),
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
    deleteTake: vi.fn(async (id: string) => {
      log.push(`deleteTake ${id}`);
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
    emit: (samples: Float32Array, clipped = 0) => emit?.(samples, clipped),
    setFinalClipped: (n: number) => (finalClipped = n),
    setElapsed: (ms: number) => (elapsed = ms),
    setClock: (s: number) => (audioTime = s),
    /** The capture stops itself at its cap (on the audio clock). */
    reachCap: () => capped.resolve(),
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
        clipped: false,
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

  it('saves clipped: true when any chunk reported clipped samples, held ones included', async () => {
    const t = setup();
    await t.session.allowMic();
    const started = t.session.record();
    await flush();
    // Held before the take exists: still counted.
    t.emit(chunk(1), 3);
    t.created.resolve();
    await started;
    t.emit(chunk(2), 0);
    await flush();
    await t.session.stop('user');
    expect(vi.mocked(t.deps.patchTake).mock.calls[0]![1]).toMatchObject({ clipped: true });
  });

  it('saves clipped: true when only the final chunk at stop clipped', async () => {
    const t = await recording();
    t.setFinalClipped(1);
    await t.session.stop('user');
    expect(vi.mocked(t.deps.patchTake).mock.calls[0]![1]).toMatchObject({ clipped: true });
  });

  it('counts each take afresh: a clean take after a clipped one saves clipped: false', async () => {
    const t = await recording();
    t.emit(chunk(3), 5);
    await t.session.stop('user');
    vi.mocked(t.deps.newId).mockReturnValue('take-2');
    const started = t.session.record();
    await flush();
    t.emit(chunk(4), 0);
    await started;
    await t.session.stop('user');
    expect(vi.mocked(t.deps.patchTake).mock.calls.map((c) => c[1].clipped)).toEqual([true, false]);
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
});

// Story 3.9: failure stops keep the take. A mic loss mid-take saves it as `mic-lost` before the
// idle rule decides the mic; a `storage-full` append saves it as `storage-full` with the banner.
describe('failure stops', () => {
  const SAVED_LOG = [
    'createTake take-1',
    'openRawWriter take-1',
    'capture.stop',
    'writeCompressed take-1 audio/webm;codecs=opus',
    'writer.close after 3 appends',
    'patchTake take-1',
  ];

  /** The input's device is gone from the list; `others` remain. */
  function unplugged(t: ReturnType<typeof setup>, others = [{ ...DEVICE, deviceId: 'mic-b' }]) {
    vi.mocked(t.deps.listMics).mockResolvedValue(others);
  }

  const storageFull = () => Promise.reject(new AppError('storage-full', 'quota exceeded'));

  it('unplug mid-take: saved as mic-lost, the input closed after, the default opened, stopped-saved notice', async () => {
    const t = await recording();
    unplugged(t);
    await t.endTrack();
    await flush();
    // The capture is stopped and the take saved before the input is released.
    expect(t.log).toEqual([...SAVED_LOG, 'input.close']);
    expect(t.deps.patchTake).toHaveBeenCalledWith(
      'take-1',
      {
        status: 'recorded',
        durationMs: 2500,
        audioMime: 'audio/webm;codecs=opus',
        stopReason: 'mic-lost',
        clipped: false,
      },
      'recording-session',
    );
    expect(t.capture.abort).not.toHaveBeenCalled();
    expect(t.deps.navigate).not.toHaveBeenCalled();
    // One default request after the allow: the fallback; recording does not continue on it.
    expect(t.deps.requestMic).toHaveBeenCalledTimes(2);
    expect(vi.mocked(t.deps.requestMic).mock.calls[1]).toEqual([]);
    expect(t.input.capture).toHaveBeenCalledTimes(1);
    expect(t.session.getSnapshot()).toMatchObject({
      mic: 'live',
      recording: 'idle',
      activeTakeId: null,
      notice: { kind: 'stopped-saved' },
      savedSeq: 1,
      storageFull: false,
    });
  });

  it('a mid-take mic loss keeps the clipped count', async () => {
    const t = await recording();
    t.emit(chunk(3), 2);
    await t.endTrack();
    await flush();
    expect(vi.mocked(t.deps.patchTake).mock.calls[0]![1]).toMatchObject({
      stopReason: 'mic-lost',
      clipped: true,
    });
  });

  it('revoke mid-take (devices still listed): saved as mic-lost, then the lost card', async () => {
    const t = await recording();
    await t.endTrack();
    await flush();
    expect(t.log).toEqual([...SAVED_LOG, 'input.close']);
    expect(vi.mocked(t.deps.patchTake).mock.calls[0]![1]).toMatchObject({
      status: 'recorded',
      stopReason: 'mic-lost',
      durationMs: 2500,
    });
    expect(t.deps.navigate).not.toHaveBeenCalled();
    expect(t.deps.requestMic).toHaveBeenCalledTimes(1);
    expect(t.session.getSnapshot()).toMatchObject({
      mic: 'error',
      errorCode: 'mic-lost',
      recording: 'idle',
      activeTakeId: null,
      savedSeq: 1,
    });
    expect(t.session.getSnapshot().notice).toBeUndefined();
    // A later chunk from the stopped capture is dropped.
    t.emit(chunk(5));
    await flush();
    expect(t.appended).toEqual([1, 2, 9]);
  });

  it('the only device unplugged mid-take: saved as mic-lost, then the lost card', async () => {
    const t = await recording();
    unplugged(t, []);
    await t.endTrack();
    await flush();
    expect(vi.mocked(t.deps.patchTake).mock.calls[0]![1]).toMatchObject({
      stopReason: 'mic-lost',
    });
    expect(t.deps.requestMic).toHaveBeenCalledTimes(1);
    expect(t.session.getSnapshot()).toMatchObject({ mic: 'error', errorCode: 'mic-lost' });
    expect(t.session.getSnapshot().notice).toBeUndefined();
  });

  it('a short mic-lost take (0.2 s) is deleted; the unplug still switches with its notice', async () => {
    const t = setup();
    await t.session.allowMic();
    const started = t.session.record();
    t.created.resolve();
    await started;
    vi.mocked(t.capture.stop).mockImplementation(async () => {
      t.log.push('capture.stop');
      t.emit(chunk(1, RATE / 5));
      return { parts: [new Blob(['webm'])] };
    });
    unplugged(t);
    await t.endTrack();
    await flush();
    expect(t.deps.deleteTake).toHaveBeenCalledWith('take-1', 'recording-session');
    expect(t.deps.writeCompressed).not.toHaveBeenCalled();
    expect(t.deps.patchTake).not.toHaveBeenCalled();
    expect(t.deps.navigate).not.toHaveBeenCalled();
    expect(t.session.getSnapshot()).toMatchObject({
      mic: 'live',
      recording: 'idle',
      // Nothing was saved, so the toast is the plain switch.
      notice: { kind: 'switched' },
      savedSeq: 0,
    });
  });

  it('a mic loss whose save fails leaves the take recording, with no error card for it', async () => {
    const t = await recording({ writeCompressed: vi.fn(storageFull) });
    unplugged(t);
    await t.endTrack();
    await flush();
    expect(t.deps.patchTake).not.toHaveBeenCalled();
    expect(t.deps.deleteTake).not.toHaveBeenCalled();
    expect(t.writer.close).toHaveBeenCalledTimes(1);
    expect(t.session.getSnapshot()).toMatchObject({
      mic: 'live',
      recording: 'idle',
      notice: { kind: 'switched' },
      savedSeq: 0,
    });
  });

  it('storage full mid-take: no more appends, saved as storage-full, mic live, the banner on', async () => {
    const t = await recording();
    const listener = vi.fn();
    t.session.subscribe(listener);
    vi.mocked(t.writer.append).mockImplementation(storageFull);
    t.emit(chunk(3));
    await flush();
    await flush();
    // The rejected chunk 3 is the last append tried; the final chunk at stop is not sent.
    expect(t.writer.append).toHaveBeenCalledTimes(3);
    expect(t.log).toEqual([
      'createTake take-1',
      'openRawWriter take-1',
      'capture.stop',
      'writeCompressed take-1 audio/webm;codecs=opus',
      'writer.close after 2 appends',
      'patchTake take-1',
    ]);
    expect(t.deps.patchTake).toHaveBeenCalledWith(
      'take-1',
      {
        status: 'recorded',
        // Only the samples actually written: chunks 1 and 2.
        durationMs: 2000,
        audioMime: 'audio/webm;codecs=opus',
        stopReason: 'storage-full',
        clipped: false,
      },
      'recording-session',
    );
    expect(t.deps.navigate).not.toHaveBeenCalled();
    expect(t.input.close).not.toHaveBeenCalled();
    expect(t.session.getSnapshot()).toMatchObject({
      mic: 'live',
      recording: 'idle',
      activeTakeId: null,
      savedSeq: 1,
      storageFull: true,
    });
    expect(t.session.getSnapshot().errorCode).toBeUndefined();
    // stopping, then idle with the banner in one notify.
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('storage full and the save fails too: the take stays recording, the banner, no error card', async () => {
    const t = await recording({ writeCompressed: vi.fn(storageFull) });
    vi.mocked(t.writer.append).mockImplementation(storageFull);
    t.emit(chunk(3));
    await flush();
    await flush();
    expect(t.deps.patchTake).not.toHaveBeenCalled();
    expect(t.deps.deleteTake).not.toHaveBeenCalled();
    expect(t.writer.close).toHaveBeenCalledTimes(1);
    expect(t.deps.navigate).not.toHaveBeenCalled();
    expect(t.input.close).not.toHaveBeenCalled();
    expect(t.session.getSnapshot()).toMatchObject({
      mic: 'live',
      recording: 'idle',
      activeTakeId: null,
      savedSeq: 0,
      storageFull: true,
    });
    expect(t.session.getSnapshot().errorCode).toBeUndefined();
  });

  it('the banner clears when the next take starts', async () => {
    const t = await recording();
    vi.mocked(t.writer.append).mockImplementation(storageFull);
    t.emit(chunk(3));
    await flush();
    await flush();
    expect(t.session.getSnapshot().storageFull).toBe(true);
    vi.mocked(t.writer.append).mockImplementation(async () => {});
    vi.mocked(t.deps.newId).mockReturnValue('take-2');
    const started = t.session.record();
    expect(t.session.getSnapshot()).toMatchObject({ recording: 'starting', storageFull: false });
    await started;
    expect(t.session.getSnapshot()).toMatchObject({ recording: 'recording', storageFull: false });
  });

  it('a short storage-full take (0.2 s) is deleted with the too-short notice, and the banner on', async () => {
    const t = setup();
    await t.session.allowMic();
    const started = t.session.record();
    t.created.resolve();
    await started;
    vi.mocked(t.capture.stop).mockImplementation(async () => {
      t.log.push('capture.stop');
      return { parts: [new Blob(['webm'])] };
    });
    // 0.2 s written, then the disk fills.
    t.emit(chunk(1, RATE / 5));
    await flush();
    vi.mocked(t.writer.append).mockImplementation(storageFull);
    t.emit(chunk(2));
    await flush();
    await flush();
    expect(t.deps.deleteTake).toHaveBeenCalledWith('take-1', 'recording-session');
    expect(t.deps.patchTake).not.toHaveBeenCalled();
    expect(t.deps.navigate).not.toHaveBeenCalled();
    expect(t.session.getSnapshot()).toMatchObject({
      mic: 'live',
      recording: 'idle',
      notice: { kind: 'too-short' },
      savedSeq: 0,
      storageFull: true,
    });
  });

  it('storage full during a Stop: saved as storage-full, no Tab', async () => {
    const t = await recording();
    vi.mocked(t.writer.append).mockImplementation(storageFull);
    t.emit(chunk(3));
    // The Stop comes before the rejection lands.
    await t.session.stop('user');
    await flush();
    expect(t.deps.patchTake).toHaveBeenCalledTimes(1);
    expect(vi.mocked(t.deps.patchTake).mock.calls[0]![1]).toMatchObject({
      stopReason: 'storage-full',
      durationMs: 2000,
    });
    expect(t.deps.navigate).not.toHaveBeenCalled();
    expect(t.session.getSnapshot()).toMatchObject({ mic: 'live', storageFull: true });
  });

  it("another append failure keeps today's behaviour: the take goes on and Stop saves it", async () => {
    const t = await recording();
    vi.mocked(t.writer.append).mockImplementationOnce(() =>
      Promise.reject(new AppError('storage-failed', 'io')),
    );
    t.emit(chunk(3));
    await flush();
    expect(t.session.getSnapshot()).toMatchObject({ recording: 'recording', storageFull: false });
    await t.session.stop('user');
    expect(vi.mocked(t.deps.patchTake).mock.calls[0]![1]).toMatchObject({
      stopReason: 'user',
      durationMs: 2500,
    });
    expect(t.deps.navigate).toHaveBeenCalledWith('take-1');
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

  it('a count-in take whose chunks clipped is saved with clipped: true', async () => {
    const t = await live(120);
    const started = t.session.record();
    await vi.advanceTimersByTimeAsync(0);
    await clockTo(t, 12.015);
    // One held chunk (before createTake resolves) and one appended chunk each report clips.
    t.emit(chunk(1), 4);
    t.created.resolve();
    await started;
    t.emit(chunk(2), 1);
    await vi.advanceTimersByTimeAsync(0);
    const stopped = t.session.stop('user');
    await vi.advanceTimersByTimeAsync(0);
    await stopped;
    expect(vi.mocked(t.deps.patchTake).mock.calls[0]![1]).toMatchObject({
      status: 'recorded',
      clipped: true,
    });
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

  it('a count-in take clears the storage-full banner: off at count-in and after beat five', async () => {
    const t = await live(120);
    // A take without the count-in first, stopped by a full disk.
    t.session.setCountIn({ on: false });
    const first = t.session.record();
    await vi.advanceTimersByTimeAsync(0);
    t.created.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await first;
    vi.mocked(t.writer.append).mockImplementation(() =>
      Promise.reject(new AppError('storage-full', 'quota exceeded')),
    );
    t.emit(chunk(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.session.getSnapshot()).toMatchObject({ recording: 'idle', storageFull: true });

    vi.mocked(t.writer.append).mockImplementation(async () => {});
    vi.mocked(t.deps.newId).mockReturnValue('take-2');
    t.session.setCountIn({ on: true });
    const second = t.session.record();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.session.getSnapshot()).toMatchObject({ recording: 'count-in', storageFull: false });
    await clockTo(t, 20);
    await second;
    expect(t.deps.createTake).toHaveBeenCalledTimes(2);
    expect(t.session.getSnapshot()).toMatchObject({ recording: 'recording', storageFull: false });
  });

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

// Story 3.7: the length cap, its warning, and short takes. The capture's elapsed time is set by
// hand; timers are faked so the limit watch runs without real time passing. The dev limits
// (8 s cap, warning 3 s before) stand in for 5:00 and 4:30.
describe('length cap and short takes', () => {
  const LIMITS = { capMs: 8_000, leadMs: 3_000 };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Live, then recording with the take created and no chunk yet. */
  async function recordingFake(overrides: Partial<RecordingDeps> = {}) {
    const t = setup({ limits: LIMITS, ...overrides });
    const allowed = t.session.allowMic();
    await vi.advanceTimersByTimeAsync(0);
    await allowed;
    const started = t.session.record();
    await vi.advanceTimersByTimeAsync(0);
    t.created.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await started;
    expect(t.session.getSnapshot().recording).toBe('recording');
    return t;
  }

  /** Emits `ms` of captured audio in chunks of at most 1 s. */
  function emitMs(t: ReturnType<typeof setup>, ms: number) {
    let left = Math.round((ms / 1000) * RATE);
    while (left > 0) {
      const n = Math.min(RATE, left);
      t.emit(chunk(1, n));
      left -= n;
    }
  }

  /** The capture's stop delivers no final chunk, so the take's length is what was emitted. */
  function exactStop(t: ReturnType<typeof setup>) {
    vi.mocked(t.capture.stop).mockImplementation(async () => {
      t.log.push('capture.stop');
      return { parts: [new Blob(['webm'])] };
    });
  }

  it('defaults to a 5:00 cap with the warning at 4:30', () => {
    expect(MAX_TAKE_MS).toBe(300_000);
    expect(WARN_LEAD_MS).toBe(30_000);
  });

  it('turns nearLimit on once at maxTakeMs − warnLeadMs', async () => {
    const t = await recordingFake();
    const listener = vi.fn();
    t.session.subscribe(listener);
    t.setElapsed(4_999);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(t.session.getSnapshot().nearLimit).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    t.setElapsed(5_000);
    await vi.advanceTimersByTimeAsync(5);
    expect(t.session.getSnapshot().nearLimit).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    t.setElapsed(6_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(t.capture.stop).not.toHaveBeenCalled();
  });

  it('schedules the cap on the audio clock when the capture starts', async () => {
    const t = await recordingFake();
    expect(vi.mocked(t.input.capture).mock.calls[0]![2]).toBe(8_000);
  });

  it('at the cap: saved as max-length and the Tab opens, with no timer needed', async () => {
    const t = await recordingFake();
    exactStop(t);
    // A throttled (hidden) tab: no timer runs, yet the capture stops itself at the cap.
    emitMs(t, 8_000);
    t.setElapsed(8_000);
    expect(t.session.getSnapshot().recording).toBe('recording');
    t.reachCap();
    // Settles the save's promises only; no timer is due.
    await vi.advanceTimersByTimeAsync(0);
    expect(t.capture.stop).toHaveBeenCalledTimes(1);
    expect(t.deps.patchTake).toHaveBeenCalledWith(
      'take-1',
      {
        status: 'recorded',
        durationMs: 8_000,
        audioMime: 'audio/webm;codecs=opus',
        stopReason: 'max-length',
        clipped: false,
      },
      'recording-session',
    );
    expect(t.deps.navigate).toHaveBeenCalledWith('take-1');
    expect(t.deps.deleteTake).not.toHaveBeenCalled();
    expect(t.session.getSnapshot()).toMatchObject({
      recording: 'idle',
      nearLimit: false,
      savedSeq: 1,
    });
  });

  it('at the cap: a take that clipped is saved as max-length with clipped: true', async () => {
    const t = await recordingFake();
    exactStop(t);
    emitMs(t, 7_000);
    t.emit(chunk(1), 2);
    t.reachCap();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(t.deps.patchTake).mock.calls[0]![1]).toMatchObject({
      stopReason: 'max-length',
      clipped: true,
    });
  });

  it('stays recording until the cap, so a Stop just before it saves as user', async () => {
    const t = await recordingFake();
    emitMs(t, 7_000);
    t.setElapsed(7_900);
    await vi.advanceTimersByTimeAsync(7_900);
    expect(t.session.getSnapshot()).toMatchObject({ recording: 'recording', nearLimit: true });
    const stopping = t.session.stop('user');
    // The cap's own stop arriving now is ignored: the user's Stop is already saving.
    t.reachCap();
    await stopping;
    await vi.advanceTimersByTimeAsync(0);
    expect(t.capture.stop).toHaveBeenCalledTimes(1);
    expect(t.deps.patchTake).toHaveBeenCalledTimes(1);
    expect(vi.mocked(t.deps.patchTake).mock.calls[0]![1]).toMatchObject({ stopReason: 'user' });
  });

  it('too short: a take stopped at 0.3 s is deleted, with a notice and no Tab', async () => {
    const t = await recordingFake();
    exactStop(t);
    emitMs(t, 300);
    const listener = vi.fn();
    t.session.subscribe(listener);
    await t.session.stop('user');
    expect(t.log).toEqual([
      'createTake take-1',
      'openRawWriter take-1',
      'capture.stop',
      'writer.close after 1 appends',
      'deleteTake take-1',
    ]);
    expect(t.deps.deleteTake).toHaveBeenCalledWith('take-1', 'recording-session');
    expect(t.deps.writeCompressed).not.toHaveBeenCalled();
    expect(t.deps.patchTake).not.toHaveBeenCalled();
    expect(t.deps.navigate).not.toHaveBeenCalled();
    expect(t.session.getSnapshot()).toMatchObject({
      mic: 'live',
      recording: 'idle',
      activeTakeId: null,
      notice: { kind: 'too-short', seq: 1 },
      savedSeq: 0,
    });
    // stopping, then idle with the notice in one notify.
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('too short with a failing delete: still discarded, idle with the notice, no error card', async () => {
    const t = await recordingFake({
      deleteTake: vi.fn(() => Promise.reject(new AppError('storage-failed', 'no'))),
    });
    exactStop(t);
    emitMs(t, 300);
    await t.session.stop('user');
    expect(t.deps.deleteTake).toHaveBeenCalledTimes(1);
    expect(t.deps.patchTake).not.toHaveBeenCalled();
    expect(t.deps.navigate).not.toHaveBeenCalled();
    expect(t.input.close).not.toHaveBeenCalled();
    expect(t.session.getSnapshot()).toMatchObject({
      mic: 'live',
      recording: 'idle',
      activeTakeId: null,
      notice: { kind: 'too-short', seq: 1 },
    });
    expect(t.session.getSnapshot().errorCode).toBeUndefined();
  });

  it('exactly 0.5 s is kept', async () => {
    const t = await recordingFake();
    exactStop(t);
    emitMs(t, 500);
    await t.session.stop('user');
    expect(t.deps.deleteTake).not.toHaveBeenCalled();
    expect(t.deps.patchTake).toHaveBeenCalledWith(
      'take-1',
      expect.objectContaining({ status: 'recorded', durationMs: 500 }),
      'recording-session',
    );
    expect(t.deps.navigate).toHaveBeenCalledWith('take-1');
    expect(t.session.getSnapshot().notice).toBeUndefined();
  });

  it('short after a count-in: stopped 0.2 s after beat five, deleted with the notice', async () => {
    const t = setup({ limits: LIMITS });
    t.prefs.countIn = { on: true, bpm: 120 };
    const session = createRecordingSession(t.deps);
    const allowed = session.allowMic();
    await vi.advanceTimersByTimeAsync(0);
    await allowed;
    const started = session.record();
    await vi.advanceTimersByTimeAsync(0);
    t.setClock(12.015);
    await vi.advanceTimersByTimeAsync(2_500);
    t.created.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await started;
    expect(session.getSnapshot().recording).toBe('recording');
    exactStop(t);
    emitMs(t, 200);
    await session.stop('user');
    expect(t.deps.deleteTake).toHaveBeenCalledWith('take-1', 'recording-session');
    expect(t.deps.patchTake).not.toHaveBeenCalled();
    expect(t.deps.navigate).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toMatchObject({
      recording: 'idle',
      notice: { kind: 'too-short', seq: 1 },
    });
  });

  it('reads the dev limits from the query, keeping the constants for missing or bad values', () => {
    expect(readDevLimits('?maxTakeMs=8000&warnLeadMs=3000')).toEqual(LIMITS);
    expect(readDevLimits('?fakeMic=x')).toEqual({
      capMs: MAX_TAKE_MS,
      leadMs: WARN_LEAD_MS,
    });
    expect(readDevLimits('?maxTakeMs=-5&warnLeadMs=abc')).toEqual({
      capMs: MAX_TAKE_MS,
      leadMs: WARN_LEAD_MS,
    });
    // The cap is at least 1 s (so a max-length take is never too short); the lead at most it.
    expect(readDevLimits('?maxTakeMs=300&warnLeadMs=200')).toEqual({ capMs: 1_000, leadMs: 200 });
    expect(readDevLimits('?maxTakeMs=2000&warnLeadMs=5000')).toEqual({
      capMs: 2_000,
      leadMs: 2_000,
    });
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

describe('handover (releaseForHandover)', () => {
  const SAVED_LOG = [
    'createTake take-1',
    'openRawWriter take-1',
    'capture.stop',
    'writeCompressed take-1 audio/webm;codecs=opus',
    'writer.close after 3 appends',
    'patchTake take-1',
  ];

  it('recording: saved as instance-lost with no navigation, then the input released', async () => {
    const t = await recording();
    const done = t.session.releaseForHandover();
    expect(t.session.getSnapshot().recording).toBe('stopping');
    await done;
    expect(t.log).toEqual([...SAVED_LOG, 'input.close']);
    expect(t.deps.patchTake).toHaveBeenCalledWith(
      'take-1',
      {
        status: 'recorded',
        durationMs: 2500,
        audioMime: 'audio/webm;codecs=opus',
        stopReason: 'instance-lost',
        clipped: false,
      },
      'recording-session',
    );
    expect(t.deps.navigate).not.toHaveBeenCalled();
    expect(t.session.getSnapshot()).toMatchObject({
      mic: 'setup',
      recording: 'idle',
      activeTakeId: null,
      savedSeq: 1,
    });
    // Handed over: no input opens and no take starts.
    await t.session.allowMic();
    await t.session.record();
    expect(t.deps.requestMic).toHaveBeenCalledTimes(1);
    expect(t.input.capture).toHaveBeenCalledTimes(1);
    // A repeat call is the same handover.
    await t.session.releaseForHandover();
    expect(t.input.close).toHaveBeenCalledTimes(1);
  });

  it('a save that fails leaves the take recording, with no error card', async () => {
    const t = await recording({
      writeCompressed: vi.fn(() => Promise.reject(new AppError('instance-taken', 'fenced'))),
    });
    await t.session.releaseForHandover();
    expect(t.deps.patchTake).not.toHaveBeenCalled();
    expect(t.deps.deleteTake).not.toHaveBeenCalled();
    expect(t.writer.close).toHaveBeenCalledTimes(1);
    expect(t.input.close).toHaveBeenCalledTimes(1);
    expect(t.session.getSnapshot()).toMatchObject({ mic: 'setup', recording: 'idle' });
    expect(t.session.getSnapshot().errorCode).toBeUndefined();
  });

  it('a take still being created is saved once it records', async () => {
    const t = setup();
    await t.session.allowMic();
    const started = t.session.record();
    await flush();
    expect(t.session.getSnapshot().recording).toBe('starting');
    const done = t.session.releaseForHandover();
    t.emit(chunk(1));
    t.created.resolve();
    await started;
    t.emit(chunk(2));
    await done;
    expect(t.deps.patchTake).toHaveBeenCalledWith(
      'take-1',
      expect.objectContaining({ status: 'recorded', stopReason: 'instance-lost' }),
      'recording-session',
    );
    expect(t.deps.navigate).not.toHaveBeenCalled();
    expect(t.input.close).toHaveBeenCalledTimes(1);
  });

  it('a Stop already saving finishes as user; the input is released after it', async () => {
    const t = await recording();
    const stopped = t.session.stop('user');
    const done = t.session.releaseForHandover();
    await stopped;
    await done;
    expect(t.deps.patchTake).toHaveBeenCalledTimes(1);
    expect(t.deps.patchTake).toHaveBeenCalledWith(
      'take-1',
      expect.objectContaining({ stopReason: 'user' }),
      'recording-session',
    );
    expect(t.log.at(-1)).toBe('input.close');
  });

  it('idle: the input is released and the mic back to setup', async () => {
    const t = setup();
    await t.session.allowMic();
    await t.session.releaseForHandover();
    expect(t.input.close).toHaveBeenCalledTimes(1);
    expect(t.deps.createTake).not.toHaveBeenCalled();
    expect(t.session.getSnapshot()).toMatchObject({ mic: 'setup', recording: 'idle' });
  });

  it('an allow still waiting is not held up, and its input is closed when it opens', async () => {
    const t = setup();
    const mic = deferred<MediaStream>();
    vi.mocked(t.deps.requestMic).mockReturnValueOnce(mic.promise);
    const allowed = t.session.allowMic();
    await t.session.releaseForHandover();
    mic.resolve({} as MediaStream);
    await allowed;
    expect(t.input.close).toHaveBeenCalledTimes(1);
    expect(t.session.getSnapshot().mic).not.toBe('live');
    expect(t.session.getAnalyser()).toBeNull();
  });

  describe('during a count-in', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('cancels it: clicks cancelled, capture aborted, no take, the input released', async () => {
      const t = setup();
      t.prefs.countIn = { on: true, bpm: 120 };
      const session = createRecordingSession(t.deps);
      const allowed = session.allowMic();
      await vi.advanceTimersByTimeAsync(0);
      await allowed;
      const started = session.record();
      await vi.advanceTimersByTimeAsync(0);
      expect(session.getSnapshot().recording).toBe('count-in');
      const done = session.releaseForHandover();
      await vi.advanceTimersByTimeAsync(0);
      await done;
      t.setClock(20);
      await vi.advanceTimersByTimeAsync(2_500);
      await started;
      expect(t.cancelClicks).toHaveBeenCalledTimes(1);
      expect(t.capture.abort).toHaveBeenCalledTimes(1);
      expect(t.deps.createTake).not.toHaveBeenCalled();
      expect(t.input.close).toHaveBeenCalledTimes(1);
      expect(session.getSnapshot()).toMatchObject({ mic: 'setup', recording: 'idle' });
    });
  });
});

describe('handover: transitions still in flight', () => {
  it('a device switch still waiting is closed when it opens', async () => {
    const t = setup();
    await t.session.allowMic();
    const mic = deferred<MediaStream>();
    vi.mocked(t.deps.requestMic).mockReturnValueOnce(mic.promise);
    const switching = t.session.selectMic('mic-b');
    await flush();
    // The old input is closed before the new device is asked for.
    expect(t.input.close).toHaveBeenCalledTimes(1);
    await t.session.releaseForHandover();
    mic.resolve({} as MediaStream);
    await switching;
    // The input that opened late is closed too (the fake returns the same input object).
    expect(t.input.close).toHaveBeenCalledTimes(2);
    expect(t.session.getSnapshot().mic).not.toBe('live');
    expect(t.session.getAnalyser()).toBeNull();
    expect(t.deps.updatePrefs).not.toHaveBeenCalledWith({ micDeviceId: 'mic-b' });
  });

  it('an unplug fallback still waiting is closed when it opens', async () => {
    const t = setup();
    await t.session.allowMic();
    vi.mocked(t.deps.listMics).mockResolvedValue([{ ...DEVICE, deviceId: 'mic-b' }]);
    const mic = deferred<MediaStream>();
    vi.mocked(t.deps.requestMic).mockReturnValueOnce(mic.promise);
    await t.endTrack();
    expect(t.deps.requestMic).toHaveBeenCalledTimes(2);
    await t.session.releaseForHandover();
    mic.resolve({} as MediaStream);
    await flush();
    await flush();
    expect(t.input.close).toHaveBeenCalledTimes(2);
    expect(t.session.getSnapshot().mic).toBe('setup');
    expect(t.session.getSnapshot().notice).toBeUndefined();
    expect(t.session.getAnalyser()).toBeNull();
  });

  it('an allow that fails after the handover leaves the mic in setup, with no error card', async () => {
    const t = setup();
    const mic = deferred<MediaStream>();
    vi.mocked(t.deps.requestMic).mockReturnValueOnce(mic.promise);
    const allowed = t.session.allowMic();
    expect(t.session.getSnapshot().mic).toBe('requesting');
    await t.session.releaseForHandover();
    mic.reject(new AppError('mic-denied', 'denied'));
    await allowed;
    expect(t.session.getSnapshot().mic).toBe('setup');
    expect(t.session.getSnapshot().errorCode).toBeUndefined();
  });

  it('an unplug whose fallback fails after the handover leaves the mic in setup', async () => {
    const t = setup();
    await t.session.allowMic();
    vi.mocked(t.deps.listMics).mockResolvedValue([{ ...DEVICE, deviceId: 'mic-b' }]);
    const mic = deferred<MediaStream>();
    vi.mocked(t.deps.requestMic).mockReturnValueOnce(mic.promise);
    await t.endTrack();
    await t.session.releaseForHandover();
    mic.reject(new AppError('mic-failed', 'failed'));
    await flush();
    await flush();
    expect(t.session.getSnapshot().mic).toBe('setup');
    expect(t.session.getSnapshot().errorCode).toBeUndefined();
  });
});

describe('recovery in the store (story 3.11)', () => {
  /** Recovery deps over one unfinished take `id` with `samples` of raw audio. */
  function recoveryDeps(id: string, samples: number): NonNullable<RecordingDeps['recovery']> {
    const stored: Take = {
      id,
      title: 'Take',
      createdAt: new Date(NOW).toISOString(),
      status: 'recording',
      durationMs: 0,
      sampleRate: RATE,
      tuning: 'EADGBE',
      micLabel: 'USB',
      audioMime: null,
      trimStartMs: 0,
      trimEndMs: null,
      settings: { ...ANALYSIS_DEFAULTS },
      analysisVersion: null,
      updatedAt: new Date(NOW).toISOString(),
    };
    return {
      listTakes: vi.fn(async () => [stored]),
      getTake: vi.fn(async (takeId: string) => (takeId === id ? stored : null)),
      listRaw: vi.fn(async () => [id]),
      listCompressed: vi.fn(async () => []),
      rawSampleCount: vi.fn(async () => samples),
      readRaw: vi.fn(async () => new Float32Array(samples)),
      readCompressed: vi.fn(async () => null),
      deleteRaw: vi.fn(async () => {}),
      deleteAudio: vi.fn(async () => {}),
      encodePcm: vi.fn(async () => new Blob(['x'], { type: 'audio/webm;codecs=opus' })),
      encodeWav: vi.fn(() => new Blob(['x'], { type: 'audio/wav' })),
    };
  }

  it('publishes the offered takes in the snapshot; Open saves recovered without savedSeq', async () => {
    const t = setup({ recovery: recoveryDeps('old', RATE * 10) });
    await t.session.scanForRecovery();
    expect(t.session.getSnapshot().recovered).toEqual([
      { id: 'old', createdAt: new Date(NOW).toISOString(), durationMs: 10_000, opening: false },
    ]);
    await t.session.openRecovered('old');
    expect(t.deps.patchTake).toHaveBeenCalledWith(
      'old',
      expect.objectContaining({ status: 'recorded', stopReason: 'recovered' }),
      'recording-session',
    );
    expect(t.log).toEqual([
      'writeCompressed old audio/webm;codecs=opus',
      'patchTake old',
      'navigate old',
    ]);
    expect(t.session.getSnapshot()).toMatchObject({ recovered: [], savedSeq: 0 });
  });

  it('own take: the take this tab is recording is never offered', async () => {
    const t = await recording({ recovery: recoveryDeps('take-1', RATE * 2) });
    await t.session.scanForRecovery();
    expect(t.session.getSnapshot().recovered).toEqual([]);
    expect(t.deps.deleteTake).not.toHaveBeenCalled();
  });

  it('after a handover the scan does nothing', async () => {
    const recovery = recoveryDeps('old', RATE * 2);
    const t = setup({ recovery });
    await t.session.releaseForHandover();
    await t.session.scanForRecovery();
    expect(recovery.listTakes).not.toHaveBeenCalled();
    expect(t.session.getSnapshot().recovered).toEqual([]);
  });

  it('Discard deletes the take and drops its banner', async () => {
    const t = setup({ recovery: recoveryDeps('old', RATE * 2) });
    await t.session.scanForRecovery();
    await t.session.discardRecovered('old');
    expect(t.deps.deleteTake).toHaveBeenCalledWith('old', 'recording-session');
    expect(t.session.getSnapshot().recovered).toEqual([]);
  });

  it('beforeunload: guarded only while a take runs', async () => {
    const remove = vi.fn();
    let handler: ((event: BeforeUnloadEvent) => void) | null = null;
    const addUnloadGuard = vi.fn((h: (event: BeforeUnloadEvent) => void) => {
      handler = h;
      return remove;
    });
    const t = setup({ addUnloadGuard });
    await t.session.allowMic();
    expect(addUnloadGuard).not.toHaveBeenCalled();
    const started = t.session.record();
    expect(addUnloadGuard).toHaveBeenCalledTimes(1);
    t.created.resolve();
    await started;
    expect(addUnloadGuard).toHaveBeenCalledTimes(1);
    const event = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    handler!(event as unknown as BeforeUnloadEvent);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.returnValue).toBe(true);
    t.setElapsed(5000);
    t.emit(chunk(1));
    await t.session.stop('user');
    expect(t.session.getSnapshot().recording).toBe('idle');
    expect(remove).toHaveBeenCalledTimes(1);
    expect(addUnloadGuard).toHaveBeenCalledTimes(1);
  });

  it('beforeunload: guarded while a recovered take is being rebuilt, removed when done', async () => {
    const remove = vi.fn();
    const addUnloadGuard = vi.fn(() => remove);
    const recovery = recoveryDeps('old', RATE * 2);
    let finish!: (blob: Blob) => void;
    vi.mocked(recovery.encodePcm).mockReturnValueOnce(
      new Promise<Blob>((resolve) => (finish = resolve)),
    );
    const t = setup({ recovery, addUnloadGuard });
    await t.session.scanForRecovery();
    expect(addUnloadGuard).not.toHaveBeenCalled();
    const opening = t.session.openRecovered('old');
    await flush();
    expect(t.session.getSnapshot().recording).toBe('idle');
    expect(addUnloadGuard).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    finish(new Blob(['x'], { type: 'audio/webm;codecs=opus' }));
    await opening;
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('beforeunload: a count-in is guarded too, and its cancel removes the guard', async () => {
    const remove = vi.fn();
    const addUnloadGuard = vi.fn(() => remove);
    const t = setup({ addUnloadGuard });
    t.prefs.countIn = { on: true, bpm: 120 };
    const session = createRecordingSession(t.deps);
    await session.allowMic();
    void session.record();
    await flush();
    expect(session.getSnapshot().recording).toBe('count-in');
    expect(addUnloadGuard).toHaveBeenCalledTimes(1);
    await session.stop('user');
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
