// Dev-only 500-take library page at `#/__test/library500` (story "Search 500 takes", CAP-17).
// Seeds the generated library (dev/library500.ts): 500 analysed takes with deterministic titles
// and a small tab each, no audio, as the e2e `seedTab` helper does (`createTake`, then
// `commitAnalysis`) in sequential batches, then replaces the hash with the Library. A profile that
// already holds the 500 seeded takes is not seeded again. Never shipped: App.tsx loads it
// only under import.meta.env.DEV. Not user-facing, so its text is not in ui/strings.ts.

import { useEffect, useState } from 'react';
import { db } from '../storage/db';
import { LIBRARY500_COUNT, library500Notes, library500Title } from './library500';

/**
 * The seed in flight. StrictMode mounts the page twice; the second mount reuses the first's seed
 * instead of seeding 500 more takes. Cleared once it settles, so a later visit seeds again.
 */
let inFlight: Promise<void> | null = null;

function seedOnce(): Promise<void> {
  if (!inFlight) {
    const seed = seedLibrary500();
    const clear = () => {
      inFlight = null;
    };
    seed.then(clear, clear);
    inFlight = seed;
  }
  return inFlight;
}

/** Marks the seeded takes, so a later visit can tell they are already there. */
const SEED_MIC = 'Seeded mic (library500)';
/** Takes written at once; the batches run one after another. */
const BATCH = 25;

/** Seeds take `i` (1-based) at `base` + `i` seconds. */
async function seedTake(i: number, base: number): Promise<void> {
  const id = crypto.randomUUID();
  const createdAt = new Date(base + i * 1000).toISOString();
  const notes = library500Notes(i);
  await db.createTake({
    id,
    title: library500Title(i),
    createdAt,
    status: 'recorded',
    durationMs: notes.at(-1)!.endMs + 1000,
    sampleRate: 48_000,
    tuning: 'EADGBE',
    micLabel: SEED_MIC,
    audioMime: null,
    trimStartMs: 0,
    trimEndMs: null,
    settings: { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 },
    analysisVersion: null,
    updatedAt: createdAt,
  });
  await db.commitAnalysis(
    id,
    { takeId: id, notes, updatedAt: createdAt, deletedStartMs: [] },
    { status: 'analyzed', analysisVersion: 'seeded' },
  );
}

/**
 * Seeds every take, `BATCH` at a time: take 1 the oldest, take 500 the newest (all before now).
 * Nothing when the 500 seeded takes are already stored.
 */
async function seedLibrary500(): Promise<void> {
  const seeded = (await db.listTakes()).filter((t) => t.micLabel === SEED_MIC).length;
  if (seeded >= LIBRARY500_COUNT) return;
  const base = Date.now() - (LIBRARY500_COUNT + 1) * 1000;
  for (let from = 1; from <= LIBRARY500_COUNT; from += BATCH) {
    const to = Math.min(LIBRARY500_COUNT, from + BATCH - 1);
    await Promise.all(Array.from({ length: to - from + 1 }, (_, k) => seedTake(from + k, base)));
  }
}

export default function Library500Page() {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    seedOnce().then(
      () => {
        if (live) window.location.replace('#/library');
      },
      (err: unknown) => {
        if (live) setError(`Seeding failed: ${String(err)}`);
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return (
    <div>
      <h1>500-take library</h1>
      <p data-testid="library500-status">{error ?? 'Seeding…'}</p>
    </div>
  );
}
