# Stack and architecture

Single-page web app; analysis engine compiled to WebAssembly running in a Web Worker. No backend. Fixed tooling, repo layout, engine contract and worker protocol: `TabCreator-User-Stories.md` (top sections).

| Layer | Choice | Why |
| --- | --- | --- |
| UI | React + TypeScript, installable PWA | Works offline; installs without an app store |
| Audio capture | Web Audio API with AudioWorklet; echo cancellation, noise suppression, auto gain off | Low-latency raw PCM the browser has not altered |
| Analysis engine | Rust → WebAssembly, in a Web Worker | Near-native speed; testable outside the browser |
| Pitch model (v1) | pYIN pitch tracking + spectral-flux onset detection | Proven, lightweight, accurate for single notes; no ML model to ship |
| Pitch model (chords phase) | Spotify Basic Pitch via ONNX Runtime Web | Polyphonic detection in the browser |
| Storage | IndexedDB for takes and notes; Origin Private File System for audio | Local only (NFR-06) |

Target browser: desktop Chrome (last 2 versions, Windows and macOS); other Chromium browsers best-effort.

Tuner runs separately from the engine (light, real-time, main thread).

**Alternatives rejected**

- Electron or Tauri desktop app — better audio-device control, but needs an installer.
- Pure TypeScript engine instead of Rust/WASM — simpler build, slower analysis.
