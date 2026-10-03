// The recorder's AudioWorklet processor (spine AD-2, AD-9). Loaded by audio/recorder.ts with
// `audioWorklet.addModule` from its own same-origin file, so it imports nothing.
//
// It copies the mono input from a start frame up to a stop frame (both on the audio clock, so
// they are sample-exact) and posts it in 1 s chunks (`sampleRate` samples, the context's rate).
// It posts `started` once, in the block that copies the first frame (the start frame), so the
// main thread learns when capture began without waiting for the first 1 s chunk. After the stop
// frame it posts the final partial chunk, then `stopped`, and ends.
//
// Port messages in:  { type: 'start', frame }  { type: 'stop', frame }
// Port messages out: { type: 'started' }  { type: 'chunk', samples: Float32Array }
//                    { type: 'stopped' }

const CHUNK_SAMPLES = Math.max(1, Math.round(sampleRate));

class RecorderProcessor extends AudioWorkletProcessor {
  private startFrame = Infinity;
  private stopFrame = Infinity;
  private chunk = new Float32Array(CHUNK_SAMPLES);
  private filled = 0;
  private done = false;
  private started = false;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<{ type: 'start' | 'stop'; frame: number }>) => {
      const { type, frame } = event.data;
      if (type === 'start') this.startFrame = frame;
      else if (type === 'stop') this.stopFrame = frame;
    };
  }

  /** Posts the filled part of the current chunk (transferred) and starts a new one. */
  private flush(): void {
    if (this.filled === 0) return;
    const samples = this.filled === CHUNK_SAMPLES ? this.chunk : this.chunk.slice(0, this.filled);
    this.port.postMessage({ type: 'chunk', samples }, [samples.buffer]);
    this.chunk = new Float32Array(CHUNK_SAMPLES);
    this.filled = 0;
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.done) return false;
    const channel = inputs[0]?.[0];
    const length = channel?.length ?? 128;
    const blockStart = currentFrame;
    const blockEnd = blockStart + length;
    const from = Math.max(this.startFrame, blockStart);
    const to = Math.min(this.stopFrame, blockEnd);
    if (!this.started && from < to) {
      this.started = true;
      this.port.postMessage({ type: 'started' });
    }
    for (let f = from; f < to; f++) {
      // A disconnected input (no channel) records silence, so the timeline never shrinks.
      this.chunk[this.filled++] = channel ? (channel[f - blockStart] ?? 0) : 0;
      if (this.filled === CHUNK_SAMPLES) this.flush();
    }
    if (this.stopFrame <= blockEnd) {
      this.flush();
      this.port.postMessage({ type: 'stopped' });
      this.done = true;
      return false;
    }
    return true;
  }
}

registerProcessor('tabcreator-recorder', RecorderProcessor);
