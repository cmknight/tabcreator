import { describe, expect, it } from 'vitest';
import {
  createEngineClient,
  type EngineWorker,
  type FromWorker,
  type ToWorker,
} from '../../src/engine/engine-client';
import { AppError } from '../../src/model/errors';
import type { EngineAnalyzeInput } from '../../src/model/types';

const INPUT: EngineAnalyzeInput = {
  sensitivity: 0.5,
  minNoteMs: 40,
  maxFret: 24,
  trimStartMs: 0,
  trimEndMs: null,
  skipStartMs: 0,
};

class FakeWorker implements EngineWorker {
  posted: { message: ToWorker; transfer: Transferable[] }[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  /** When set, the next postMessage throws this instead of posting. */
  throwOnce: unknown = null;

  postMessage(message: ToWorker, transfer: Transferable[]) {
    if (this.throwOnce) {
      const err = this.throwOnce;
      this.throwOnce = null;
      throw err;
    }
    this.posted.push({ message, transfer });
  }
  terminate() {
    this.terminated = true;
  }
  emit(data: FromWorker) {
    this.onmessage?.({ data } as MessageEvent<FromWorker>);
  }
  /** The request currently being processed (the last one posted). */
  get last(): ToWorker {
    const entry = this.posted.at(-1);
    if (!entry) throw new Error('nothing posted');
    return entry.message;
  }
  reply(payload: unknown) {
    this.emit({ type: 'result', reqId: this.last.reqId, payload });
  }
}

function setup() {
  const workers: FakeWorker[] = [];
  const client = createEngineClient(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  });
  const current = () => {
    const w = workers.at(-1);
    if (!w) throw new Error('no worker');
    return w;
  };
  /** Completes init of the current worker, spawning it first if nothing has yet. */
  const ready = () => {
    if (workers.length === 0) void client.version();
    current().emit({ type: 'ready', version: '0.1.0' });
  };
  return { client, workers, current, ready };
}

const pcm = () => new Float32Array(16);
const note = { midi: 40, startMs: 0, endMs: 100 };
const flush = () => new Promise((r) => setTimeout(r, 0));

async function rejection(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error('expected a rejection');
}

describe('engine client', () => {
  it('creates the worker lazily and resolves version() from ready', async () => {
    const { client, workers, ready } = setup();
    expect(workers).toHaveLength(0);
    const v = client.version();
    expect(workers).toHaveLength(1);
    ready();
    await expect(v).resolves.toBe('0.1.0');
    await expect(client.version()).resolves.toBe('0.1.0');
    expect(workers).toHaveLength(1);
  });

  it('waits for ready before sending and transfers the PCM buffer', () => {
    const { client, current, ready } = setup();
    const samples = pcm();
    void client.analyze('t1', samples, 48000, INPUT);
    expect(current().posted).toHaveLength(0);
    ready();
    const [sent] = current().posted;
    expect(sent?.message).toMatchObject({ type: 'analyze', takeId: 't1', sampleRate: 48000 });
    expect(sent?.message.type === 'analyze' && sent.message.input).toEqual(INPUT);
    expect(sent?.transfer).toEqual([samples.buffer]);
  });

  it('correlates results by reqId and runs one request at a time', async () => {
    const { client, current, ready } = setup();
    ready();
    const a = client.mapFrets('t1', [note], [], 24);
    const b = client.mapFrets('t1', [{ ...note, midi: 64 }], [], 24);
    expect(current().posted).toHaveLength(1);
    const first = current().last.reqId;
    // A stray result for an unknown reqId is ignored.
    current().emit({ type: 'result', reqId: 999, payload: 'stray' });
    current().reply(['A']);
    expect(current().posted).toHaveLength(2);
    expect(current().last.reqId).not.toBe(first);
    current().reply(['B']);
    await expect(a).resolves.toEqual(['A']);
    await expect(b).resolves.toEqual(['B']);
  });

  it('runs mapFrets ahead of queued analyze requests', async () => {
    const { client, current, ready } = setup();
    ready();
    const a = client.analyze('t1', pcm(), 48000, INPUT);
    const b = client.analyze('t1', pcm(), 48000, INPUT);
    const c = client.mapFrets('t2', [note], [], 24);
    current().reply('A');
    expect(current().last.type).toBe('mapFrets');
    current().reply('C');
    expect(current().last.type).toBe('analyze');
    current().reply('B');
    await expect(a).resolves.toBe('A');
    await expect(c).resolves.toBe('C');
    await expect(b).resolves.toBe('B');
  });

  it('cancel of another take drops only its queued requests', async () => {
    const { client, workers, current, ready } = setup();
    ready();
    const y = client.analyze('Y', pcm(), 48000, INPUT);
    const x1 = client.analyze('X', pcm(), 48000, INPUT);
    const x2 = client.mapFrets('X', [note], [], 24);
    client.cancel('X');
    expect((await rejection(x1)).code).toBe('analysis-cancelled');
    expect((await rejection(x2)).code).toBe('analysis-cancelled');
    expect(current().terminated).toBe(false);
    current().reply('Y');
    await expect(y).resolves.toBe('Y');
    expect(current().posted).toHaveLength(1);
    expect(workers).toHaveLength(1);
  });

  it('cancel of the in-flight take terminates and respawns the worker; the queue continues', async () => {
    const { client, workers, ready } = setup();
    ready();
    const y = client.analyze('Y', pcm(), 48000, INPUT);
    const z = client.mapFrets('Z', [note], [], 24);
    const first = workers[0];
    if (!first) throw new Error('no worker');
    // mapFrets for Z is queued behind the in-flight analyze for Y.
    client.cancel('Y');
    expect(first.terminated).toBe(true);
    expect((await rejection(y)).code).toBe('analysis-cancelled');
    expect(workers).toHaveLength(2);
    ready();
    const second = workers[1];
    expect(second?.last.type).toBe('mapFrets');
    second?.reply('Z');
    await expect(z).resolves.toBe('Z');
    // A late message from the terminated worker is ignored.
    first.emit({ type: 'result', reqId: 1, payload: 'late' });
  });

  it('cancelAll rejects every request with analysis-cancelled and terminates the in-flight worker', async () => {
    const { client, workers, ready } = setup();
    ready();
    const y = client.analyze('Y', pcm(), 48000, INPUT);
    const z = client.mapFrets('Z', [note], [], 24);
    const x = client.analyze('X', pcm(), 48000, INPUT);
    const first = workers[0];
    if (!first) throw new Error('no worker');
    client.cancelAll();
    expect(first.terminated).toBe(true);
    for (const p of [y, z, x]) expect((await rejection(p)).code).toBe('analysis-cancelled');
    // Nothing is left to run: no worker is respawned until the next request.
    expect(workers).toHaveLength(1);
    first.emit({ type: 'result', reqId: 1, payload: 'late' });
    const next = client.mapFrets('W', [note], [], 24);
    expect(workers).toHaveLength(2);
    ready();
    workers[1]?.reply('W');
    await expect(next).resolves.toBe('W');
  });

  it('cancelAll with nothing pending keeps the idle worker', () => {
    const { client, current, ready } = setup();
    ready();
    client.cancelAll();
    expect(current().terminated).toBe(false);
  });

  it('rejects a failed request with analysis-failed and keeps serving', async () => {
    const { client, current, ready } = setup();
    ready();
    const a = client.analyze('t1', pcm(), 48000, INPUT);
    const b = client.mapFrets('t1', [note], [], 24);
    current().emit({
      type: 'error',
      reqId: current().last.reqId,
      code: 'analysis-failed',
      message: 'panicked at boom',
    });
    const err = await rejection(a);
    expect(err.code).toBe('analysis-failed');
    expect(err.message).toBe('panicked at boom');
    expect(current().terminated).toBe(false);
    current().reply([null]);
    await expect(b).resolves.toEqual([null]);
  });

  it('forwards progress for the in-flight analyze only', async () => {
    const { client, current, ready } = setup();
    ready();
    const seen: number[] = [];
    const a = client.analyze('t1', pcm(), 48000, INPUT, (f) => seen.push(f));
    const reqId = current().last.reqId;
    current().emit({ type: 'progress', reqId, fraction: 0.25 });
    current().emit({ type: 'progress', reqId: reqId + 100, fraction: 0.9 });
    current().emit({ type: 'progress', reqId, fraction: 1 });
    current().reply({
      notes: [],
      tuningOffsetCents: 0,
      belowRangeNotes: 0,
      confidenceThreshold: 0.35,
    });
    await a;
    expect(seen).toEqual([0.25, 1]);
  });

  it('rejects a request that cannot be posted with analysis-failed and keeps the queue moving', async () => {
    const { client, current, ready } = setup();
    ready();
    const clone = new DOMException('buffer is detached', 'DataCloneError');
    current().throwOnce = clone;
    const a = client.analyze('t1', pcm(), 48000, INPUT);
    const b = client.mapFrets('t1', [note], [], 24);
    const err = await rejection(a);
    expect(err.code).toBe('analysis-failed');
    expect(err.cause).toBe(clone);
    expect(current().last.type).toBe('mapFrets');
    current().reply(['B']);
    await expect(b).resolves.toEqual(['B']);
  });

  it('fails the in-flight request on a worker error after ready and respawns', async () => {
    const { client, workers, current, ready } = setup();
    ready();
    const a = client.analyze('A', pcm(), 48000, INPUT);
    const b = client.mapFrets('B', [note], [], 24);
    const first = current();
    first.onerror?.({ message: 'boom', preventDefault() {} } as ErrorEvent);
    const err = await rejection(a);
    expect(err.code).toBe('analysis-failed');
    expect(err.message).toBe('boom');
    expect(first.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(current().posted).toHaveLength(0);
    ready();
    expect(current().last).toMatchObject({ type: 'mapFrets', takeId: 'B' });
    current().reply(['B']);
    await expect(b).resolves.toEqual(['B']);
    const later = client.analyze('A', pcm(), 48000, INPUT);
    expect(current().last.type).toBe('analyze');
    current().reply('later');
    await expect(later).resolves.toBe('later');
  });

  it('latches engine-unavailable on init failure', async () => {
    const { client, workers, current } = setup();
    const pending = client.analyze('t1', pcm(), 48000, INPUT);
    const version = client.version();
    current().emit({
      type: 'error',
      reqId: null,
      code: 'engine-unavailable',
      message: 'fetch failed',
    });
    expect((await rejection(pending)).code).toBe('engine-unavailable');
    expect((await rejection(version)).code).toBe('engine-unavailable');
    expect((await rejection(client.mapFrets('t1', [note], [], 24))).code).toBe(
      'engine-unavailable',
    );
    expect((await rejection(client.version())).code).toBe('engine-unavailable');
    expect(current().terminated).toBe(true);
    expect(workers).toHaveLength(1);
  });

  it('treats a worker error before ready as engine-unavailable', async () => {
    const { client, current } = setup();
    const version = client.version();
    current().onerror?.({ message: 'script failed', preventDefault() {} } as ErrorEvent);
    expect((await rejection(version)).code).toBe('engine-unavailable');
  });

  it('treats a throwing worker constructor as engine-unavailable', async () => {
    const client = createEngineClient(() => {
      throw new Error('no workers');
    });
    expect((await rejection(client.version())).code).toBe('engine-unavailable');
    await flush();
    expect((await rejection(client.analyze('t', pcm(), 48000, INPUT))).code).toBe(
      'engine-unavailable',
    );
  });
});
