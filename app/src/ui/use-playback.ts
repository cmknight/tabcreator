// The Tab screen's playback (story "Playback with a following cursor", US-6.5; EXPERIENCE.md
// Playback). Holds the hidden `<audio>` element (the component renders it with `attachAudio`),
// plays the take's compressed audio from an object URL, honours the trim range (never sets it),
// sets the speed with pitch preserved, and runs the following cursor. Nothing here is stored.
//
// - Audio: once the element mounts and the take has audio (`audioMime` set), `readAudio` gives
//   the compressed blob; its object URL becomes the element's `src` and is revoked when the
//   element unmounts (the tab hides, or the screen leaves). No blob, or a failed read: "none"
//   (Audio deleted), as with `audioMime` null.
// - Trim: Play starts at `trimStartMs` when the playhead is before it, and from `trimStartMs` at
//   or after the end; playback pauses at `trimEndMs` (or at the media's end when it is null).
// - Cursor: while playing, a requestAnimationFrame loop reads `audio.currentTime` and outlines
//   the last note started at or before it (`currentNoteIndex`). It is kept by note id, cleared on
//   reaching the end, and left on the last note by a mid-take pause. It never moves the
//   selection or focus. In DEV builds each change of the cursor to a note appends `{ noteId,
//   mediaMs }` to `window.__playbackTrace` (the e2e timing check); production tree-shakes it.
// - Seek: `seekToNote` jumps to 100 ms before a note (never before the trim start); a note
//   outside the trim range is ignored.
// - Unplayable audio: an `error` on the element, or a play() rejected as NotSupportedError,
//   moves to "error" (Play disabled with "Audio can't be played").
// - The DEV trace entry is written in a layout effect once the outline is committed, reading the
//   media clock there, so the e2e timing check covers the drawn outline.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { playedOrder } from '../model/notes';
import { currentNoteIndex, inTrim, seekTargetMs } from '../model/playback';
import type { Note, Take } from '../model/types';
import { readTakeAudio, type PlaybackController } from '../session/playback';

/** The speeds of the segmented control, slowest first (EXPERIENCE.md Playback). */
export const SPEEDS = [0.5, 0.75, 1] as const;
export type Speed = (typeof SPEEDS)[number];

/** One entry of the DEV-only cursor trace. */
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

/** Object URLs for a blob (tests pass fakes). */
export interface ObjectUrls {
  create(blob: Blob): string;
  revoke(url: string): void;
}

/** Animation frames (tests pass fakes). */
export interface Frames {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

const BROWSER_URLS: ObjectUrls = {
  create: (blob) => URL.createObjectURL(blob),
  revoke: (url) => URL.revokeObjectURL(url),
};

const BROWSER_FRAMES: Frames = {
  request: (callback) => requestAnimationFrame(() => callback()),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/** `none`: no audio (Audio deleted); `error`: audio the browser cannot play. */
export type PlaybackStatus = 'loading' | 'ready' | 'none' | 'error';

export interface UsePlaybackOptions {
  takeId: string;
  take: Pick<Take, 'audioMime' | 'trimStartMs' | 'trimEndMs' | 'durationMs'> | null;
  notes: readonly Note[] | null;
  readAudio?: (takeId: string) => Promise<Blob | null>;
  urls?: ObjectUrls;
  frames?: Frames;
}

export interface Playback {
  /** The callback ref for the hidden `<audio>` element. */
  attachAudio: (el: HTMLAudioElement | null) => void;
  /** `none`: the take has no audio (Audio deleted). */
  status: PlaybackStatus;
  playing: boolean;
  speed: Speed;
  setSpeed(speed: Speed): void;
  /** The playhead, whole seconds in ms (what `m:ss` shows). */
  currentMs: number;
  durationMs: number;
  /** The note the cursor outlines, or null. */
  playingNoteId: string | null;
  /** Play / Pause. */
  toggle(): void;
  /** Seeks to 100 ms before the note (never before the trim start); `play` also starts playback. */
  seekToNote(noteId: string, play: boolean): void;
  /** For the shortcut registry (`session/playback.ts`); stable for the hook's life. */
  controller: PlaybackController;
}

/** Appends to the DEV-only trace; production builds drop the call's body. */
function trace(noteId: string, mediaMs: number): void {
  if (import.meta.env.DEV) {
    (window.__playbackTrace ??= []).push({ noteId, mediaMs });
  }
}

/**
 * Starts playback. A play rejected as NotSupportedError (no playable source) calls
 * `unsupported`; other rejections (paused again before it began, autoplay) are ignored.
 */
function play(audio: HTMLAudioElement, unsupported: () => void): void {
  try {
    void audio.play()?.catch((err: unknown) => {
      if (err instanceof Error && err.name === 'NotSupportedError') unsupported();
    });
  } catch {
    // No media playback (jsdom): nothing plays.
  }
}

/** The whole seconds of `ms`, in ms: the time display changes only when its `m:ss` does. */
const wholeSeconds = (ms: number) => Math.max(0, Math.floor(ms / 1000) * 1000);

export function usePlayback({
  takeId,
  take,
  notes,
  readAudio = readTakeAudio,
  urls = BROWSER_URLS,
  frames = BROWSER_FRAMES,
}: UsePlaybackOptions): Playback {
  /** The element, as state (what the effects follow) and as a ref (what changes it). */
  const [audio, setAudio] = useState<HTMLAudioElement | null>(null);
  const elRef = useRef<HTMLAudioElement | null>(null);
  const attachAudio = useCallback((el: HTMLAudioElement | null) => {
    elRef.current = el;
    setAudio(el);
  }, []);
  /** The element whose audio was read, for which take, and whether there was any. */
  const [loaded, setLoaded] = useState<{
    audio: HTMLAudioElement;
    takeId: string;
    ok: boolean;
  } | null>(null);
  /** The element playing, if any (a new element starts paused). */
  const [playingEl, setPlayingEl] = useState<HTMLAudioElement | null>(null);
  const [speed, setSpeed] = useState<Speed>(1);
  /** The time display, for the element it was read from (a new element shows 0:00). */
  const [timeOf, setTimeOf] = useState<{ audio: HTMLAudioElement; ms: number } | null>(null);
  /** The element that failed to play its audio, if any. */
  const [failedEl, setFailedEl] = useState<HTMLAudioElement | null>(null);
  /** The cursor, for the element it was set on (a new element starts with none). */
  const [cursorOf, setCursorOf] = useState<{ audio: HTMLAudioElement; id: string | null } | null>(
    null,
  );
  const playing = audio !== null && playingEl === audio;
  const playingNoteId = audio !== null && cursorOf?.audio === audio ? cursorOf.id : null;
  const currentMs = audio !== null && timeOf?.audio === audio ? timeOf.ms : 0;

  const hasAudio = take !== null && take.audioMime !== null;
  let status: PlaybackStatus = 'loading';
  if (take && !hasAudio) status = 'none';
  else if (loaded && loaded.audio === audio && loaded.takeId === takeId) {
    status = loaded.ok ? (failedEl === audio ? 'error' : 'ready') : 'none';
  }

  const ordered = useMemo(() => playedOrder(notes ?? []), [notes]);
  const starts = useMemo(() => ordered.map((n) => n.startMs), [ordered]);
  const trimStartMs = take?.trimStartMs ?? 0;
  const trimEndMs = take?.trimEndMs ?? null;

  /** What the loop and the actions read: the latest render's values. */
  const live = useRef({ ordered, starts, trimStartMs, trimEndMs, status });
  useLayoutEffect(() => {
    live.current = { ordered, starts, trimStartMs, trimEndMs, status };
  });

  // Load the take's audio into the element; revoke its URL when the element or take goes.
  useEffect(() => {
    if (!audio || !hasAudio) return;
    let cancelled = false;
    let url: string | null = null;
    readAudio(takeId).then(
      (blob) => {
        if (cancelled) return;
        if (blob) {
          url = urls.create(blob);
          audio.setAttribute('src', url);
        }
        setLoaded({ audio, takeId, ok: blob !== null });
      },
      () => {
        if (!cancelled) setLoaded({ audio, takeId, ok: false });
      },
    );
    return () => {
      cancelled = true;
      audio.pause();
      if (url !== null) {
        audio.removeAttribute('src');
        urls.revoke(url);
      }
    };
  }, [audio, takeId, hasAudio, readAudio, urls]);

  // The speed, with pitch preserved; `defaultPlaybackRate` too, which a new `src` restores.
  useEffect(() => {
    const el = elRef.current as (HTMLAudioElement & { webkitPreservesPitch?: boolean }) | null;
    if (!el) return;
    el.defaultPlaybackRate = speed;
    el.playbackRate = speed;
    el.preservesPitch = true;
    if ('webkitPreservesPitch' in el) el.webkitPreservesPitch = true;
  }, [audio, speed, loaded]);

  // The play state, the time display and the cursor loop.
  useEffect(() => {
    if (!audio) return;
    let frame: number | null = null;
    let cursor: string | null = null;
    const moveCursor = (id: string | null) => {
      if (id === cursor) return;
      cursor = id;
      setCursorOf({ audio, id });
    };
    const showTime = (ms: number) => {
      const shown = wholeSeconds(ms);
      setTimeOf((prev) =>
        prev?.audio === audio && prev.ms === shown ? prev : { audio, ms: shown },
      );
    };
    /** Pauses at the trim end; true when the playhead is at or past it. */
    const atTrimEnd = (ms: number): boolean => {
      const end = live.current.trimEndMs;
      if (end === null || ms < end) return false;
      audio.pause();
      audio.currentTime = end / 1000;
      moveCursor(null);
      showTime(end);
      return true;
    };
    const tick = () => {
      frame = null;
      const ms = audio.currentTime * 1000;
      if (atTrimEnd(ms)) return;
      const i = currentNoteIndex(live.current.starts, ms);
      moveCursor(i >= 0 ? live.current.ordered[i]!.id : null);
      showTime(ms);
      if (!audio.paused) frame = frames.request(tick);
    };
    const stopLoop = () => {
      if (frame !== null) frames.cancel(frame);
      frame = null;
    };
    const onPlay = () => {
      setPlayingEl(audio);
      if (frame === null) frame = frames.request(tick);
    };
    const onPause = () => {
      setPlayingEl(null);
      stopLoop();
      showTime(audio.currentTime * 1000);
    };
    const onEnded = () => {
      setPlayingEl(null);
      stopLoop();
      moveCursor(null);
    };
    const onTime = () => {
      const ms = audio.currentTime * 1000;
      if (!audio.paused && atTrimEnd(ms)) return;
      showTime(ms);
    };
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('seeked', onTime);
    const onError = () => setFailedEl(audio);
    audio.addEventListener('error', onError);
    return () => {
      audio.removeEventListener('error', onError);
      stopLoop();
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('seeked', onTime);
    };
  }, [audio, frames]);

  // DEV: the trace entry for each cursor move, once the outline is committed.
  useLayoutEffect(() => {
    const el = elRef.current;
    if (playingNoteId !== null && el) trace(playingNoteId, el.currentTime * 1000);
  }, [cursorOf, playingNoteId]);

  const toggle = useCallback(() => {
    const audio = elRef.current;
    if (!audio || live.current.status !== 'ready') return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    const { trimStartMs: start, trimEndMs: end } = live.current;
    const ms = audio.currentTime * 1000;
    if (ms < start || audio.ended || (end !== null && ms >= end)) audio.currentTime = start / 1000;
    play(audio, () => setFailedEl(audio));
  }, []);

  const seekToNote = useCallback((noteId: string, andPlay: boolean) => {
    const audio = elRef.current;
    if (!audio || live.current.status !== 'ready') return;
    const note = live.current.ordered.find((n) => n.id === noteId);
    const { trimStartMs: start, trimEndMs: end } = live.current;
    if (!note || !inTrim(note.startMs, start, end)) return;
    audio.currentTime = seekTargetMs(note.startMs, start) / 1000;
    if (andPlay && audio.paused) play(audio, () => setFailedEl(audio));
  }, []);

  const controller = useMemo<PlaybackController>(
    () => ({
      available: () => elRef.current !== null && live.current.status === 'ready',
      toggle,
      playFromNote: (noteId) => seekToNote(noteId, true),
    }),
    [toggle, seekToNote],
  );

  return {
    attachAudio,
    status,
    playing,
    speed,
    setSpeed,
    currentMs,
    durationMs: take?.durationMs ?? 0,
    playingNoteId,
    toggle,
    seekToNote,
    controller,
  };
}
