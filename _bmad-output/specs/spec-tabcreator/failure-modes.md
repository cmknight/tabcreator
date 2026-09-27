# Failure modes

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Laptop mics pick up room noise, fan hum, speaker bleed | Missed or phantom notes | Level meter (CAP-3), noise gate (CAP-10), confidence flags (CAP-13), guidance to record close to the guitar |
| Octave errors on low strings and harmonics | Wrong notes on E and A strings | pYIN plus neighbour-based octave correction; dedicated test cases |
| Fast legato has weak onsets | Notes merged together | Pitch-change onsets in addition to spectral flux |
| Browsers process mic audio differently (echo cancellation, auto gain, sample rate) | Distorted pitch or level on some browsers | Processing off in getUserMedia constraints; cross-browser test matrix |
| Browser storage cleared or evicted | Saved takes lost | Request persistent storage; whole-library backup export (CAP-19) |
| Polyphonic phase is much harder | Phase 2 slips | Keep engine modular; prototype Basic Pitch early |
