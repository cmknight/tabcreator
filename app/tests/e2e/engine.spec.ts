import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Worker } from '@playwright/test';
import { engineWorker } from './engine-helpers';
import { collectErrors } from './helpers';
import { readFixtureWav } from './seed-helpers';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SYNTH = join(ROOT, 'testdata', 'synth');
/** The test-only engine built with the `test-panic` feature (`pnpm build:engine:test-panic`). */
const TEST_PANIC_PKG = join(ROOT, 'engine', 'test-panic-pkg');
/** The production engine glue the app bundles (`pnpm build:engine`). */
const PRODUCTION_PKG = join(ROOT, 'app', 'src', 'engine', 'pkg');
/** The sample rate on which the test-panic engine panics (engine `TEST_PANIC_SAMPLE_RATE`). */
const TEST_PANIC_SAMPLE_RATE = 12345;
/** Onset tolerance for a detected note to match a ground-truth note (ms). */
const ONSET_TOLERANCE_MS = 50;

// These tests route the wasm (`page.route`). Once the app's service worker controls the page,
// it would serve the precached wasm itself, past the route, so the worker is blocked here; the
// service worker has its own specs (offline.prod.spec.ts, subpath.spec.ts).
test.use({ serviceWorkers: 'block' });

test('Settings shows the engine version', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('./#/settings');
  await expect(page.getByRole('heading', { level: 2, name: 'About' })).toBeVisible();
  await expect(page.getByTestId('engine-version')).toHaveText(/^Engine v\d+\.\d+\.\d+$/);
  await expect(page.getByText('The analysis engine failed to load')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a wasm that fails to load shows the engine-failed banner with Reload', async ({ page }) => {
  const errors = collectErrors(page);
  await page.route('**/*.wasm', (route) => route.abort());
  await page.goto('./#/settings');
  await expect(page.getByText('The analysis engine failed to load')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
  await expect(page.getByTestId('engine-version')).toHaveText('Engine version unavailable');
  // Only the blocked wasm request itself may log.
  expect(errors.filter((e) => !e.includes('Failed to load resource'))).toEqual([]);

  // Reload goes through session/app-reload.ts; with the wasm unblocked the engine loads.
  await page.unroute('**/*.wasm');
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByTestId('engine-version')).toHaveText(/^Engine v\d+\.\d+\.\d+$/);
});

type Reply = {
  type: string;
  reqId: number;
  fraction?: number;
  payload?: unknown;
  code?: string;
  message?: string;
};

/** The analyze input the e2e requests send: no trim, no skip. */
const ANALYZE_INPUT = {
  sensitivity: 0.5,
  minNoteMs: 40,
  maxFret: 24,
  trimStartMs: 0,
  trimEndMs: null,
  skipStartMs: 0,
};

type FixtureNote = { startMs: number; endMs: number; midi: number; string: number; fret: number };

/** The `c_major_scale_pos1` fixture: its PCM, sample rate and ground-truth notes. */
function readScaleFixture(): { data: Buffer; sampleRate: number; truth: FixtureNote[] } {
  const { samples, sampleRate } = readFixtureWav(join(SYNTH, 'c_major_scale_pos1.wav'));
  // Back to the WAV's little-endian 16-bit bytes: assumes a little-endian host (Int16Array order).
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const answer = JSON.parse(readFileSync(join(SYNTH, 'c_major_scale_pos1.json'), 'utf8')) as {
    notes: FixtureNote[];
  };
  return { data, sampleRate, truth: answer.notes };
}

/** The sentinel panic message the `test-panic` engine raises. */
const PANIC_TEXT = 'test-panic: sentinel sample rate';

/**
 * Sends `requests` in order to the engine worker's own onmessage handler, with postMessage
 * captured, and returns every reply. An `analyze` request's `pcm` is the 16-bit PCM in
 * `pcmBase64`, scaled to floats in the worker. No dev-only hook is needed in app code.
 */
async function sendToWorker(
  worker: Worker,
  requests: Record<string, unknown>[],
  pcmBase64 = '',
): Promise<Reply[]> {
  const replies = await worker.evaluate(
    ({ requests, pcmBase64 }) => {
      type Scope = {
        postMessage: (message: unknown) => void;
        onmessage: ((event: { data: unknown }) => void) | null;
      };
      const scope = self as unknown as Scope;
      const bytes = Uint8Array.from(atob(pcmBase64), (c) => c.charCodeAt(0));
      const samples = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
      const pcm = Float32Array.from(samples, (s) => s / 32768);
      const captured: unknown[] = [];
      const original = scope.postMessage;
      // Capture works because the handler is synchronous: replies sent after the `finally`
      // restore would go to the real client instead.
      scope.postMessage = (message) => captured.push(message);
      try {
        const handle = scope.onmessage;
        if (!handle) throw new Error('engine worker has no message handler');
        for (const request of requests) {
          handle({ data: request.type === 'analyze' ? { ...request, pcm } : request });
        }
      } finally {
        scope.postMessage = original;
      }
      return captured;
    },
    { requests, pcmBase64 },
  );
  return replies as Reply[];
}

// Epic Detection engine, done-when 4: the production engine worker runs analyze and map_frets
// on a fixture and returns the fixture's notes and positions.
test('the production engine worker detects and maps the notes of a fixture', async ({ page }) => {
  const errors = collectErrors(page);
  const worker = await engineWorker(page);

  const { data, sampleRate, truth } = readScaleFixture();
  expect(sampleRate).toBe(48_000);
  expect(truth).toHaveLength(12);

  const analyzed = await sendToWorker(
    worker,
    [{ type: 'analyze', reqId: 9001, takeId: 'e2e', sampleRate, input: ANALYZE_INPUT }],
    data.toString('base64'),
  );
  expect(analyzed.filter((m) => m.type === 'error')).toEqual([]);
  expect(analyzed.every((m) => m.reqId === 9001)).toBe(true);

  // Progress is monotone and ends at 1.
  const fractions = analyzed.filter((m) => m.type === 'progress').map((m) => m.fraction!);
  expect(fractions.length).toBeGreaterThan(0);
  for (let i = 1; i < fractions.length; i++) {
    expect(fractions[i], `progress ${i}`).toBeGreaterThanOrEqual(fractions[i - 1]!);
  }
  expect(fractions.at(-1)).toBe(1);

  const result = analyzed.at(-1);
  expect(result?.type).toBe('result');
  const payload = result?.payload as {
    notes: { startMs: number; endMs: number; midi: number }[];
    confidenceThreshold: number;
  };
  // The engine reports the confidence threshold c it used (0.35 at sensitivity 0.5).
  expect(payload.confidenceThreshold).toBe(0.35);
  const detected = payload.notes;

  // Each ground-truth note matches the unused detected note of the same MIDI with the closest
  // onset within 50 ms, and no detected note is left over.
  const used = new Set<number>();
  const matchOf: number[] = [];
  const mismatches: string[] = [];
  for (const want of truth) {
    let at = -1;
    detected.forEach((d, i) => {
      const off = Math.abs(d.startMs - want.startMs);
      if (used.has(i) || d.midi !== want.midi || off > ONSET_TOLERANCE_MS) return;
      if (at < 0 || off < Math.abs(detected[at]!.startMs - want.startMs)) at = i;
    });
    if (at < 0) mismatches.push(`missed midi ${want.midi} at ${want.startMs} ms`);
    else used.add(at);
    matchOf.push(at);
  }
  detected.forEach((d, i) => {
    if (!used.has(i)) mismatches.push(`extra midi ${d.midi} at ${d.startMs} ms`);
  });
  expect(mismatches, JSON.stringify(detected)).toEqual([]);

  // The detected notes map to the fixture's positions (notes already reported missing are
  // skipped).
  const notes = detected.map(({ midi, startMs, endMs }) => ({ midi, startMs, endMs }));
  const mapped = await sendToWorker(worker, [
    { type: 'mapFrets', reqId: 9002, takeId: 'e2e', notes, locks: [], maxFret: 24 },
  ]);
  expect(mapped).toHaveLength(1);
  expect(mapped[0]?.type).toBe('result');
  const positions = mapped[0]?.payload as ({ string: number; fret: number } | null)[];
  expect(positions).toHaveLength(notes.length);
  const wrong = truth.flatMap((want, i) => {
    const at = matchOf[i]!;
    if (at < 0) return [];
    const p = positions[at];
    return p?.string === want.string && p.fret === want.fret
      ? []
      : [`midi ${want.midi}: got ${JSON.stringify(p)}, want ${want.string}/${want.fret}`];
  });
  expect(wrong).toEqual([]);
  expect(errors).toEqual([]);
});

// Epic 1, US-0.2 (settled by epic Detection engine, story 10): a real Rust panic rejects its
// request with `analysis-failed` and the panic's own message, and the same worker keeps
// serving, also after repeated traps (the trap unwinds neither the shadow stack nor
// allocations). The page is served the test-only engine built with the `test-panic` feature in
// place of the production wasm; its JS glue is the production one, which the test checks first.
test('a real Rust panic rejects its request and the worker serves the next', async ({ page }) => {
  const testWasm = join(TEST_PANIC_PKG, 'engine_bg.wasm');
  if (!existsSync(testWasm)) {
    throw new Error(`${testWasm} missing: run \`pnpm build:engine:test-panic\` first`);
  }
  expect(
    readFileSync(join(TEST_PANIC_PKG, 'engine.js'), 'utf8'),
    'the test wasm glue differs from the production glue: rebuild both engine packages ' +
      '(`pnpm build:engine && pnpm build:engine:test-panic`)',
  ).toBe(readFileSync(join(PRODUCTION_PKG, 'engine.js'), 'utf8'));

  const errors = collectErrors(page);
  let served = 0;
  await page.route('**/*.wasm', (route) => {
    served++;
    return route.fulfill({
      status: 200,
      contentType: 'application/wasm',
      body: readFileSync(testWasm),
    });
  });
  const worker = await engineWorker(page);
  expect(served, 'the test wasm was served').toBeGreaterThan(0);

  const { data, sampleRate, truth } = readScaleFixture();
  const panicIds = [9101, 9102, 9103];
  const replies = await sendToWorker(
    worker,
    [
      ...panicIds.map((reqId) => ({
        type: 'analyze',
        reqId,
        takeId: 'e2e',
        sampleRate: TEST_PANIC_SAMPLE_RATE,
        input: ANALYZE_INPUT,
      })),
      { type: 'analyze', reqId: 9104, takeId: 'e2e', sampleRate, input: ANALYZE_INPUT },
    ],
    data.toString('base64'),
  );

  for (const reqId of panicIds) {
    const own = replies.filter((m) => m.reqId === reqId);
    const failure = own.at(-1);
    expect(failure?.type, `request ${reqId}`).toBe('error');
    expect(failure?.code, `request ${reqId}`).toBe('analysis-failed');
    expect(failure?.message, `request ${reqId}`).toContain(PANIC_TEXT);
  }
  // console_error_panic_hook also logs the panic message.
  expect(errors.some((e) => e.includes(PANIC_TEXT))).toBe(true);

  const next = replies.filter((m) => m.reqId === 9104);
  expect(next.filter((m) => m.type === 'error')).toEqual([]);
  const result = next.at(-1);
  expect(result?.type).toBe('result');
  const payload = result?.payload as { notes: { midi: number }[] };
  expect(payload.notes.map((n) => n.midi)).toEqual(truth.map((n) => n.midi));
  expect(errors.filter((e) => !e.includes(PANIC_TEXT))).toEqual([]);
});
