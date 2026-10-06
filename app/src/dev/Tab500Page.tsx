// Dev-only 500-note tab page at `#/__test/tab500` (story "500-note edit latency", CAP-14, AD-17).
// Seeds the generated 500-note tab (dev/tab500.ts) as an analysed take with no audio, as the
// e2e `seedTab` helper does (`createTake`, then `commitAnalysis`), then replaces the hash with
// its Tab screen. `#/__test/tab500?onePhrase` seeds the one-phrase shape. Never shipped: App.tsx
// loads it only under import.meta.env.DEV. Not user-facing, so its text is not in ui/strings.ts.

import { useEffect, useState } from 'react';
import { db } from '../storage/db';
import { tab500Notes } from './tab500';

/**
 * The seed in flight per shape (true: one phrase). StrictMode mounts the page twice; the second
 * mount reuses the first's seed instead of seeding a second, orphaned take. Cleared once it
 * settles, so a later visit seeds a fresh take.
 */
const inFlight = new Map<boolean, Promise<string>>();

/** Seeds the take for a shape once per visit (see `inFlight`); returns its id. */
function seedOnce(onePhrase: boolean): Promise<string> {
  let seed = inFlight.get(onePhrase);
  if (!seed) {
    seed = seedTab500(onePhrase);
    const clear = () => inFlight.delete(onePhrase);
    seed.then(clear, clear);
    inFlight.set(onePhrase, seed);
  }
  return seed;
}

/** Seeds the take; returns its id. */
async function seedTab500(onePhrase: boolean): Promise<string> {
  const notes = tab500Notes({ onePhrase });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.createTake({
    id,
    title: onePhrase ? '500 notes, one phrase' : '500 notes',
    createdAt: now,
    status: 'recorded',
    durationMs: notes.at(-1)!.endMs + 1000,
    sampleRate: 48_000,
    tuning: 'EADGBE',
    micLabel: 'Seeded mic',
    audioMime: null,
    trimStartMs: 0,
    trimEndMs: null,
    settings: { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 },
    analysisVersion: null,
    updatedAt: now,
  });
  await db.commitAnalysis(
    id,
    { takeId: id, notes, updatedAt: now, deletedStartMs: [] },
    { status: 'analyzed', analysisVersion: 'seeded' },
  );
  return id;
}

export default function Tab500Page() {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const onePhrase = /[?&]onePhrase(&|=|$)/.test(window.location.hash);
    seedOnce(onePhrase).then(
      (id) => {
        if (live) window.location.replace(`#/tab/${encodeURIComponent(id)}`);
      },
      (err: unknown) => {
        if (live) setError(String(err));
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return (
    <div>
      <h1>500-note tab</h1>
      <p data-testid="tab500-status">{error ?? 'Seeding…'}</p>
    </div>
  );
}
