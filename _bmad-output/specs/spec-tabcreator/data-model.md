# Data model

Persisted entities. The stories' TypeScript types (`Take`, `Tab`, `Note`, `DetectedNote`, `AnalysisSettings`) are the implementation of these.

| Entity | Key fields |
| --- | --- |
| Take | id, title, createdAt, durationMs, audioRef, sampleRate, tuning ("EADGBE"), analysisVersion, countInBpm (optional; drives bar lines) |
| Note | id, takeId, startMs, endMs, midiPitch, string (1–6), fret (0–24), confidence (0–1), lockedByUser |
| AnalysisSettings | sensitivity, minNoteMs, maxFret |

- Confidence threshold is derived from sensitivity, not stored as its own setting.
- Undo/redo history is in memory for the session only; edits are not persisted as entities.
- `analysisVersion` lets a later engine re-analyze old takes without losing user edits to locked notes.
- String 1 = high e, 6 = low E.
