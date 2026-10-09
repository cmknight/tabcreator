// @vitest-environment node
// Story "60 s analysis benchmark gate" (spine AD-17, US-8.3): build/benchmark.ts's pure parts —
// the gate decision (median × calibration factor against analysis60sMs), the config checks, the
// report and the CLI's failures before any browser starts — and the seed backup it restores,
// checked against the app's own restore validation. The browser runs are exercised by
// `pnpm --filter app benchmark` itself.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUDGETS_PATH } from '../../build/budgets';
import {
  BenchmarkError,
  CONFIG_PATH,
  decide,
  main,
  median,
  parseArgs,
  readConfig,
  report,
  withTimeout,
  type Measurements,
} from '../../build/benchmark';
import { validateBackup } from '../../src/storage/restore';
import { DB_VERSION } from '../../src/storage/migrations';
import type { Tab } from '../../src/model/types';
import { DEFAULT_PREFS } from '../../src/storage/prefs';
import {
  SeedError,
  loopPcm,
  readFixtureWav,
  seedBackup,
  seedTake,
  wavFile,
} from '../e2e/seed-helpers';

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'benchmark-'));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function write(name: string, value: unknown): string {
  const path = join(work, name);
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

describe('median', () => {
  it('is the middle value of an odd count, in any order', () => {
    expect(median([1500, 1300, 1400, 1700, 1200])).toBe(1400);
    expect(median([7])).toBe(7);
  });

  it('is the mean of the two middle values of an even count', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([1000, 2000])).toBe(1500);
  });

  it('throws on no runs', () => {
    expect(() => median([])).toThrow(BenchmarkError);
  });
});

describe('decide', () => {
  const runs = [1300, 1350, 1330, 1320, 1340];

  it('passes when median × factor is within the limit', () => {
    const d = decide(runs, 1, 2000);
    expect(d).toEqual({ medianMs: 1330, factor: 1, gatedMs: 1330, limitMs: 2000, ok: true });
  });

  it('passes exactly at the limit', () => {
    expect(decide([1000, 1000, 1000], 2, 2000).ok).toBe(true);
  });

  it('applies the calibration factor', () => {
    const d = decide(runs, 1.6, 2000);
    expect(d.gatedMs).toBeCloseTo(2128);
    expect(d.ok).toBe(false);
    expect(decide(runs, 0.5, 1000).ok).toBe(true);
  });

  it('fails over the limit, naming the median, the factor and the limit', () => {
    const d = decide(runs, 1, 1000);
    expect(d.ok).toBe(false);
    expect(d.error).toContain('median 1330 ms');
    expect(d.error).toContain('calibration factor 1');
    expect(d.error).toContain('1000 ms limit');
    expect(d.error).toContain('analysis60sMs');
  });

  it('uses the mean of the middle two for an even count', () => {
    const d = decide([1000, 3000, 2000, 2200], 1, 2050);
    expect(d.medianMs).toBe(2100);
    expect(d.ok).toBe(false);
  });
});

describe('readConfig', () => {
  const budgets = (value: unknown) => write('budgets.json', { analysis60sMs: value });
  const config = (value: unknown) => write('config.json', { calibrationFactor: value });

  it('reads the limit and factor', () => {
    expect(readConfig(budgets(2000), config(1.25))).toEqual({
      analysis60sMs: 2000,
      calibrationFactor: 1.25,
    });
  });

  it('reads the real budgets and config files', () => {
    expect(readConfig(BUDGETS_PATH, CONFIG_PATH)).toEqual({
      analysis60sMs: 2000,
      calibrationFactor: 1.14,
    });
  });

  it.each([undefined, 0, -5, '2000', null, Number.NaN])('rejects analysis60sMs %s', (value) => {
    expect(() => readConfig(budgets(value), config(1))).toThrow(/"analysis60sMs" must be/);
  });

  it.each([undefined, 0, -1, '1.0', null])('rejects calibrationFactor %s', (value) => {
    expect(() => readConfig(budgets(2000), config(value))).toThrow(/"calibrationFactor" must be/);
  });

  it('rejects a missing, unparsable or non-object file', () => {
    expect(() => readConfig(join(work, 'none.json'), config(1))).toThrow(/cannot read budgets/);
    expect(() => readConfig(write('bad.json', '{'), config(1))).toThrow(/cannot read budgets/);
    expect(() => readConfig(budgets(2000), write('arr.json', [1]))).toThrow(/not a JSON object/);
  });
});

describe('parseArgs', () => {
  it('defaults to app/dist and the budgets limit', () => {
    const args = parseArgs([]);
    expect(args.distDir).toMatch(/app[\\/]dist$/);
    expect(args.limitMs).toBeUndefined();
  });

  it('takes a dist directory and --limit-ms', () => {
    const args = parseArgs(['--limit-ms', '500', 'some/dist']);
    expect(args.limitMs).toBe(500);
    expect(args.distDir).toMatch(/some[\\/]dist$/);
  });

  it('rejects a bad --limit-ms, unknown options and extra arguments', () => {
    expect(() => parseArgs(['--limit-ms'])).toThrow(/--limit-ms/);
    expect(() => parseArgs(['--limit-ms', '-3'])).toThrow(/--limit-ms/);
    expect(() => parseArgs(['--retries'])).toThrow(/unknown option/);
    expect(() => parseArgs(['a', 'b'])).toThrow(/unexpected argument/);
  });
});

describe('report', () => {
  const m: Measurements = {
    warmupMs: 2480.4,
    runsMs: [1329.2, 1340.1, 1339, 1316.7, 1332.4],
    coldMs: 2526.3,
    peakWasmBytes: 327 * 1024 * 1024,
    endToEndMs: 2812.2,
  };

  it('lists every run, the gate and the reported values', () => {
    const text = report(m, decide(m.runsMs, 1, 2000));
    expect(text).toContain('## Analysis benchmark');
    expect(text).toContain('| Warm-up (60 s take) | 2480 ms |');
    for (const [i, r] of ['1329', '1340', '1339', '1317', '1332'].entries())
      expect(text).toContain(`| Run ${i + 1} (60 s take) | ${r} ms |`);
    expect(text).toContain('| Min / max (spread) | 1317 ms / 1340 ms (23 ms) |');
    expect(text).toContain('| Median | 1332 ms |');
    expect(text).toContain('| Calibration factor | 1 |');
    expect(text).toContain('| Gated (median × factor) | 1332 ms |');
    expect(text).toContain('| Limit (analysis60sMs) | 2000 ms |');
    expect(text).toContain('| Gate | pass |');
    expect(text).toContain('| Cold first analysis, fresh context (reported) | 2526 ms |');
    expect(text).toContain('| Peak wasm memory, 5-minute take (reported) | 327.0 MiB |');
    expect(text).toMatch(
      /\| End to end, seeded 60 s take, cold engine: from navigating to its Tab until the Note list view toggle shows .*\| 2812 ms \|/,
    );
  });

  it('shows a reported value that could not be measured as n/a with its reason, on one line', () => {
    const text = report(
      { ...m, coldMs: { na: 'timed out\nafter 30 s' }, peakWasmBytes: { na: 'a | b' } },
      decide(m.runsMs, 1, 2000),
    );
    expect(text).toContain(
      '| Cold first analysis, fresh context (reported) | n/a (timed out after 30 s) |',
    );
    expect(text).toContain('| Peak wasm memory, 5-minute take (reported) | n/a (a \\| b) |');
  });

  it('marks a failed gate', () => {
    expect(report(m, decide(m.runsMs, 2, 2000))).toContain('| Gate | **FAIL** |');
  });
});

describe('main', () => {
  it('exits 1 with a clear message on a bad config, before any browser starts', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: string) => void errors.push(line));
    const summary = join(work, 'summary.md');
    const code = await main(
      [join(work, 'no-dist')],
      { GITHUB_STEP_SUMMARY: summary },
      {
        budgets: write('budgets.json', { initialJsGzipBytes: 1 }),
        config: write('config.json', { calibrationFactor: 1 }),
      },
    );
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/benchmark: .*"analysis60sMs" must be/);
    expect(readFileSync(summary, 'utf8')).toContain('**Benchmark failed:**');
  });

  const stub: Measurements = {
    warmupMs: 2500,
    runsMs: [1300, 1340, 1330, 1320, 1310],
    coldMs: { na: 'the engine did not become ready' },
    peakWasmBytes: 327 * 1024 * 1024,
    endToEndMs: 2800,
  };
  const paths = () => ({
    budgets: write('budgets.json', { analysis60sMs: 2000 }),
    config: write('config.json', { calibrationFactor: 1 }),
  });
  const run = async (argv: string[], m: Measurements) => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const summary = join(work, 'summary.md');
    const measure = vi.fn(async () => m);
    const code = await main(argv, { GITHUB_STEP_SUMMARY: summary }, paths(), measure);
    return { code, summary: readFileSync(summary, 'utf8'), measure };
  };

  it('exits 0 under the limit, reporting an unmeasured value as n/a', async () => {
    const { code, summary, measure } = await run(['some/dist'], stub);
    expect(code).toBe(0);
    expect(measure).toHaveBeenCalledWith(
      expect.stringMatching(/some[\\/]dist$/),
      expect.any(Function),
    );
    expect(summary).toContain('| Gate | pass |');
    expect(summary).toContain('n/a (the engine did not become ready)');
    expect(summary).not.toContain('**Benchmark failed:**');
  });

  it('exits 1 over the limit, with the FAIL table and the reason in the summary', async () => {
    const { code, summary } = await run([], { ...stub, runsMs: [2100, 2200, 2150, 2050, 2300] });
    expect(code).toBe(1);
    expect(summary).toContain('| Gate | **FAIL** |');
    expect(summary).toContain('**Benchmark failed:** the 60 s analysis median 2150 ms');
    expect(summary).toContain('2000 ms limit');
  });

  it('--limit-ms below the median overrides analysis60sMs and exits 1', async () => {
    const { code, summary } = await run(['--limit-ms', '1000'], stub);
    expect(code).toBe(1);
    expect(summary).toContain('| Limit (analysis60sMs) | 1000 ms |');
    expect(summary).toContain('**Benchmark failed:** the 60 s analysis median 1320 ms');
  });

  it('exits 1 when the gated runs cannot be measured', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const summary = join(work, 'summary.md');
    const code = await main([], { GITHUB_STEP_SUMMARY: summary }, paths(), async () => {
      throw new BenchmarkError('gate: the warm-up and timed runs timed out after 180 s');
    });
    expect(code).toBe(1);
    expect(readFileSync(summary, 'utf8')).toContain('**Benchmark failed:** gate: the warm-up');
  });

  it('exits 1 on a bad option', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['--nope'], {})).toBe(1);
  });
});

describe('withTimeout', () => {
  it('passes a settled value through', async () => {
    await expect(withTimeout(Promise.resolve(3), 1000, 'step')).resolves.toBe(3);
  });

  it('rejects naming the step after the timeout, ignoring a later rejection', async () => {
    vi.useFakeTimers();
    try {
      let rejectLate!: (e: Error) => void;
      const hung = new Promise<number>((_, reject) => (rejectLate = reject));
      const result = withTimeout(hung, 30_000, 'cold: the first analysis');
      const check = expect(result).rejects.toThrow('cold: the first analysis timed out after 30 s');
      await vi.advanceTimersByTimeAsync(30_000);
      await check;
      rejectLate(new Error('context closed'));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('seed backup', () => {
  const fixture = join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    'testdata',
    'synth',
    'c_major_scale_pos1.wav',
  );

  it('loops PCM to an exact length', () => {
    const looped = loopPcm(Int16Array.from([1, 2, 3]), 8);
    expect([...looped]).toEqual([1, 2, 3, 1, 2, 3, 1, 2]);
  });

  it('writes a WAV that reads back', () => {
    const samples = Int16Array.from([0, 1, -1, 32767, -32768]);
    const path = join(work, 'x.wav');
    writeFileSync(path, wavFile(samples, 48_000));
    const back = readFixtureWav(path);
    expect(back.sampleRate).toBe(48_000);
    expect([...back.samples]).toEqual([...samples]);
  });

  it("is a backup the app's restore validation accepts: one recorded take with its WAV", () => {
    const { samples, sampleRate } = readFixtureWav(fixture);
    expect(sampleRate).toBe(48_000);
    const take = seedTake({
      id: 'seed-1',
      durationMs: 1000,
      sampleRate,
      createdAt: '2026-10-07T10:00:00.000Z',
    });
    const wav = wavFile(loopPcm(samples, sampleRate), sampleRate);
    const files = unzipSync(seedBackup(take, wav));
    expect(Object.keys(files).sort()).toEqual(['audio/seed-1.wav', 'manifest.json']);
    const manifest = strFromU8(files['manifest.json']!);
    expect(JSON.parse(manifest)).toMatchObject({ format: 1, schemaVersion: DB_VERSION, tabs: [] });

    const audio = files['audio/seed-1.wav']!;
    const valid = validateBackup(manifest, [
      { name: 'audio/seed-1.wav', blob: new Blob([audio as Uint8Array<ArrayBuffer>]) },
    ]);
    expect(valid.takes).toEqual([take]);
    expect(valid.takes[0]).toMatchObject({ status: 'recorded', audioMime: 'audio/wav' });
    expect(valid.tabs).toEqual([]);
    expect(valid.audio.get('seed-1')?.size).toBe(44 + sampleRate * 2);
    expect(valid.deflated.size).toBe(0);
  });

  it('uses the app default analysis settings', () => {
    const take = seedTake({ id: 'a', durationMs: 1000, sampleRate: 48_000 });
    expect(take.settings).toEqual(DEFAULT_PREFS.analysisDefaults);
  });

  it('builds several takes with optional audio and tabs that restore validation accepts', () => {
    const at = (d: number) => `2026-10-0${d}T10:00:00.000Z`;
    const one = seedTake({ id: 'one', durationMs: 1000, sampleRate: 48_000, createdAt: at(1) });
    const two = {
      ...seedTake({ id: 'two', durationMs: 1000, sampleRate: 48_000, createdAt: at(2) }),
      status: 'analyzed' as const,
      analysisVersion: '1',
    };
    const three = {
      ...seedTake({ id: 'three', durationMs: 1000, sampleRate: 48_000, createdAt: at(3) }),
      audioMime: null,
    };
    const tab: Tab = {
      takeId: 'two',
      notes: [
        {
          id: 'two-n1',
          startMs: 100,
          endMs: 400,
          midi: 40,
          confidence: 0.9,
          string: 6,
          fret: 0,
          locked: false,
          lowConfidence: false,
        },
      ],
      updatedAt: at(2),
      deletedStartMs: [],
    };
    const wav = wavFile(Int16Array.from([1, 2, 3]), 48_000);
    const files = unzipSync(
      seedBackup([{ take: one, audio: wav }, { take: two, audio: wav, tab }, { take: three }]),
    );
    expect(Object.keys(files).sort()).toEqual(['audio/one.wav', 'audio/two.wav', 'manifest.json']);
    const valid = validateBackup(
      strFromU8(files['manifest.json']!),
      ['audio/one.wav', 'audio/two.wav'].map((name) => ({
        name,
        blob: new Blob([files[name]! as Uint8Array<ArrayBuffer>]),
      })),
    );
    expect(valid.takes).toEqual([one, two, three]);
    expect(valid.tabs).toEqual([tab]);
    expect([...valid.audio.keys()]).toEqual(['one', 'two']);
  });

  it('rejects inconsistent seeds', () => {
    const take = seedTake({ id: 'a', durationMs: 1000, sampleRate: 48_000 });
    const wav = new Uint8Array([1]);
    expect(() => seedBackup([{ take }, { take }])).toThrow(SeedError);
    expect(() => seedBackup([{ take: { ...take, audioMime: null }, audio: wav }])).toThrow(
      /no audioMime/,
    );
    expect(() =>
      seedBackup([
        { take, tab: { takeId: 'b', notes: [], updatedAt: take.createdAt, deletedStartMs: [] } },
      ]),
    ).toThrow(/the tab of b/);
  });

  it('guards the loop length and a short fmt chunk', () => {
    const samples = Int16Array.from([1]);
    expect(() => loopPcm(samples, -1)).toThrow(SeedError);
    expect(() => loopPcm(samples, 1.5)).toThrow(SeedError);
    expect(loopPcm(samples, 0)).toHaveLength(0);
    const short = Buffer.alloc(28);
    short.write('RIFF', 0, 'ascii');
    short.write('WAVE', 8, 'ascii');
    short.write('fmt ', 12, 'ascii');
    short.writeUInt32LE(8, 16);
    const path = join(work, 'short.wav');
    writeFileSync(path, short);
    expect(() => readFixtureWav(path)).toThrow(/short fmt chunk/);
  });
});
