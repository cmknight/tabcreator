import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/model/errors';
import { CLIP_LEVEL } from '../../src/model/level-warnings';
import type { Take } from '../../src/model/types';
import {
  createRecordingRecovery,
  type RecoveredTake,
  type RecoveryDeps,
  type RecoveryHost,
} from '../../src/session/recording-recovery';
import type { CompressedFile } from '../../src/storage/audio-store';
import { deferred } from './helpers';

// Story 3.11: the recovery scan, Open and Discard, with fake storage holding takes, raw files
// (sample arrays) and compressed files (blobs), and a fake encoder.

const RATE = 48_000;

function take(id: string, fields: Partial<Take> = {}): Take {
  return {
    id,
    title: `Take ${id}`,
    createdAt: `2026-10-02T21:14:0${id.length % 10}.000Z`,
    status: 'recording',
    durationMs: 0,
    sampleRate: RATE,
    tuning: 'EADGBE',
    micLabel: 'USB',
    audioMime: null,
    trimStartMs: 0,
    trimEndMs: null,
    settings: { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 },
    analysisVersion: null,
    updatedAt: '2026-10-02T21:14:00.000Z',
    ...fields,
  };
}

const seconds = (s: number, value = 0.1) => new Float32Array(Math.round(s * RATE)).fill(value);

interface World {
  takes: Map<string, Take>;
  raw: Map<string, Float32Array>;
  audio: Map<string, Blob>;
  /** What each take's compressed copy decodes to; a take not listed fails to decode. */
  decoded: Map<string, Float32Array>;
}

function setup(
  world: Partial<World> = {},
  options: { activeTakeId?: string | null; recording?: boolean } = {},
) {
  const takes = world.takes ?? new Map<string, Take>();
  const raw = world.raw ?? new Map<string, Float32Array>();
  const audio = world.audio ?? new Map<string, Blob>();
  const decoded = world.decoded ?? new Map<string, Float32Array>();
  const log: string[] = [];
  let published: readonly RecoveredTake[] = [];
  let activeTakeId = options.activeTakeId ?? null;
  let recording = options.recording ?? false;
  let handedOver = false;
  const extOf = (blob: Blob) =>
    blob.type === 'audio/wav' ? 'wav' : blob.type.startsWith('audio/ogg') ? 'ogg' : 'webm';
  const deps: RecoveryDeps = {
    listTakes: vi.fn(async () =>
      [...takes.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    ),
    getTake: vi.fn(async (id: string) => takes.get(id) ?? null),
    listRaw: vi.fn(async () => [...raw.keys()].sort()),
    listCompressed: vi.fn(async () =>
      [...audio.entries()].map(([id, b]): CompressedFile => ({ id, ext: extOf(b), size: b.size })),
    ),
    rawSampleCount: vi.fn(async (id: string) => raw.get(id)?.length ?? 0),
    readRaw: vi.fn(async (id: string) => {
      const samples = raw.get(id);
      if (!samples) throw new AppError('audio-missing', 'no raw');
      return samples;
    }),
    readCompressed: vi.fn(async (id: string) => audio.get(id) ?? null),
    deleteRaw: vi.fn(async (id: string) => {
      log.push(`deleteRaw ${id}`);
      raw.delete(id);
    }),
    deleteAudio: vi.fn(async (id: string) => {
      log.push(`deleteAudio ${id}`);
      audio.delete(id);
    }),
    encodePcm: vi.fn(async (samples: Float32Array, rate: number) => {
      log.push(`encodePcm ${samples.length} ${rate}`);
      return new Blob(['opus'], { type: 'audio/webm;codecs=opus' });
    }),
    encodeWav: vi.fn((samples: Float32Array, rate: number) => {
      log.push(`encodeWav ${samples.length} ${rate}`);
      return new Blob(['wav'], { type: 'audio/wav' });
    }),
    decode: vi.fn(async (blob: Blob) => {
      const id = [...audio.entries()].find(([, b]) => b === blob)?.[0];
      const pcm = id === undefined ? undefined : decoded.get(id);
      if (!pcm) throw new AppError('analysis-failed', 'undecodable');
      return { pcm };
    }),
  };
  const host: RecoveryHost = {
    activeTakeId: () => activeTakeId,
    isRecording: () => recording,
    handedOver: () => handedOver,
    publish: vi.fn((list: readonly RecoveredTake[]) => {
      published = list;
    }),
    writeCompressed: vi.fn(async (id: string, blob: Blob) => {
      log.push(`writeCompressed ${id} ${blob.type}`);
      audio.set(id, blob);
    }),
    patchTake: vi.fn(async (id: string, patch: Partial<Take>) => {
      log.push(`patchTake ${id}`);
      const existing = takes.get(id);
      if (!existing) throw new AppError('take-not-found', id);
      takes.set(id, { ...existing, ...patch });
    }),
    deleteTake: vi.fn(async (id: string) => {
      log.push(`deleteTake ${id}`);
      takes.delete(id);
      raw.delete(id);
      audio.delete(id);
    }),
    navigate: vi.fn((id: string) => log.push(`navigate ${id}`)),
    requestPersist: vi.fn(),
  };
  const recovery = createRecordingRecovery(deps, host);
  return {
    recovery,
    deps,
    host,
    takes,
    raw,
    audio,
    log,
    published: () => published,
    setActive: (id: string | null) => (activeTakeId = id),
    setRecording: (on: boolean) => (recording = on),
    handOver: () => (handedOver = true),
  };
}

describe('recovery scan', () => {
  it('offers each unfinished take with its raw length, oldest first', async () => {
    const t = setup({
      takes: new Map([
        ['bb', take('bb', { createdAt: '2026-10-02T21:00:00.000Z' })],
        ['a', take('a', { createdAt: '2026-10-02T20:00:00.000Z' })],
      ]),
      raw: new Map([
        ['a', seconds(9.6)],
        ['bb', seconds(182.4)],
      ]),
    });
    await t.recovery.scan();
    expect(t.published()).toEqual([
      { id: 'a', createdAt: '2026-10-02T20:00:00.000Z', durationMs: 9600, opening: false },
      { id: 'bb', createdAt: '2026-10-02T21:00:00.000Z', durationMs: 182_400, opening: false },
    ]);
    expect(t.log).toEqual([]);
  });

  it('short take: under 0.5 s of raw, or no raw, is deleted without a banner', async () => {
    const t = setup({
      takes: new Map([
        ['short', take('short')],
        ['none', take('none')],
        ['edge', take('edge')],
      ]),
      raw: new Map([
        // Under 499.5 ms (rounded to 499, isTooShort); one sample short of 0.5 s rounds to 500.
        ['short', new Float32Array(RATE / 2 - 25)],
        ['edge', new Float32Array(RATE / 2)],
      ]),
    });
    await t.recovery.scan();
    expect(t.log).toEqual(['deleteTake none', 'deleteTake short']);
    expect(t.published().map((r) => r.id)).toEqual(['edge']);
  });

  it('orphan files: a raw and a compressed file with no take are deleted, with no banner', async () => {
    const t = setup({
      raw: new Map([['x', seconds(1)]]),
      audio: new Map([['y', new Blob(['a'], { type: 'audio/webm;codecs=opus' })]]),
    });
    await t.recovery.scan();
    expect(t.log).toEqual(['deleteRaw x', 'deleteAudio y']);
    expect(t.raw.size).toBe(0);
    expect(t.audio.size).toBe(0);
    expect(t.published()).toEqual([]);
  });

  it('a recorded or analysed take with a raw file is left alone, with no banner', async () => {
    const t = setup({
      takes: new Map([
        ['r', take('r', { status: 'recorded' })],
        ['z', take('z', { status: 'analyzed', audioMime: 'audio/webm;codecs=opus' })],
      ]),
      raw: new Map([
        ['r', seconds(3)],
        ['z', seconds(3)],
      ]),
      audio: new Map([['r', new Blob(['a'], { type: 'audio/webm;codecs=opus' })]]),
    });
    await t.recovery.scan();
    expect(t.log).toEqual([]);
    expect(t.published()).toEqual([]);
    expect(t.raw.size).toBe(2);
  });

  it('an analysed take whose audio was deleted (story 6.2): its leftover files go; its record stays', async () => {
    const t = setup({
      takes: new Map([
        ['gone', take('gone', { status: 'analyzed', audioMime: null })],
        ['kept', take('kept', { status: 'recorded', audioMime: null })],
      ]),
      raw: new Map([
        ['gone', seconds(3)],
        ['kept', seconds(3)],
      ]),
      audio: new Map([['gone', new Blob(['a'], { type: 'audio/webm;codecs=opus' })]]),
    });
    await t.recovery.scan();
    expect(t.log).toEqual(['deleteRaw gone', 'deleteAudio gone']);
    expect([...t.raw.keys()]).toEqual(['kept']);
    expect(t.audio.size).toBe(0);
    expect(t.published()).toEqual([]);
  });

  it("own take: this tab's take is never offered, deleted or stripped of its files", async () => {
    const t = setup(
      {
        takes: new Map([['mine', take('mine')]]),
        raw: new Map([['mine', new Float32Array(10)]]),
      },
      { activeTakeId: 'mine', recording: true },
    );
    await t.recovery.scan();
    expect(t.log).toEqual([]);
    expect(t.published()).toEqual([]);
  });

  it('own take created after the take list was read: its raw file is not an orphan', async () => {
    const t = setup({ raw: new Map([['new', seconds(1)]]) });
    // The take exists by the time its file is checked.
    vi.mocked(t.deps.listTakes).mockImplementationOnce(async () => {
      t.takes.set('new', take('new'));
      t.setActive('new');
      return [];
    });
    await t.recovery.scan();
    expect(t.log).toEqual([]);
  });

  it('a failing cleanup step is ignored; the rest of the scan goes on', async () => {
    const t = setup({
      takes: new Map([['u', take('u')]]),
      raw: new Map([
        ['u', seconds(2)],
        ['x', seconds(1)],
      ]),
      audio: new Map([['y', new Blob(['a'], { type: 'audio/webm;codecs=opus' })]]),
    });
    vi.mocked(t.deps.deleteRaw).mockRejectedValue(new AppError('storage-failed', 'busy'));
    await t.recovery.scan();
    expect(t.log).toEqual(['deleteAudio y']);
    expect(t.published().map((r) => r.id)).toEqual(['u']);
  });

  it('an unreadable database offers nothing and never rejects', async () => {
    const t = setup();
    vi.mocked(t.deps.listTakes).mockRejectedValue(new AppError('storage-failed', 'x'));
    await expect(t.recovery.scan()).resolves.toBeUndefined();
    expect(t.host.publish).not.toHaveBeenCalled();
  });

  it('a scan while one runs is the same scan', async () => {
    const t = setup();
    const gate = deferred<Take[]>();
    vi.mocked(t.deps.listTakes).mockReturnValueOnce(gate.promise);
    const a = t.recovery.scan();
    const b = t.recovery.scan();
    gate.resolve([]);
    await Promise.all([a, b]);
    expect(t.deps.listTakes).toHaveBeenCalledTimes(1);
  });
});

describe('Open', () => {
  async function offered(world: Partial<World>, options = {}) {
    const t = setup(world, options);
    await t.recovery.scan();
    return t;
  }

  it('re-encodes the raw file, saves the take recovered, keeps the raw file, opens its Tab', async () => {
    const samples = seconds(10);
    samples[100] = -Math.min(1, CLIP_LEVEL + 1e-6);
    const t = await offered({
      takes: new Map([['a', take('a')]]),
      raw: new Map([['a', samples]]),
    });
    await t.recovery.open('a');
    expect(t.log).toEqual([
      `encodePcm ${10 * RATE} ${RATE}`,
      'writeCompressed a audio/webm;codecs=opus',
      'patchTake a',
      'navigate a',
    ]);
    // Story 6.7: persistent storage is asked for once the take is saved.
    expect(t.host.requestPersist).toHaveBeenCalledTimes(1);
    expect(t.host.patchTake).toHaveBeenCalledWith(
      'a',
      {
        status: 'recorded',
        stopReason: 'recovered',
        durationMs: 10_000,
        audioMime: 'audio/webm;codecs=opus',
        clipped: true,
      },
      'recording-session',
    );
    expect(t.raw.has('a')).toBe(true);
    expect(t.published()).toEqual([]);
  });

  it('shows opening while it runs; a second Open or a Discard meanwhile does nothing', async () => {
    const t = await offered({
      takes: new Map([['a', take('a')]]),
      raw: new Map([['a', seconds(2, 0)]]),
    });
    const encoding = deferred<Blob>();
    vi.mocked(t.deps.encodePcm).mockReturnValueOnce(encoding.promise);
    const opening = t.recovery.open('a');
    expect(t.published()).toEqual([expect.objectContaining({ id: 'a', opening: true })]);
    await t.recovery.open('a');
    await t.recovery.discard('a');
    expect(t.host.deleteTake).not.toHaveBeenCalled();
    encoding.resolve(new Blob(['x'], { type: 'audio/webm;codecs=opus' }));
    await opening;
    expect(t.deps.encodePcm).toHaveBeenCalledTimes(1);
    expect(t.host.patchTake).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ clipped: false, durationMs: 2000 }),
      'recording-session',
    );
  });

  it('compressed already there: kept, no encode, audioMime from it', async () => {
    const t = await offered({
      takes: new Map([['a', take('a')]]),
      raw: new Map([['a', seconds(3)]]),
      audio: new Map([['a', new Blob(['ogg'], { type: 'audio/ogg;codecs=opus' })]]),
    });
    await t.recovery.open('a');
    expect(t.deps.encodePcm).not.toHaveBeenCalled();
    expect(t.host.writeCompressed).not.toHaveBeenCalled();
    expect(t.host.patchTake).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ audioMime: 'audio/ogg;codecs=opus', durationMs: 3000 }),
      'recording-session',
    );
  });

  it('DS2: a compressed copy longer than the raw file gives the duration and clipping', async () => {
    const copy = seconds(5);
    copy[copy.length - 1] = 1; // one clipped sample past the raw file's end
    const t = await offered({
      takes: new Map([['a', take('a')]]),
      raw: new Map([['a', seconds(3)]]),
      audio: new Map([['a', new Blob(['ogg'], { type: 'audio/ogg;codecs=opus' })]]),
      decoded: new Map([['a', copy]]),
    });
    await t.recovery.open('a');
    expect(t.host.patchTake).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ durationMs: 5000, clipped: true }),
      'recording-session',
    );
  });

  it('DS2: a copy that fails to decode keeps the raw-based duration and clipping', async () => {
    const t = await offered({
      takes: new Map([['a', take('a')]]),
      raw: new Map([['a', seconds(3)]]),
      audio: new Map([['a', new Blob(['ogg'], { type: 'audio/ogg;codecs=opus' })]]),
    });
    await t.recovery.open('a');
    expect(t.deps.decode).toHaveBeenCalledTimes(1);
    expect(t.host.patchTake).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ durationMs: 3000, clipped: false }),
      'recording-session',
    );
  });

  it('DS2: a raw-only take (recovery encodes it) is measured from the raw file, not decoded', async () => {
    const t = await offered({
      takes: new Map([['a', take('a')]]),
      raw: new Map([['a', seconds(2)]]),
    });
    await t.recovery.open('a');
    expect(t.deps.decode).not.toHaveBeenCalled();
    expect(t.host.patchTake).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ durationMs: 2000 }),
      'recording-session',
    );
  });

  it('encoding fails: WAV is written instead', async () => {
    const t = await offered({
      takes: new Map([['a', take('a')]]),
      raw: new Map([['a', seconds(1)]]),
    });
    vi.mocked(t.deps.encodePcm).mockRejectedValueOnce(new Error('no MediaRecorder'));
    await t.recovery.open('a');
    expect(t.log).toEqual([
      `encodeWav ${RATE} ${RATE}`,
      'writeCompressed a audio/wav',
      'patchTake a',
      'navigate a',
    ]);
    expect(t.host.patchTake).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ audioMime: 'audio/wav' }),
      'recording-session',
    );
  });

  it('compressed audio that appeared during the encode is kept, not overwritten', async () => {
    const t = await offered({
      takes: new Map([['a', take('a')]]),
      raw: new Map([['a', seconds(1)]]),
    });
    vi.mocked(t.deps.encodePcm).mockImplementationOnce(async () => {
      t.audio.set('a', new Blob(['m4a'], { type: 'audio/mp4' }));
      return new Blob(['x'], { type: 'audio/webm;codecs=opus' });
    });
    await t.recovery.open('a');
    expect(t.host.writeCompressed).not.toHaveBeenCalled();
    expect(t.host.patchTake).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ audioMime: 'audio/mp4' }),
      'recording-session',
    );
  });

  it('DS2: a copy saved during the encode is decoded for the duration', async () => {
    const t = await offered({
      takes: new Map([['a', take('a')]]),
      raw: new Map([['a', seconds(1)]]),
      decoded: new Map([['a', seconds(4)]]),
    });
    vi.mocked(t.deps.encodePcm).mockImplementationOnce(async () => {
      t.audio.set('a', new Blob(['m4a'], { type: 'audio/mp4' }));
      return new Blob(['x'], { type: 'audio/webm;codecs=opus' });
    });
    await t.recovery.open('a');
    expect(t.host.patchTake).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ audioMime: 'audio/mp4', durationMs: 4000 }),
      'recording-session',
    );
  });

  it('DS2: a handover during the decode writes nothing', async () => {
    const t = await offered({
      takes: new Map([['a', take('a')]]),
      raw: new Map([['a', seconds(1)]]),
      audio: new Map([['a', new Blob(['ogg'], { type: 'audio/ogg;codecs=opus' })]]),
      decoded: new Map([['a', seconds(2)]]),
    });
    const real = vi.mocked(t.deps.decode).getMockImplementation()!;
    vi.mocked(t.deps.decode).mockImplementationOnce(async (blob, rate) => {
      const value = await real(blob, rate);
      t.handOver();
      return value;
    });
    await t.recovery.open('a');
    expect(t.host.patchTake).not.toHaveBeenCalled();
    expect(t.host.navigate).not.toHaveBeenCalled();
    expect(t.host.requestPersist).not.toHaveBeenCalled();
    expect(t.takes.get('a')?.status).toBe('recording');
  });

  it('DS2: a lossy overshoot inside the raw length does not mark the take clipped', async () => {
    const copy = seconds(3);
    copy[100] = 1; // the decode overshoots where raw audio exists
    const t = await offered({
      takes: new Map([['a', take('a')]]),
      raw: new Map([['a', seconds(2)]]),
      audio: new Map([['a', new Blob(['ogg'], { type: 'audio/ogg;codecs=opus' })]]),
      decoded: new Map([['a', copy]]),
    });
    await t.recovery.open('a');
    expect(t.host.patchTake).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ durationMs: 3000, clipped: false }),
      'recording-session',
    );
  });

  it('a take no longer unfinished: its banner is dropped, nothing is written', async () => {
    const t = await offered({
      takes: new Map([['a', take('a')]]),
      raw: new Map([['a', seconds(1)]]),
    });
    t.takes.set('a', take('a', { status: 'recorded' }));
    await t.recovery.open('a');
    expect(t.log).toEqual([]);
    expect(t.published()).toEqual([]);
  });

  it('does not open the Tab when this tab is recording by then', async () => {
    const t = await offered({
      takes: new Map([['a', take('a')]]),
      raw: new Map([['a', seconds(1)]]),
    });
    t.setRecording(true);
    await t.recovery.open('a');
    expect(t.host.patchTake).toHaveBeenCalled();
    expect(t.host.navigate).not.toHaveBeenCalled();
  });

  it('a failed save brings the banner back with its actions', async () => {
    const t = await offered({
      takes: new Map([['a', take('a')]]),
      raw: new Map([['a', seconds(1)]]),
    });
    vi.mocked(t.host.writeCompressed).mockRejectedValueOnce(new AppError('storage-full', 'x'));
    await expect(t.recovery.open('a')).resolves.toBeUndefined();
    expect(t.published()).toEqual([expect.objectContaining({ id: 'a', opening: false })]);
    expect(t.host.patchTake).not.toHaveBeenCalled();
  });
});

describe('Open and a handover (story 5.3)', () => {
  async function offered(world: Partial<World>) {
    const t = setup(world);
    await t.recovery.scan();
    return t;
  }

  it('a handover during the encode: nothing written, no navigation, the take stays recording', async () => {
    const t = await offered({
      takes: new Map([['a', take('a')]]),
      raw: new Map([['a', seconds(1)]]),
    });
    const encoding = deferred<Blob>();
    vi.mocked(t.deps.encodePcm).mockReturnValueOnce(encoding.promise);
    const opening = t.recovery.open('a');
    await vi.waitFor(() => expect(t.deps.encodePcm).toHaveBeenCalled());
    t.handOver();
    encoding.resolve(new Blob(['opus'], { type: 'audio/webm;codecs=opus' }));
    await opening;
    expect(t.host.writeCompressed).not.toHaveBeenCalled();
    expect(t.host.patchTake).not.toHaveBeenCalled();
    expect(t.host.navigate).not.toHaveBeenCalled();
    expect(t.takes.get('a')?.status).toBe('recording');
  });

  it('a handover after any read stops the rebuild before it writes', async () => {
    // Each read of the rebuild, by call: getTake 2 is the re-read just before the save, and
    // readCompressed 2 the "meanwhile" check after the encode.
    const steps = [
      ['getTake', 1],
      ['readRaw', 1],
      ['readCompressed', 1],
      ['readCompressed', 2],
      ['getTake', 2],
    ] as const;
    for (const [step, nth] of steps) {
      const t = await offered({
        takes: new Map([['a', take('a')]]),
        raw: new Map([['a', seconds(1)]]),
      });
      const real = vi.mocked(t.deps[step]).getMockImplementation() as (
        id: string,
      ) => Promise<unknown>;
      let calls = 0;
      vi.mocked(t.deps[step]).mockImplementation(async (id: string) => {
        const value = await real(id);
        if (++calls === nth) t.handOver();
        return value as never;
      });
      await t.recovery.open('a');
      expect(calls, `${step} ${nth}`).toBeGreaterThanOrEqual(nth);
      expect(t.host.writeCompressed, `${step} ${nth}`).not.toHaveBeenCalled();
      expect(t.host.patchTake, `${step} ${nth}`).not.toHaveBeenCalled();
      expect(t.host.navigate, `${step} ${nth}`).not.toHaveBeenCalled();
      expect(t.takes.get('a')?.status).toBe('recording');
    }
  });

  it('a handover during the save: no patch, no navigation, nothing more read or published', async () => {
    const t = await offered({
      takes: new Map([['a', take('a')]]),
      raw: new Map([['a', seconds(1)]]),
    });
    vi.mocked(t.deps.getTake).mockClear();
    let getTakesAtReject = -1;
    vi.mocked(t.host.writeCompressed).mockImplementationOnce(async () => {
      t.handOver();
      getTakesAtReject = vi.mocked(t.deps.getTake).mock.calls.length;
      throw new AppError('instance-taken', 'fenced');
    });
    await t.recovery.open('a');
    expect(t.host.patchTake).not.toHaveBeenCalled();
    expect(t.host.navigate).not.toHaveBeenCalled();
    // The catch returns at once: no re-read, and the entry stays as it was.
    expect(vi.mocked(t.deps.getTake).mock.calls.length).toBe(getTakesAtReject);
    expect(t.published()).toEqual([expect.objectContaining({ id: 'a', opening: true })]);

    // The write succeeded but the steal landed during it (the fence comes later): no patch.
    const w = await offered({
      takes: new Map([['c', take('c')]]),
      raw: new Map([['c', seconds(1)]]),
    });
    const write = vi.mocked(w.host.writeCompressed).getMockImplementation()!;
    vi.mocked(w.host.writeCompressed).mockImplementationOnce(async (...args) => {
      await write(...args);
      w.handOver();
    });
    await w.recovery.open('c');
    expect(w.host.writeCompressed).toHaveBeenCalledTimes(1);
    expect(w.host.patchTake).not.toHaveBeenCalled();
    expect(w.host.navigate).not.toHaveBeenCalled();
    expect(w.takes.get('c')?.status).toBe('recording');

    // The patch committed just before the handover was seen: still no navigation.
    const u = await offered({
      takes: new Map([['b', take('b')]]),
      raw: new Map([['b', seconds(1)]]),
    });
    const patch = vi.mocked(u.host.patchTake).getMockImplementation()!;
    vi.mocked(u.host.patchTake).mockImplementationOnce(async (...args) => {
      await patch(...args);
      u.handOver();
    });
    await u.recovery.open('b');
    expect(u.takes.get('b')?.status).toBe('recorded');
    expect(u.host.navigate).not.toHaveBeenCalled();
  });

  it('a take saved during the encode: nothing written, its entry dropped', async () => {
    const t = await offered({
      takes: new Map([['a', take('a')]]),
      raw: new Map([['a', seconds(1)]]),
    });
    vi.mocked(t.deps.encodePcm).mockImplementationOnce(async () => {
      // Another tab's late instance-lost save lands meanwhile (no compressed copy here).
      t.takes.set('a', take('a', { status: 'recorded', stopReason: 'instance-lost' }));
      return new Blob(['opus'], { type: 'audio/webm;codecs=opus' });
    });
    await t.recovery.open('a');
    expect(t.host.writeCompressed).not.toHaveBeenCalled();
    expect(t.host.patchTake).not.toHaveBeenCalled();
    expect(t.host.navigate).not.toHaveBeenCalled();
    expect(t.takes.get('a')?.stopReason).toBe('instance-lost');
    expect(t.published()).toEqual([]);
  });
});

describe('Discard', () => {
  it('deletes the take and its files and drops its banner', async () => {
    const t = setup({
      takes: new Map([['a', take('a')]]),
      raw: new Map([['a', seconds(1)]]),
      audio: new Map([['a', new Blob(['x'], { type: 'audio/webm;codecs=opus' })]]),
    });
    await t.recovery.scan();
    await t.recovery.discard('a');
    expect(t.host.deleteTake).toHaveBeenCalledWith('a', 'recording-session');
    expect(t.takes.size + t.raw.size + t.audio.size).toBe(0);
    expect(t.published()).toEqual([]);
  });

  it('a failed delete keeps the banner', async () => {
    const t = setup({ takes: new Map([['a', take('a')]]), raw: new Map([['a', seconds(1)]]) });
    await t.recovery.scan();
    vi.mocked(t.host.deleteTake).mockRejectedValueOnce(new AppError('storage-failed', 'x'));
    await expect(t.recovery.discard('a')).resolves.toBeUndefined();
    expect(t.published().map((r) => r.id)).toEqual(['a']);
  });

  it('does nothing for a take not offered', async () => {
    const t = setup({ takes: new Map([['a', take('a')]]) });
    await t.recovery.discard('a');
    expect(t.host.deleteTake).not.toHaveBeenCalled();
  });
});

// Story 5.2 (DS4): recovery never acts on a saved take; (DS3) the scan for one take, run when
// this tab's own save failed; and the shared too-short verdict (isTooShort, rounded ms).
describe('never a saved take (story 5.2)', () => {
  it('Discard of a take saved since it was offered: not deleted, its banner removed', async () => {
    const t = setup({ takes: new Map([['a', take('a')]]), raw: new Map([['a', seconds(1)]]) });
    await t.recovery.scan();
    expect(t.published().map((r) => r.id)).toEqual(['a']);
    t.takes.set('a', take('a', { status: 'recorded' }));
    const deleted = vi.fn();
    await t.recovery.discard('a', deleted);
    expect(t.host.deleteTake).not.toHaveBeenCalled();
    expect(t.raw.has('a')).toBe(true);
    expect(t.published()).toEqual([]);
    // The banner goes, so focus still moves.
    expect(deleted).toHaveBeenCalledTimes(1);
  });

  it('a take saved between the take list and the offer is not offered', async () => {
    const t = setup({ takes: new Map([['a', take('a')]]), raw: new Map([['a', seconds(1)]]) });
    vi.mocked(t.deps.rawSampleCount).mockImplementationOnce(async (id) => {
      // Saved by its own tab while the scan measured it.
      t.takes.set(id, take(id, { status: 'recorded' }));
      return RATE;
    });
    await t.recovery.scan();
    expect(t.published()).toEqual([]);
    expect(t.host.deleteTake).not.toHaveBeenCalled();
  });

  it("this tab's take as seen before the take list is read is never offered", async () => {
    const t = setup(
      { takes: new Map([['mine', take('mine')]]), raw: new Map([['mine', seconds(1)]]) },
      { activeTakeId: 'mine' },
    );
    // It finishes while the list is read; the list still shows it unfinished, and the re-read
    // before the offer is stale too (the patch has not landed).
    vi.mocked(t.deps.listTakes).mockImplementationOnce(async () => {
      t.setActive(null);
      return [take('mine')];
    });
    await t.recovery.scan();
    expect(t.published()).toEqual([]);
    expect(t.host.deleteTake).not.toHaveBeenCalled();
  });

  it('this tab taking a take between the list and the offer: not offered', async () => {
    const t = setup({ takes: new Map([['a', take('a')]]), raw: new Map([['a', seconds(1)]]) });
    vi.mocked(t.deps.rawSampleCount).mockImplementationOnce(async () => {
      t.setActive('a');
      return RATE;
    });
    await t.recovery.scan();
    expect(t.published()).toEqual([]);
  });

  it('rounding: 499.6 ms of raw is offered (500 ms), 499.4 ms deleted, as recording decides', async () => {
    const t = setup({
      takes: new Map([
        ['kept', take('kept')],
        ['short', take('short')],
      ]),
      raw: new Map([
        ['kept', new Float32Array(23_981)],
        ['short', new Float32Array(23_971)],
      ]),
    });
    await t.recovery.scan();
    expect(t.published()).toEqual([expect.objectContaining({ id: 'kept', durationMs: 500 })]);
    expect(t.log).toEqual(['deleteTake short']);
  });
});

describe('reoffer (story 5.2)', () => {
  it('offers the take again, in creation order among those offered', async () => {
    const t = setup({
      takes: new Map([['b', take('b', { createdAt: '2026-10-02T21:15:00.000Z' })]]),
      raw: new Map([['b', seconds(1)]]),
    });
    await t.recovery.scan();
    t.takes.set('a', take('a', { createdAt: '2026-10-02T21:14:00.000Z' }));
    t.raw.set('a', seconds(2));
    await t.recovery.reoffer('a');
    expect(t.published().map((r) => [r.id, r.durationMs])).toEqual([
      ['a', 2000],
      ['b', 1000],
    ]);
  });

  it('too short: deletes it, with no banner', async () => {
    const t = setup({ takes: new Map([['a', take('a')]]), raw: new Map([['a', seconds(0.2)]]) });
    await t.recovery.reoffer('a');
    expect(t.log).toEqual(['deleteTake a']);
    expect(t.published()).toEqual([]);
  });

  it('a take saved, gone, or offered already: nothing', async () => {
    const t = setup({
      takes: new Map([
        ['saved', take('saved', { status: 'recorded' })],
        ['a', take('a')],
      ]),
      raw: new Map([
        ['saved', seconds(1)],
        ['a', seconds(1)],
      ]),
    });
    await t.recovery.reoffer('saved');
    await t.recovery.reoffer('gone');
    expect(t.published()).toEqual([]);
    await t.recovery.reoffer('a');
    await t.recovery.reoffer('a');
    expect(t.published().map((r) => r.id)).toEqual(['a']);
    expect(t.host.deleteTake).not.toHaveBeenCalled();
  });

  it('this tab recording it again, or an unreadable database: nothing, never rejects', async () => {
    const t = setup({ takes: new Map([['a', take('a')]]), raw: new Map([['a', seconds(1)]]) });
    t.setActive('a');
    await t.recovery.reoffer('a');
    expect(t.published()).toEqual([]);
    t.setActive(null);
    vi.mocked(t.deps.getTake).mockRejectedValueOnce(new AppError('storage-failed', 'x'));
    await expect(t.recovery.reoffer('a')).resolves.toBeUndefined();
    expect(t.published()).toEqual([]);
  });
});

describe('reoffer with a compressed copy or a scan in flight (story 5.2)', () => {
  it('a short raw file but a compressed copy: offered, not deleted', async () => {
    const t = setup({
      takes: new Map([['a', take('a')]]),
      raw: new Map([['a', seconds(0.2)]]),
      audio: new Map([['a', new Blob(['x'], { type: 'audio/webm;codecs=opus' })]]),
    });
    await t.recovery.reoffer('a');
    expect(t.host.deleteTake).not.toHaveBeenCalled();
    expect(t.published().map((r) => r.id)).toEqual(['a']);
  });

  it('a re-offer during a scan that saw the take as its own still offers it', async () => {
    const t = setup(
      { takes: new Map([['a', take('a')]]), raw: new Map([['a', seconds(1)]]) },
      { activeTakeId: 'a' },
    );
    const listed = deferred<Take[]>();
    vi.mocked(t.deps.listTakes).mockReturnValueOnce(listed.promise);
    const scan = t.recovery.scan();
    // This tab's save of `a` fails meanwhile, and it re-offers the take.
    t.setActive(null);
    const reoffer = t.recovery.reoffer('a');
    listed.resolve([take('a')]);
    await scan;
    await reoffer;
    expect(t.published().map((r) => r.id)).toEqual(['a']);
  });
});
