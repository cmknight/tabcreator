# Failure modes

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Laptop mics pick up room noise, fan hum, speaker bleed | Missed or phantom notes | Level meter (CAP-3), noise gate (CAP-10), confidence flags (CAP-13), guidance to record close to the guitar |
| Octave errors on low strings and harmonics | Wrong notes on E and A strings | pYIN plus confidence-gated octave correction; test cases including genuine octave leaps |
| Fast legato has weak onsets | Notes merged together | Pitch-change onsets in addition to spectral flux |
| Mic processing (echo cancellation, auto gain, sample rate) alters the signal | Distorted pitch or level | Processing off in getUserMedia constraints; Chrome-only target |
| Bends, slides, vibrato, ringing strings played though not notated | Wrong, split or duplicate notes | CAP-28 behaviour; fixture per case |
| Count-in clicks bleed into the take (echo cancellation off) | Phantom note at start | Skip first 100 ms after count-in; click-bleed fixture |
| Guitar detuned, tuned down, or capo | Consistently wrong notes | Tuner; detuned and drop-tuning warnings (CAP-27) |
| Bluetooth headset mic switches to call mode | Pitch accuracy destroyed | Sample-rate/device warnings (CAP-26) |
| Browser storage cleared or evicted | Saved takes lost | Request persistent storage; whole-library backup export (CAP-19) |
| Polyphonic phase is much harder | Phase 2 slips | Keep engine modular; prototype Basic Pitch early |
