/**
 * The 60 s analysis benchmark gate (story "60 s analysis benchmark gate", spine AD-17, US-8.3;
 * the spine's `tools/benchmark.ts`, kept in `app/build/` beside the size gate because Playwright
 * is an app dependency). It drives headless Chromium against the production build in `dist/`,
 * served by its own static server on a free port, with the app's service worker blocked:
 *
 * - **Gate:** in the real production engine worker, the engine `analyze` of
 *   `testdata/synth/c_major_scale_pos1.wav` (48 kHz) looped to exactly 60 s (2,880,000 samples):
 *   one warm-up, then 5 timed runs. The worker's own handler is synchronous, so it is called
 *   through `worker.evaluate` (as engine.spec.ts does) with `postMessage` captured, and timed with
 *   `performance.now()` inside the worker; the PCM is built before the clock starts. The run fails
 *   when `median × calibrationFactor` (`benchmark.config.json`) is over `analysis60sMs`
 *   (`budgets.json`). No retries.
 * - **Reported, never gated** (each in its own try/catch, shown as `n/a (reason)` when it
 *   cannot be measured; every browser call has a per-step timeout): the cold first analysis (a fresh context and worker, once the
 *   engine is ready); the peak wasm memory of a 5-minute analysis (the engine glue's
 *   `memory.buffer.byteLength` read in the worker afterwards; wasm memory only grows, so it is the
 *   high-water mark); and end to end, a 60 s take seeded through the Library's real Restore
 *   (`tests/e2e/seed-helpers.ts`), from opening `#/tab/{id}` until its note list shows.
 *
 * The report is a Markdown table on stdout, appended to `$GITHUB_STEP_SUMMARY` when set. Run with
 * Node's type stripping through `build/benchmark-cli.ts` (`pnpm --filter app benchmark`).
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, Page, Worker } from '@playwright/test';
import {
  loopPcm,
  readFixtureWav,
  restoreSeed,
  seedBackup,
  seedTake,
  wavFile,
} from '../tests/e2e/seed-helpers.ts';
import { DEFAULT_PREFS } from '../src/storage/prefs.ts';

/** The app directory (`app/`), which holds the budgets, the config and the default `dist/`. */
const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

/** `app/budgets.json`: `analysis60sMs` is this gate's limit. */
export const BUDGETS_PATH = resolve(APP_DIR, 'budgets.json');
/** `app/benchmark.config.json`: the runner's `calibrationFactor`. */
export const CONFIG_PATH = resolve(APP_DIR, 'benchmark.config.json');
/** The fixture every run analyses, looped. */
export const FIXTURE_PATH = resolve(APP_DIR, '..', 'testdata', 'synth', 'c_major_scale_pos1.wav');

/** Timed runs after the warm-up. */
export const RUNS = 5;
/** The gated take length (s) and the memory run's (s). */
const GATE_SECONDS = 60;
const MEMORY_SECONDS = 300;

/** Per-step limits on a browser call (ms): the 5-minute analysis, and anything else. */
const MEMORY_STEP_TIMEOUT_MS = 120_000;
const STEP_TIMEOUT_MS = 30_000;

/** The analyze input: the app's default analysis settings, no trim, no count-in skip. */
const ANALYZE_INPUT = {
  ...DEFAULT_PREFS.analysisDefaults,
  trimStartMs: 0,
  trimEndMs: null,
  skipStartMs: 0,
};

/** A config, measurement or browser problem: the run fails (exit 1) with this message. */
export class BenchmarkError extends Error {
  override name = 'BenchmarkError';
}

export interface BenchmarkConfig {
  /** The limit (ms) for the calibrated median, from `budgets.json`. */
  analysis60sMs: number;
  /** Laptop time / runner time, from `benchmark.config.json`. */
  calibrationFactor: number;
}

function readJsonObject(path: string, what: string): Record<string, unknown> {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new BenchmarkError(`cannot read ${what} ${path}: ${(e as Error).message}`);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json))
    throw new BenchmarkError(`${what} ${path}: not a JSON object`);
  return json as Record<string, unknown>;
}

/** Reads and validates `analysis60sMs` (a positive number) and `calibrationFactor` (positive). */
export function readConfig(budgetsPath: string, configPath: string): BenchmarkConfig {
  const budgets = readJsonObject(budgetsPath, 'budgets');
  const config = readJsonObject(configPath, 'benchmark config');
  const limit = budgets.analysis60sMs;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0)
    throw new BenchmarkError(
      `budgets ${budgetsPath}: "analysis60sMs" must be a positive number of milliseconds`,
    );
  const factor = config.calibrationFactor;
  if (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0)
    throw new BenchmarkError(
      `benchmark config ${configPath}: "calibrationFactor" must be a positive number`,
    );
  return { analysis60sMs: limit, calibrationFactor: factor };
}

/** The median: the middle value, or the mean of the two middle values for an even count. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new BenchmarkError('no runs to take the median of');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface Decision {
  medianMs: number;
  factor: number;
  /** `medianMs × factor`, the value gated. */
  gatedMs: number;
  limitMs: number;
  ok: boolean;
  /** Why the gate failed; absent when it passed. */
  error?: string;
}

const ms = (value: number) => `${Math.round(value)} ms`;

/** The gate: passes when `median(runs) × factor ≤ limitMs`. */
export function decide(runsMs: readonly number[], factor: number, limitMs: number): Decision {
  const medianMs = median(runsMs);
  const gatedMs = medianMs * factor;
  const ok = gatedMs <= limitMs;
  return {
    medianMs,
    factor,
    gatedMs,
    limitMs,
    ok,
    ...(ok
      ? {}
      : {
          error: `the 60 s analysis median ${ms(medianMs)} × calibration factor ${factor} = ${ms(gatedMs)} is over the ${ms(limitMs)} limit (analysis60sMs)`,
        }),
  };
}

/** A reported (never gated) value, or why it could not be measured. */
export type Reported = number | { na: string };

export interface Measurements {
  warmupMs: number;
  /** The timed runs, in order. */
  runsMs: number[];
  coldMs: Reported;
  /** The wasm memory after a 5-minute analysis (bytes). */
  peakWasmBytes: Reported;
  /** From opening the seeded take's Tab until its analysed notes show. */
  endToEndMs: Reported;
}

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
/** A reported value, or `n/a (reason)` with the reason on one line, safe in a table cell. */
const shown = (value: Reported, format: (v: number) => string) =>
  typeof value === 'number'
    ? format(value)
    : `n/a (${value.na.replace(/\s+/g, ' ').replace(/\|/g, '\\|')})`;

/** The Markdown report: the runs, the gate and the reported (ungated) values. */
export function report(m: Measurements, d: Decision): string {
  return [
    '## Analysis benchmark',
    '',
    '| Measure | Value |',
    '| --- | ---: |',
    `| Warm-up (60 s take) | ${ms(m.warmupMs)} |`,
    ...m.runsMs.map((r, i) => `| Run ${i + 1} (60 s take) | ${ms(r)} |`),
    `| Min / max (spread) | ${ms(Math.min(...m.runsMs))} / ${ms(Math.max(...m.runsMs))} (${ms(Math.max(...m.runsMs) - Math.min(...m.runsMs))}) |`,
    `| Median | ${ms(d.medianMs)} |`,
    `| Calibration factor | ${d.factor} |`,
    `| Gated (median × factor) | ${ms(d.gatedMs)} |`,
    `| Limit (analysis60sMs) | ${ms(d.limitMs)} |`,
    `| Gate | ${d.ok ? 'pass' : '**FAIL**'} |`,
    `| Cold first analysis, fresh context (reported) | ${shown(m.coldMs, ms)} |`,
    `| Peak wasm memory, 5-minute take (reported) | ${shown(m.peakWasmBytes, mib)} |`,
    `| End to end, seeded 60 s take, cold engine: from navigating to its Tab until the Note list view toggle shows (renders with the analysed notes) (reported) | ${shown(m.endToEndMs, ms)} |`,
    '',
  ].join('\n');
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Serves `distDir` at the root of a free localhost port, uncached. */
async function serveDist(distDir: string): Promise<{ url: string; server: Server }> {
  if (!existsSync(join(distDir, 'index.html')))
    throw new BenchmarkError(`${distDir} has no index.html: build the app first (pnpm build)`);
  const server = createServer((req, res) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const file = normalize(join(distDir, path.slice(1) || 'index.html'));
    if (!file.startsWith(distDir + sep)) {
      res.writeHead(404).end();
      return;
    }
    readFile(file).then(
      (body) => {
        const type = TYPES[extname(file)] ?? 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(body);
      },
      () => res.writeHead(404).end(),
    );
  });
  await new Promise<void>((done) => server.listen(0, 'localhost', done));
  const { port } = server.address() as AddressInfo;
  return { url: `http://localhost:${port}/`, server };
}

/**
 * `promise`, or a BenchmarkError naming `step` after `timeoutMs`. A promise left behind by a
 * timeout (its context is then closed) may still reject: that rejection is ignored.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  step: string,
): Promise<T> {
  promise.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new BenchmarkError(`${step} timed out after ${Math.round(timeoutMs / 1000)} s`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Opens Settings and returns the production engine worker once the engine is ready. */
async function engineWorker(page: Page): Promise<Worker> {
  await page.goto('./#/settings');
  try {
    await page
      .getByTestId('engine-version')
      .filter({ hasText: /^Engine v\d+\.\d+\.\d+$/ })
      .waitFor({ state: 'visible', timeout: 30_000 });
  } catch (e) {
    throw new BenchmarkError(`the engine did not become ready: ${(e as Error).message}`);
  }
  const worker = page.workers().find((w) => w.url().includes('engine-worker'));
  if (!worker) throw new BenchmarkError('no engine worker found');
  return worker;
}

/**
 * Runs `count` analyze calls, back to back, of the fixture looped to `samples` samples on the
 * engine worker's own handler, and returns each one's time (ms, `performance.now()` in the
 * worker). The PCM is built before the first clock starts. Throws on an engine error.
 */
async function analyzeInWorker(
  worker: Worker,
  fixture: { pcmBase64: string; sampleRate: number },
  samples: number,
  count: number,
  step: string,
  timeoutMs: number,
): Promise<number[]> {
  const evaluation = worker.evaluate(
    ({ pcmBase64, sampleRate, samples, count, input }) => {
      type Scope = {
        postMessage: (message: unknown) => void;
        onmessage: ((event: { data: unknown }) => void) | null;
      };
      const scope = self as unknown as Scope;
      const bytes = Uint8Array.from(atob(pcmBase64), (c) => c.charCodeAt(0));
      const source = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
      const pcm = new Float32Array(samples);
      for (let i = 0; i < samples; i++) pcm[i] = source[i % source.length]! / 32768;
      const handle = scope.onmessage;
      if (!handle) return { error: 'the engine worker has no message handler' };
      const times: number[] = [];
      const original = scope.postMessage;
      for (let run = 0; run < count; run++) {
        const replies: { type?: string; message?: string }[] = [];
        // The handler is synchronous, so every reply arrives before the restore.
        scope.postMessage = (message) => replies.push(message as { type?: string });
        let t: number;
        try {
          const t0 = performance.now();
          handle({
            data: {
              type: 'analyze',
              reqId: 90_000 + run,
              takeId: 'benchmark',
              pcm,
              sampleRate,
              input,
            },
          });
          t = performance.now() - t0;
        } finally {
          scope.postMessage = original;
        }
        const last = replies.at(-1);
        if (last?.type !== 'result')
          return { error: `run ${run}: ${last?.type ?? 'no reply'} ${last?.message ?? ''}`.trim() };
        times.push(t);
      }
      return { times };
    },
    { ...fixture, samples, count, input: ANALYZE_INPUT },
  );
  const result = await withTimeout(evaluation, timeoutMs, step);
  if ('error' in result) throw new BenchmarkError(`analyze failed: ${result.error}`);
  return result.times;
}

/**
 * The engine's wasm memory size (bytes), read in the worker: the engine glue the worker imported
 * (`import(`./engine-….js`)` in its own script) is imported again — the same module instance —
 * and its init, already done, returns the existing exports.
 */
async function wasmMemoryBytes(worker: Worker): Promise<number> {
  const evaluation = worker.evaluate(async () => {
    const source = await (await fetch(self.location.href)).text();
    const match = /import\(\s*[`'"](\.\/engine-[^`'"]+\.js)[`'"]\s*\)/.exec(source);
    if (!match) return { error: 'no engine glue import in the worker script' };
    const glue = (await import(new URL(match[1]!, self.location.href).href)) as {
      default: () => Promise<{ memory: WebAssembly.Memory }>;
    };
    return { bytes: (await glue.default()).memory.buffer.byteLength };
  });
  const result = await withTimeout(evaluation, STEP_TIMEOUT_MS, 'memory: reading wasm memory');
  if ('error' in result) throw new BenchmarkError(`reading wasm memory failed: ${result.error}`);
  return result.bytes;
}

/** A fresh context (service worker blocked) and page, closed after `use`. */
async function withPage<T>(
  browser: Browser,
  baseURL: string,
  run: (page: Page) => Promise<T>,
): Promise<T> {
  const context: BrowserContext = await browser.newContext({ baseURL, serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    return await run(page);
  } finally {
    await context.close();
  }
}

/** Every measurement, against the build in `distDir`; `log` gets progress lines. */
export async function measureAll(
  distDir: string,
  log: (line: string) => void = () => {},
): Promise<Measurements> {
  const { samples: fixturePcm, sampleRate } = readFixtureWav(FIXTURE_PATH);
  if (sampleRate !== 48_000) throw new BenchmarkError(`${FIXTURE_PATH}: not 48 kHz`);
  if (fixturePcm.length === 0) throw new BenchmarkError(`${FIXTURE_PATH}: no samples`);
  const fixture = {
    pcmBase64: Buffer.from(
      fixturePcm.buffer,
      fixturePcm.byteOffset,
      fixturePcm.byteLength,
    ).toString('base64'),
    sampleRate,
  };
  const gateSamples = GATE_SECONDS * sampleRate;

  const { chromium } = await import('@playwright/test');
  const { url, server } = await serveDist(distDir);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const b = browser;

    // The gate first: when it cannot be measured, the run fails.
    log('gate: warm-up and 5 timed runs of a 60 s take');
    const [warmupMs, ...runsMs] = await withPage(b, url, async (page) =>
      analyzeInWorker(
        await engineWorker(page),
        fixture,
        gateSamples,
        1 + RUNS,
        'gate: the warm-up and timed runs',
        // About 1.4 s each locally: the step's limit per run.
        (1 + RUNS) * STEP_TIMEOUT_MS,
      ),
    );

    // Reported values never fail the run: a failure is reported as n/a with its reason.
    const reported = async (what: string, measure: () => Promise<number>): Promise<Reported> => {
      try {
        return await measure();
      } catch (e) {
        const reason = e instanceof Error ? e.message.split('\n')[0]! : String(e);
        log(`${what}: not measured: ${reason}`);
        return { na: reason };
      }
    };

    log('cold: the first 60 s analysis in a fresh context');
    const coldMs = await reported('cold', async () => {
      const [cold] = await withPage(b, url, async (page) =>
        analyzeInWorker(
          await engineWorker(page),
          fixture,
          gateSamples,
          1,
          'cold: the first analysis',
          STEP_TIMEOUT_MS,
        ),
      );
      return cold!;
    });

    log('memory: one 5-minute analysis in a fresh context');
    const peakWasmBytes = await reported('memory', () =>
      withPage(b, url, async (page) => {
        const worker = await engineWorker(page);
        await analyzeInWorker(
          worker,
          fixture,
          MEMORY_SECONDS * sampleRate,
          1,
          'memory: the 5-minute analysis',
          MEMORY_STEP_TIMEOUT_MS,
        );
        return wasmMemoryBytes(worker);
      }),
    );

    log('end to end: a seeded 60 s take, open its Tab until its notes show');
    const endToEndMs = await reported('end to end', () =>
      withPage(b, url, async (page) => {
        const take = seedTake({ id: 'benchmark-60s', durationMs: GATE_SECONDS * 1000, sampleRate });
        const zip = seedBackup(take, wavFile(loopPcm(fixturePcm, gateSamples), sampleRate));
        await page.goto('./#/library');
        await restoreSeed(page, zip, { name: 'benchmark-seed.zip' });
        // The note list (`tab-note-list`) renders only once its "Note list view" toggle is on; the
        // toggle renders with the analysed notes, so the clock stops when it shows. The list is
        // then opened and must hold notes.
        const toggle = page.getByRole('button', { name: 'Note list view', exact: true });
        const t0 = performance.now();
        await page.goto(`./#/tab/${encodeURIComponent(take.id)}`);
        try {
          await toggle.waitFor({ state: 'visible', timeout: 60_000 });
        } catch (e) {
          throw new BenchmarkError(`the seeded take's notes never showed: ${(e as Error).message}`);
        }
        const elapsed = performance.now() - t0;
        await toggle.click();
        try {
          await page
            .getByTestId('tab-note-list')
            .locator('li')
            .first()
            .waitFor({ timeout: 10_000 });
        } catch (e) {
          throw new BenchmarkError(`the seeded take's note list is empty: ${(e as Error).message}`);
        }
        return elapsed;
      }),
    );

    return { warmupMs: warmupMs!, runsMs, coldMs: coldMs!, peakWasmBytes, endToEndMs };
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

export interface Args {
  distDir: string;
  /** `--limit-ms N`: overrides `analysis60sMs`, to check the failing path by hand. */
  limitMs?: number;
}

/** `[--limit-ms N] [distDir]`. */
export function parseArgs(argv: readonly string[]): Args {
  let distDir: string | undefined;
  let limitMs: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--limit-ms') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0)
        throw new BenchmarkError('--limit-ms needs a positive number of milliseconds');
      limitMs = value;
    } else if (arg.startsWith('-')) {
      throw new BenchmarkError(`unknown option ${arg}`);
    } else if (distDir === undefined) {
      distDir = resolve(arg);
    } else {
      throw new BenchmarkError(`unexpected argument ${arg}`);
    }
  }
  return { distDir: distDir ?? resolve(APP_DIR, 'dist'), ...(limitMs ? { limitMs } : {}) };
}

/**
 * The CLI: exit 0 when the gate passes, 1 when it fails or anything cannot be measured. The
 * budgets and config are read before the browser starts, so a bad config fails at once.
 */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  paths: { budgets: string; config: string } = { budgets: BUDGETS_PATH, config: CONFIG_PATH },
  measure: typeof measureAll = measureAll,
): Promise<number> {
  const summaryPath = env.GITHUB_STEP_SUMMARY || undefined;
  const fail = (message: string) => {
    console.error(`benchmark: ${message}`);
    if (summaryPath)
      appendFileSync(summaryPath, `## Analysis benchmark\n\n- **Benchmark failed:** ${message}\n`);
    return 1;
  };
  try {
    const args = parseArgs(argv);
    const config = readConfig(paths.budgets, paths.config);
    const limitMs = args.limitMs ?? config.analysis60sMs;
    const m = await measure(args.distDir, (line) => console.error(`benchmark: ${line}`));
    const decision = decide(m.runsMs, config.calibrationFactor, limitMs);
    const text = report(m, decision);
    console.log(text);
    if (summaryPath)
      appendFileSync(
        summaryPath,
        `${text}${decision.error ? `- **Benchmark failed:** ${decision.error}\n` : ''}`,
      );
    if (decision.error) console.error(`benchmark: ${decision.error}`);
    return decision.ok ? 0 : 1;
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
