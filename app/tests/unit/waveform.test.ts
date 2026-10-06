import { describe, expect, it, vi } from 'vitest';
import {
  createWaveformHandler,
  type FromWaveformWorker,
  type ToWaveformWorker,
} from '../../src/audio/waveform-worker';
import { AppError } from '../../src/model/errors';
import { reducePeaks } from '../../src/model/waveform';
import {
  createWaveform,
  PEAKS_CACHE_SIZE,
  type WaveformDeps,
  type WaveformWorkerLike,
} from '../../src/session/waveform';
import type { StorageListener } from '../../src/storage/events';

// Story "Trim": the Trim strip's waveform: the min/max reduction, the worker's handler, and the
// session's PCM source, worker protocol, cache and release.

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('reducePeaks', () => {
  it('one min and max per column over buckets that tile the PCM', () => {
    const pcm = Float32Array.from([0.1, -0.5, 0.3, 0.9, -0.2, 0.0, -1, 0.4]);
    const { min, max } = reducePeaks(pcm, 4);
    expect([...min]).toEqual([-0.5, 0.3, -0.2, -1].map(Math.fround));
    expect([...max]).toEqual([0.1, 0.9, 0.0, 0.4].map(Math.fround));
  });

  it('uneven buckets: every sample counted once', () => {
    const pcm = Float32Array.from([1, 2, 3, 4, 5, 6, 7]);
    const { min, max } = reducePeaks(pcm, 3);
    // floor(c·7/3): 0, 2, 4, 7.
    expect([...min]).toEqual([1, 3, 5]);
    expect([...max]).toEqual([2, 4, 7]);
  });

  it('more columns than samples: each column takes the sample it falls on', () => {
    const { min, max } = reducePeaks(Float32Array.from([0.5, -0.5]), 4);
    expect([...min]).toEqual([0.5, 0.5, -0.5, -0.5]);
    expect([...max]).toEqual([0.5, 0.5, -0.5, -0.5]);
  });

  it('no PCM or no columns', () => {
    expect([...reducePeaks(new Float32Array(0), 3).min]).toEqual([0, 0, 0]);
    expect(reducePeaks(Float32Array.from([1]), 0).max).toHaveLength(0);
  });
});

describe('waveform worker handler', () => {
  it('keeps the loaded PCM, answers peaks requests by id, and forgets it on release', () => {
    const handle = createWaveformHandler();
    expect(handle({ kind: 'load', takeId: 't1', pcm: Float32Array.from([0.2, -0.4]) })).toBeNull();
    const reply = handle({ kind: 'peaks', reqId: 7, takeId: 't1', columns: 1 });
    expect(reply).toMatchObject({ reqId: 7, ok: true });
    if (!reply?.ok) throw new Error('failed');
    expect([...reply.min]).toEqual([Math.fround(-0.4)]);
    expect([...reply.max]).toEqual([Math.fround(0.2)]);
    expect(handle({ kind: 'release', takeId: 't1' })).toBeNull();
    expect(handle({ kind: 'peaks', reqId: 8, takeId: 't1', columns: 1 })).toMatchObject({
      reqId: 8,
      ok: false,
    });
  });
});

/** A fake worker: records messages; `reply` answers a request; `fail`/`garble` break it. */
function fakeWorker() {
  const posted: { message: ToWaveformWorker; transfer?: Transferable[] }[] = [];
  const handle = createWaveformHandler();
  const worker: WaveformWorkerLike & {
    posted: typeof posted;
    reply(reqId: number): void;
    terminated: boolean;
  } = {
    posted,
    terminated: false,
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(message, transfer) {
      posted.push({ message, transfer });
      if (message.kind !== 'peaks') handle(message);
    },
    reply(reqId) {
      const request = posted.find(
        (p) => p.message.kind === 'peaks' && p.message.reqId === reqId,
      )!.message;
      const answer = handle(request) as FromWaveformWorker;
      worker.onmessage?.({ data: answer });
    },
    terminate() {
      worker.terminated = true;
    },
  };
  return worker;
}

const TAKE = { id: 't1', audioMime: 'audio/webm', sampleRate: 48_000 };
const RAW = () => Float32Array.from([0.1, -0.1, 0.5, -0.5]);

function setup(over: Partial<WaveformDeps> = {}) {
  const workers: ReturnType<typeof fakeWorker>[] = [];
  let storage: StorageListener | null = null;
  const deps: WaveformDeps = {
    audio: {
      readRaw: vi.fn(async () => RAW()),
      readCompressed: vi.fn(async () => new Blob(['x'])),
    },
    decode: vi.fn(async () => ({ pcm: Float32Array.from([0.25, -0.75]), sampleRate: 48_000 })),
    createWorker: vi.fn(() => {
      const w = fakeWorker();
      workers.push(w);
      return w;
    }),
    subscribeStorage: (l) => {
      storage = l;
      return () => {};
    },
    ...over,
  };
  const waveform = createWaveform(deps);
  const peaksRequests = (w = workers.at(-1)!) =>
    w.posted.flatMap((p) => (p.message.kind === 'peaks' ? [p.message.reqId] : []));
  return {
    deps,
    waveform,
    workers,
    peaksRequests,
    emit: (e: Parameters<StorageListener>[0]) => storage?.(e),
  };
}

describe('session waveform', () => {
  it('sends the PCM once per take (transferred), then one peaks request per column count; cached', async () => {
    const { deps, waveform, workers, peaksRequests } = setup();
    const two = waveform.loadPeaks(TAKE, 2);
    await settle();
    const w = workers[0]!;
    expect(w.posted[0]!.message).toMatchObject({ kind: 'load', takeId: 't1' });
    expect(w.posted[0]!.transfer).toHaveLength(1);
    w.reply(peaksRequests()[0]!);
    const a = await two;
    expect([...a.max]).toEqual([0.1, 0.5].map(Math.fround));
    expect(await waveform.loadPeaks(TAKE, 2)).toBe(a);
    const four = waveform.loadPeaks(TAKE, 4);
    await settle();
    w.reply(peaksRequests()[1]!);
    await four;
    expect(w.posted.filter((p) => p.message.kind === 'load')).toHaveLength(1);
    expect(deps.audio.readRaw).toHaveBeenCalledTimes(1);
    expect(deps.createWorker).toHaveBeenCalledTimes(1);
  });

  it('routes out-of-order replies by request id', async () => {
    const { waveform, workers, peaksRequests } = setup();
    const two = waveform.loadPeaks(TAKE, 2);
    const one = waveform.loadPeaks(TAKE, 1);
    await settle();
    const [r2, r1] = peaksRequests();
    workers[0]!.reply(r1!);
    workers[0]!.reply(r2!);
    expect((await one).min).toHaveLength(1);
    expect((await two).min).toHaveLength(2);
  });

  it('a worker error rejects every pending request; the next request starts a new worker and sends the PCM again', async () => {
    const { deps, waveform, workers } = setup();
    const a = waveform.loadPeaks(TAKE, 2);
    const b = waveform.loadPeaks(TAKE, 3);
    await settle();
    workers[0]!.onerror?.(new Event('error'));
    await expect(a).rejects.toBeInstanceOf(AppError);
    await expect(b).rejects.toBeInstanceOf(AppError);
    expect(workers[0]!.terminated).toBe(true);
    const c = waveform.loadPeaks(TAKE, 2); // the failed load was not cached
    await settle();
    expect(deps.createWorker).toHaveBeenCalledTimes(2);
    const w = workers[1]!;
    expect(w.posted[0]!.message.kind).toBe('load');
    w.reply((w.posted[1]!.message as { reqId: number }).reqId);
    await expect(c).resolves.toBeTruthy();
  });

  it('an unreadable reply (messageerror) rejects the pending requests too', async () => {
    const { waveform, workers } = setup();
    const a = waveform.loadPeaks(TAKE, 2);
    await settle();
    workers[0]!.onmessageerror?.(new Event('messageerror'));
    await expect(a).rejects.toBeInstanceOf(AppError);
  });

  it('no Worker: the same reduction on the main thread', async () => {
    const { waveform } = setup({ createWorker: () => null });
    const peaks = await waveform.loadPeaks(TAKE, 2);
    expect([...peaks.min]).toEqual([-0.1, -0.5].map(Math.fround));
  });

  it(`keeps at most ${PEAKS_CACHE_SIZE} peak sets, least recently used dropped`, async () => {
    const { waveform } = setup({ createWorker: () => null });
    const first = await waveform.loadPeaks(TAKE, 1);
    for (let c = 2; c <= PEAKS_CACHE_SIZE + 1; c++) await waveform.loadPeaks(TAKE, c);
    expect(await waveform.loadPeaks(TAKE, 1)).not.toBe(first);
    const recent = await waveform.loadPeaks(TAKE, PEAKS_CACHE_SIZE + 1);
    expect(await waveform.loadPeaks(TAKE, PEAKS_CACHE_SIZE + 1)).toBe(recent);
  });

  it('release drops the PCM in the worker and the cached peaks; a deleted take is released', async () => {
    const { deps, waveform, workers, peaksRequests, emit } = setup();
    const a = waveform.loadPeaks(TAKE, 2);
    await settle();
    workers[0]!.reply(peaksRequests()[0]!);
    const first = await a;
    waveform.release('t1');
    expect(workers[0]!.posted.at(-1)!.message).toEqual({ kind: 'release', takeId: 't1' });
    const again = waveform.loadPeaks(TAKE, 2);
    await settle();
    expect(deps.audio.readRaw).toHaveBeenCalledTimes(2); // read and sent again
    workers[0]!.reply(peaksRequests().at(-1)!);
    expect(await again).not.toBe(first);
    emit({ type: 'take-deleted', takeId: 't1', writer: 'library-session' });
    expect(workers[0]!.posted.at(-1)!.message).toEqual({ kind: 'release', takeId: 't1' });
  });

  it('no raw file: the compressed audio decoded at the take rate', async () => {
    const { deps, waveform } = setup({
      createWorker: () => null,
      audio: {
        readRaw: vi.fn(async () => {
          throw new AppError('audio-missing', 'no raw');
        }),
        readCompressed: vi.fn(async () => new Blob(['x'])),
      },
    });
    const peaks = await waveform.loadPeaks(TAKE, 1);
    expect(deps.decode).toHaveBeenCalledWith(expect.any(Blob), 48_000);
    expect([...peaks.min]).toEqual([-0.75]);
  });

  it('no audio at all: rejects audio-missing, and a failed load is not cached', async () => {
    const readRaw = vi.fn(async (): Promise<Float32Array> => {
      throw new AppError('audio-missing', 'no raw');
    });
    const { waveform } = setup({
      createWorker: () => null,
      audio: { readRaw, readCompressed: vi.fn(async () => null) },
    });
    const none = { ...TAKE, audioMime: null };
    await expect(waveform.loadPeaks(none, 2)).rejects.toMatchObject({ code: 'audio-missing' });
    readRaw.mockResolvedValueOnce(RAW());
    await expect(waveform.loadPeaks(none, 2)).resolves.toBeTruthy();
  });
});
