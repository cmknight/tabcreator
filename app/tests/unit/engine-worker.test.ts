import { describe, expect, it } from 'vitest';
import type { FromWorker, ToWorker } from '../../src/engine/engine-client';
import {
  createEngineHandler,
  initEngineWorker,
  PROGRESS_INTERVAL_MS,
  type LoadedEngine,
} from '../../src/engine/engine-worker';

const EMPTY = '{"notes":[],"tuningOffsetCents":0,"belowRangeNotes":0}';

function fakeEngine(overrides: Partial<LoadedEngine> = {}): LoadedEngine {
  return {
    analyze: () => EMPTY,
    map_frets: () => '[{"string":6,"fret":0}]',
    engine_version: () => '0.1.0',
    ...overrides,
  };
}

const analyzeMsg = (reqId: number): ToWorker => ({
  type: 'analyze',
  reqId,
  takeId: 't1',
  pcm: new Float32Array(8),
  sampleRate: 48000,
  input: {
    sensitivity: 0.5,
    minNoteMs: 40,
    maxFret: 24,
    trimStartMs: 0,
    trimEndMs: null,
    skipStartMs: 0,
  },
});

const mapMsg = (reqId: number): ToWorker => ({
  type: 'mapFrets',
  reqId,
  takeId: 't1',
  notes: [{ midi: 40, startMs: 0, endMs: 100 }],
  locks: [],
  maxFret: 24,
});

describe('engine worker init', () => {
  it('posts ready with the engine version', async () => {
    const posted: FromWorker[] = [];
    const handle = await initEngineWorker(
      async () => fakeEngine(),
      (m) => posted.push(m),
    );
    expect(handle).not.toBeNull();
    expect(posted).toEqual([{ type: 'ready', version: '0.1.0' }]);
  });

  it('posts one engine-unavailable error with reqId null when loading fails', async () => {
    const posted: FromWorker[] = [];
    const handle = await initEngineWorker(
      () => Promise.reject(new Error('wasm fetch failed')),
      (m) => posted.push(m),
    );
    expect(handle).toBeNull();
    expect(posted).toEqual([
      { type: 'error', reqId: null, code: 'engine-unavailable', message: 'wasm fetch failed' },
    ]);
  });
});

describe('engine worker handler', () => {
  it('returns parsed results for analyze and mapFrets', () => {
    const posted: FromWorker[] = [];
    const calls: unknown[][] = [];
    const handle = createEngineHandler(
      fakeEngine({
        map_frets: (...args) => {
          calls.push(args);
          return '[null]';
        },
      }),
      (m) => posted.push(m),
    );
    handle(analyzeMsg(1));
    handle(mapMsg(2));
    expect(posted).toEqual([
      { type: 'progress', reqId: 1, fraction: 1 },
      { type: 'result', reqId: 1, payload: JSON.parse(EMPTY) },
      { type: 'result', reqId: 2, payload: [null] },
    ]);
    expect(calls).toEqual([['[{"midi":40,"startMs":0,"endMs":100}]', '[]', 24]]);
  });

  it('passes the analyze input as EngineAnalyzeInput JSON', () => {
    let seen = '';
    const handle = createEngineHandler(
      fakeEngine({
        analyze: (_pcm, _rate, json) => {
          seen = json;
          return EMPTY;
        },
      }),
      () => {},
    );
    const msg = analyzeMsg(1);
    handle(msg);
    expect(msg.type === 'analyze' && JSON.parse(seen)).toEqual(msg.type === 'analyze' && msg.input);
  });

  it('turns a throw (panic) into analysis-failed and keeps serving', () => {
    const posted: FromWorker[] = [];
    let fail = true;
    const handle = createEngineHandler(
      fakeEngine({
        analyze: () => {
          if (fail) {
            fail = false;
            throw new Error('panicked at src/lib.rs: boom');
          }
          return EMPTY;
        },
      }),
      (m) => posted.push(m),
    );
    handle(analyzeMsg(1));
    handle(analyzeMsg(2));
    expect(posted[0]).toEqual({
      type: 'error',
      reqId: 1,
      code: 'analysis-failed',
      message: 'panicked at src/lib.rs: boom',
    });
    expect(posted.at(-1)).toEqual({ type: 'result', reqId: 2, payload: JSON.parse(EMPTY) });
  });

  it('turns invalid JSON from the engine into analysis-failed', () => {
    const posted: FromWorker[] = [];
    const handle = createEngineHandler(fakeEngine({ map_frets: () => 'nope' }), (m) =>
      posted.push(m),
    );
    handle(mapMsg(3));
    expect(posted).toMatchObject([{ type: 'error', reqId: 3, code: 'analysis-failed' }]);
  });

  it('throttles progress to one per 100 ms, monotone, and always sends 1', () => {
    let clock = 0;
    const posted: FromWorker[] = [];
    const handle = createEngineHandler(
      fakeEngine({
        analyze: (_pcm, _rate, _json, progress) => {
          // 200 reports, 7 ms apart, with a backwards step every 10th.
          for (let i = 0; i < 200; i++) {
            clock += 7;
            progress(i % 10 === 9 ? 0 : i / 200);
          }
          return EMPTY;
        },
      }),
      (m) => posted.push(m),
      () => clock,
    );
    handle(analyzeMsg(1));
    const progress = posted.filter(
      (m): m is Extract<FromWorker, { type: 'progress' }> => m.type === 'progress',
    );
    const fractions = progress.map((m) => m.fraction);
    expect(fractions.at(-1)).toBe(1);
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]).toBeGreaterThan(fractions[i - 1] ?? -1);
    }
    // 1400 ms of reports → at most 15 throttled messages plus the final 1.
    expect(progress.length).toBeLessThanOrEqual(1400 / PROGRESS_INTERVAL_MS + 2);
    expect(progress.length).toBeGreaterThan(5);
    expect(posted.at(-1)).toMatchObject({ type: 'result', reqId: 1 });
  });

  it('does not repeat 1 when the engine already reported it', () => {
    const posted: FromWorker[] = [];
    const handle = createEngineHandler(
      fakeEngine({
        analyze: (_pcm, _rate, _json, progress) => {
          progress(1);
          return EMPTY;
        },
      }),
      (m) => posted.push(m),
    );
    handle(analyzeMsg(1));
    expect(posted.filter((m) => m.type === 'progress')).toHaveLength(1);
  });
});
