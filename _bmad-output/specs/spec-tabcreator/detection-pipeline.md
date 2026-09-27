# Detection pipeline and fret mapping

Exact parameters, cost weights and sensitivity mapping: stories US-4.1–US-4.6, US-5.1–US-5.2.

## Audio to notes

1. **Pre-process** — skip the first 100 ms after a count-in (click bleed), downmix to mono, resample to 22.05 kHz, high-pass at 60 Hz, normalize level.
2. **Pitch tracking** — pYIN pitch + voicing probability per ~10 ms frame, limited to 75–1400 Hz.
3. **Onset detection** — spectral flux marks each pick, including repeated same-pitch notes; pitch-change onsets added for weak legato attacks.
4. **Note building** — frames between onsets merge into one note: median pitch rounded to nearest semitone, start, end, confidence.
5. **Clean-up** — drop notes < 40 ms or below confidence threshold (threshold rises as sensitivity falls); correct an octave jump only when its pitch confidence is low; flag doubtful notes for review (CAP-13); raise tuning warnings (CAP-27).

Unnotated techniques (CAP-28): ringing strings must not produce duplicate notes; vibrato must not split a note; a bend or slide becomes its starting note, flagged low-confidence.

## Notes to string and fret

Open strings: E2 82.4 Hz, A2 110 Hz, D3 146.8 Hz, G3 196 Hz, B3 246.9 Hz, E4 329.6 Hz. Most pitches are playable in 2–5 places, so mapping is a shortest-path (Viterbi) problem across the whole take:

- Each candidate (string, fret) for a note is a state.
- Transition cost grows with hand-shift fret distance, string skips, and stretches beyond 4 frets.
- Small biases prefer frets 0–12, and open strings when surrounding notes are low on the neck.
- The cheapest path is the default tab.
- An edited or confirmed note is locked; the rest of its phrase is re-optimized around it, never changing other locked notes; notes the re-fit changed are briefly highlighted; edit + re-fit is one undo step.

Cost weights are tuned against the NFR-03 test set.
