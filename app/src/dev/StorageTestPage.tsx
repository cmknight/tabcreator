// Dev-only storage test page at `#/__test/storage` (stories US-0.3). Runs the checks that need a
// real browser (OPFS) and prints their results as JSON for Playwright. Never shipped: App.tsx
// loads it only under import.meta.env.DEV. Not user-facing, so its text is not in ui/strings.ts.

import { useState } from 'react';
import type { Tab, Take } from '../model/types';
import { audioStore, type RawWriter } from '../storage/audio-store';
import { db } from '../storage/db';
import { subscribe, type StorageEvent } from '../storage/events';

const SAMPLE_RATE = 48_000;
const CHUNKS = 10;

/** A deterministic, non-trivial test signal: a tone plus a sample-index ramp. */
function chunk(index: number): Float32Array {
  const samples = new Float32Array(SAMPLE_RATE);
  for (let i = 0; i < samples.length; i++) {
    const n = index * SAMPLE_RATE + i;
    samples[i] = 0.5 * Math.sin((2 * Math.PI * 440 * n) / SAMPLE_RATE) + n / 1e7;
  }
  return samples;
}

function sameBits(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  const x = new Uint32Array(a.buffer, a.byteOffset, a.length);
  const y = new Uint32Array(b.buffer, b.byteOffset, b.length);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** Best-effort clean-up that never masks the check's own result or error. */
async function quietly(step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch {
    // Ignored: clean-up only.
  }
}

async function rawRoundTrip() {
  const id = `dev-raw-${crypto.randomUUID()}`;
  const expected = new Float32Array(SAMPLE_RATE * CHUNKS);
  const writer = await audioStore.openRawWriter(id);
  try {
    for (let c = 0; c < CHUNKS; c++) {
      const samples = chunk(c);
      expected.set(samples, c * SAMPLE_RATE);
      await writer.append(samples);
    }
    await writer.close();
    const read = await audioStore.readRaw(id);
    const result = {
      length: read.length,
      expectedLength: expected.length,
      sampleExact: sameBits(read, expected),
    };
    await audioStore.deleteRaw(id);
    return { ...result, leftover: (await audioStore.listRaw()).includes(id) };
  } finally {
    await quietly(() => writer.close());
    await quietly(() => audioStore.deleteRaw(id));
  }
}

async function presence(id: string) {
  return {
    take: (await db.getTake(id)) !== null,
    tab: (await db.getTab(id)) !== null,
    audio: (await audioStore.readCompressed(id)) !== null,
    raw: (await audioStore.listRaw()).includes(id),
  };
}

async function deleteCleanUp() {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const take: Take = {
    id,
    title: 'Storage test take',
    createdAt,
    status: 'recorded',
    durationMs: 1000,
    sampleRate: SAMPLE_RATE,
    tuning: 'EADGBE',
    micLabel: 'Test',
    audioMime: 'audio/webm;codecs=opus',
    trimStartMs: 0,
    trimEndMs: null,
    settings: { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 },
    analysisVersion: null,
    updatedAt: createdAt,
  };
  const tab: Tab = { takeId: id, notes: [], updatedAt: createdAt, deletedStartMs: [] };

  let writer: RawWriter | null = null;
  try {
    await db.createTake(take);
    await db.putTab(tab, 'take-session');
    await audioStore.writeCompressed(
      id,
      new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm;codecs=opus' }),
    );
    writer = await audioStore.openRawWriter(id);
    await writer.append(chunk(0));
    await writer.close();
    const before = await presence(id);

    const events: StorageEvent[] = [];
    const unsubscribe = subscribe((e) => {
      if ('takeId' in e && e.takeId === id) events.push(e);
    });
    try {
      await db.deleteTake(id, 'library-session');
    } finally {
      unsubscribe();
    }
    return { before, after: await presence(id), events };
  } finally {
    const open = writer;
    if (open) await quietly(() => open.close());
    await quietly(() => db.deleteTake(id, 'library-session'));
  }
}

/**
 * Writes webm then ogg for one take. `readCompressed` probes the formats in table order
 * (webm before ogg), so getting the ogg blob back proves the `.webm` file was removed.
 */
async function formatReplace() {
  const id = `dev-format-${crypto.randomUUID()}`;
  try {
    await audioStore.writeCompressed(
      id,
      new Blob([new Uint8Array([1, 1, 1])], { type: 'audio/webm;codecs=opus' }),
    );
    await audioStore.writeCompressed(
      id,
      new Blob([new Uint8Array([2, 2, 2, 2])], { type: 'audio/ogg;codecs=opus' }),
    );
    const blob = await audioStore.readCompressed(id);
    const bytes = blob ? [...new Uint8Array(await blob.arrayBuffer())] : null;
    return {
      type: blob?.type ?? null,
      bytes,
      webmGone: blob?.type === 'audio/ogg;codecs=opus',
    };
  } finally {
    await quietly(() => audioStore.deleteAudio(id));
  }
}

function Check({ name, label, run }: { name: string; label: string; run: () => Promise<unknown> }) {
  const [output, setOutput] = useState('');
  const onClick = async () => {
    setOutput('running');
    try {
      setOutput(JSON.stringify(await run()));
    } catch (err) {
      const e = err as { name?: string; code?: string; message?: string };
      setOutput(JSON.stringify({ error: e.code ?? e.name ?? 'Error', message: e.message }));
    }
  };
  return (
    <section>
      <button type="button" onClick={() => void onClick()}>
        {label}
      </button>
      <pre data-testid={`${name}-result`}>{output}</pre>
    </section>
  );
}

export default function StorageTestPage() {
  return (
    <main>
      <h1>Storage test page</h1>
      <Check name="raw" label="Run raw round-trip" run={rawRoundTrip} />
      <Check name="delete" label="Run delete clean-up" run={deleteCleanUp} />
      <Check name="format" label="Run format replace" run={formatReplace} />
    </main>
  );
}
