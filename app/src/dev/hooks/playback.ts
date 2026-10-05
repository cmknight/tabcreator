// Dev-only playback trace (story 5.10): each change of the playing cursor to a note appends
// `{ noteId, mediaMs }` to `window.__playbackTrace` (the e2e timing check). ui/use-playback.ts
// calls it only inside `import.meta.env.DEV`, so production builds tree-shake this module.

/** One entry of the cursor trace. */
export interface PlaybackTraceEntry {
  noteId: string;
  /** The media clock when the cursor moved to the note, ms. */
  mediaMs: number;
}

declare global {
  interface Window {
    /** Dev builds only (absent from dist): every cursor change while playing. */
    __playbackTrace?: PlaybackTraceEntry[];
  }
}

/** Appends one cursor change to the trace. */
export function tracePlayback(noteId: string, mediaMs: number): void {
  (window.__playbackTrace ??= []).push({ noteId, mediaMs });
}
