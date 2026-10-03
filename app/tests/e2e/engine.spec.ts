import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { collectErrors } from './helpers';

const SYNTH = join(import.meta.dirname, '..', '..', '..', 'testdata', 'synth');

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

/** The PCM data chunk (16-bit mono) and sample rate of a fixture WAV. */
function readFixtureWav(path: string): { data: Buffer; sampleRate: number } {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path}: not a RIFF/WAVE file`);
  }
  let sampleRate = 0;
  for (let at = 12; at + 8 <= b.length;) {
    const id = b.toString('ascii', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      if (b.readUInt16LE(at + 8) !== 1 || b.readUInt16LE(at + 10) !== 1) {
        throw new Error(`${path}: not PCM mono`);
      }
      if (b.readUInt16LE(at + 22) !== 16) throw new Error(`${path}: not 16-bit`);
      sampleRate = b.readUInt32LE(at + 12);
    } else if (id === 'data') {
      return { data: b.subarray(at + 8, at + 8 + size), sampleRate };
    }
    at += 8 + size + (size & 1);
  }
  throw new Error(`${path}: no data chunk`);
}

// Epic Detection engine, done-when 4: the production engine worker runs analyze and map_frets
// on a fixture. The test drives the worker the Settings screen spawned, calling its own
// onmessage handler with postMessage captured, so no dev-only hook is needed in app code.
test('the production engine worker runs analyze and map_frets on a fixture', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('./#/settings');
  await expect(page.getByTestId('engine-version')).toHaveText(/^Engine v\d+\.\d+\.\d+$/);
  const worker = page.workers().find((w) => w.url().includes('engine-worker'));
  expect(worker, 'the engine worker').toBeDefined();

  const { data, sampleRate } = readFixtureWav(join(SYNTH, 'c_major_scale_pos1.wav'));
  const answer = JSON.parse(readFileSync(join(SYNTH, 'c_major_scale_pos1.json'), 'utf8')) as {
    notes: { startMs: number; endMs: number; midi: number }[];
  };
  const notes = answer.notes.map(({ midi, startMs, endMs }) => ({ midi, startMs, endMs }));

  const replies = await worker!.evaluate(
    ({ pcmBase64, sampleRate, notes }) => {
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
        handle({
          data: {
            type: 'analyze',
            reqId: 9001,
            takeId: 'e2e',
            pcm,
            sampleRate,
            input: {
              sensitivity: 0.5,
              minNoteMs: 40,
              maxFret: 24,
              trimStartMs: 0,
              trimEndMs: null,
              skipStartMs: 0,
            },
          },
        });
        handle({
          data: { type: 'mapFrets', reqId: 9002, takeId: 'e2e', notes, locks: [], maxFret: 24 },
        });
      } finally {
        scope.postMessage = original;
      }
      return captured;
    },
    { pcmBase64: data.toString('base64'), sampleRate, notes },
  );

  type Reply = { type: string; reqId: number; fraction?: number; payload?: unknown };
  const all = replies as Reply[];
  expect(all.filter((m) => m.type === 'error')).toEqual([]);

  const analyzed = all.filter((m) => m.reqId === 9001);
  const progress = analyzed.filter((m) => m.type === 'progress');
  expect(progress.at(-1)?.fraction).toBe(1);
  // Any valid AnalysisResult: the worker path is under test, not detection quality.
  const result = analyzed.at(-1);
  expect(result?.type).toBe('result');
  const payload = result?.payload as {
    notes: unknown;
    tuningOffsetCents: unknown;
    belowRangeNotes: unknown;
  };
  expect(Array.isArray(payload.notes)).toBe(true);
  for (const note of payload.notes as Record<string, unknown>[]) {
    for (const key of ['startMs', 'endMs', 'midi', 'confidence']) {
      expect(typeof note[key], key).toBe('number');
    }
  }
  expect(typeof payload.tuningOffsetCents).toBe('number');
  expect(typeof payload.belowRangeNotes).toBe('number');

  const mapped = all.filter((m) => m.reqId === 9002);
  expect(mapped).toHaveLength(1);
  expect(mapped[0]?.type).toBe('result');
  const positions = mapped[0]?.payload as ({ string: number; fret: number } | null)[];
  expect(positions).toHaveLength(notes.length);
  for (const p of positions) {
    expect(p).not.toBeNull();
    expect(p!.string).toBeGreaterThanOrEqual(1);
    expect(p!.string).toBeLessThanOrEqual(6);
    expect(p!.fret).toBeGreaterThanOrEqual(0);
    expect(p!.fret).toBeLessThanOrEqual(24);
  }
  expect(errors).toEqual([]);
});
