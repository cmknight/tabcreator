// Playback on the Tab screen (story "Playback with a following cursor", US-6.5; EXPERIENCE.md
// Playback). The playback state itself lives in the UI (`ui/use-playback.ts`, which holds the
// `<audio>` element) and is never stored. This module gives the UI the take's compressed audio
// (ui/ may not import storage/) and holds the mounted screen's playback controller for the
// shortcut registry (Space and `P`), a sibling of take-session's active-session slot.

import { audioStore } from '../storage/audio-store';

/** What the shortcuts drive on the mounted Tab screen. */
export interface PlaybackController {
  /** Whether Play applies: the take's audio is loaded (false while loading or when deleted). */
  available(): boolean;
  /** Play / Pause (Space). */
  toggle(): void;
  /** Seeks to 100 ms before the note (never before the trim start) and plays if paused (`P`). */
  playFromNote(noteId: string): void;
}

/** The take's compressed audio, or null when it has none (deleted, or never written). */
export function readTakeAudio(takeId: string): Promise<Blob | null> {
  return audioStore.readCompressed(takeId);
}

/** The playback controller of the mounted Tab screen, for the shortcut registry (null: none). */
let activeController: PlaybackController | null = null;

/**
 * Registers the mounted Tab screen's playback controller (null: none). The screen sets it while
 * its playback group is shown and clears it on unmount.
 */
export function setActivePlayback(controller: PlaybackController | null): void {
  activeController = controller;
}

/** The mounted Tab screen's playback controller, or null. */
export function activePlayback(): PlaybackController | null {
  return activeController;
}
