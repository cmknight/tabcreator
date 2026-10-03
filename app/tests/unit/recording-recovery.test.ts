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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface World {
  takes: Map<string, Take>;
  raw: Map<string, Float32Array>;
  audio: Map<string, Blob>;
}

function setup(
  world: Partial<World> = {},
  options: { activeTakeId?: string | null; recording?: boolean } = {},
) {
  const takes = world.takes ?? new Map<string, Take>();
  const raw = world.raw ?? new Map<string, Float32Array>();
  const audio = world.audio ?? new Map<string, Blob>();
  const log: string[] = [];
  let published: readonly RecoveredTake[] = [];
  let activeTakeId = options.activeTakeId ?? null;
  let recording = options.recording ?? false;
  const extOf = (blob: Blob) =>
    blob.type === 'audio/wav' ? 'wav' : blob.type.startsWith('audio/ogg') ? 'ogg' : 'webm';
  const deps: RecoveryDeps = {
    listTakes: vi.fn(async () =>
      [...takes.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    ),
    getTake: vi.fn(async (id: string) => takes.get(id) ?? null),
    listRaw: vi.fn(async () => [...raw.keys()].sort()),
    listCompressed: vi.fn(async () =>
      [...audio.entries()].map(([id, b]): CompressedFile => ({ id, ext: extOf(b) })),
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
  };
  const host: RecoveryHost = {
    activeTakeId: () => activeTakeId,
    isRecording: () => recording,
    handedOver: () => false,
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
        ['short', new Float32Array(RATE / 2 - 1)],
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
        ['z', take('z', { status: 'analyzed' })],
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
