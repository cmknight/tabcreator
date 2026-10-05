import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note, Take } from '../../src/model/types';
import { usePlayback, type UsePlaybackOptions } from '../../src/ui/use-playback';

// Story "Playback with a following cursor": the playback hook with a fake <audio> element, fake
// object URLs and fake animation frames.

/** A fake <audio>: a settable media clock; play/pause fire their events as a browser does. */
class FakeAudio extends EventTarget {
  currentTime = 0;
  paused = true;
  ended = false;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  preservesPitch = false;
  webkitPreservesPitch = false;
  src: string | null = null;
  /** Set to make play() reject as a browser does for an unplayable source. */
  unsupported = false;
  play = vi.fn(() => {
    if (this.unsupported) {
      const err = new Error('no supported source');
      err.name = 'NotSupportedError';
      return Promise.reject(err);
    }
    if (this.paused) {
      this.paused = false;
      this.ended = false;
      this.dispatchEvent(new Event('play'));
    }
    return Promise.resolve();
  });
  pause = vi.fn(() => {
    if (!this.paused) {
      this.paused = true;
      this.dispatchEvent(new Event('pause'));
    }
  });
  setAttribute(name: string, value: string) {
    if (name === 'src') this.src = value;
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = null;
  }
  /** The media reached its end: paused, `pause` then `ended`. */
  end() {
    this.paused = true;
    this.ended = true;
    this.dispatchEvent(new Event('pause'));
    this.dispatchEvent(new Event('ended'));
  }
}

/** Fake animation frames: queued until `flush`. */
function fakeFrames() {
  let next = 1;
  const queue = new Map<number, () => void>();
  return {
    request: vi.fn((cb: () => void) => {
      queue.set(next, cb);
      return next++;
    }),
    cancel: vi.fn((h: number) => void queue.delete(h)),
    /** Runs the queued frames (not the ones they request). */
    flush() {
      const due = [...queue.values()];
      queue.clear();
      act(() => due.forEach((cb) => cb()));
    },
    get pending() {
      return queue.size;
    },
  };
}

const TAKE: Pick<Take, 'audioMime' | 'trimStartMs' | 'trimEndMs' | 'durationMs'> = {
  audioMime: 'audio/webm;codecs=opus',
  trimStartMs: 0,
  trimEndMs: null,
  durationMs: 4_000,
};

const note = (id: string, startMs: number): Note => ({
  id,
  startMs,
  endMs: startMs + 200,
  midi: 60,
  confidence: 0.9,
  string: 2,
  fret: 1,
  locked: false,
  lowConfidence: false,
});

/** Stored out of played order: the hook sorts by start. */
const NOTES = [note('b', 1500), note('a', 1000), note('c', 2000)];

function setup(over: Partial<UsePlaybackOptions> = {}, blob: Blob | null = new Blob(['x'])) {
  const audio = new FakeAudio();
  const frames = fakeFrames();
  const urls = { create: vi.fn(() => 'blob:take'), revoke: vi.fn() };
  const readAudio = vi.fn(() => Promise.resolve(blob));
  const options: UsePlaybackOptions = {
    takeId: 't1',
    take: TAKE,
    notes: NOTES,
    readAudio,
    urls,
    frames,
    ...over,
  };
  const hook = renderHook((props: UsePlaybackOptions) => usePlayback(props), {
    initialProps: options,
  });
  const attach = async () => {
    await act(async () => {
      hook.result.current.attachAudio(audio as unknown as HTMLAudioElement);
    });
  };
  /** Sets the media clock (seconds) and runs the pending frames. */
  const at = (seconds: number) => {
    audio.currentTime = seconds;
    frames.flush();
  };
  return { audio, frames, urls, readAudio, hook, attach, at, options };
}

beforeEach(() => {
  window.__playbackTrace = undefined;
});

afterEach(() => {
  cleanup();
  window.__playbackTrace = undefined;
});

describe('usePlayback: audio', () => {
  it('loads the take audio into the element from an object URL; revokes it when the element goes', async () => {
    const { audio, urls, readAudio, hook, attach } = setup();
    expect(hook.result.current.status).toBe('loading');
    await attach();
    expect(readAudio).toHaveBeenCalledWith('t1');
    expect(urls.create).toHaveBeenCalledTimes(1);
    expect(audio.src).toBe('blob:take');
    expect(hook.result.current.status).toBe('ready');
    expect(hook.result.current.controller.available()).toBe(true);
    act(() => hook.result.current.attachAudio(null));
    expect(urls.revoke).toHaveBeenCalledWith('blob:take');
    expect(audio.src).toBeNull();
    expect(hook.result.current.controller.available()).toBe(false);
  });

  it('revokes the URL on unmount and pauses', async () => {
    const { audio, urls, hook, attach } = setup();
    await attach();
    act(() => hook.result.current.toggle());
    expect(audio.paused).toBe(false);
    hook.unmount();
    expect(urls.revoke).toHaveBeenCalledWith('blob:take');
    expect(audio.paused).toBe(true);
  });

  it('audioMime null: "none" without reading; Play does nothing', async () => {
    const { audio, readAudio, hook, attach } = setup({ take: { ...TAKE, audioMime: null } });
    expect(hook.result.current.status).toBe('none');
    await attach();
    expect(readAudio).not.toHaveBeenCalled();
    expect(hook.result.current.status).toBe('none');
    act(() => hook.result.current.toggle());
    expect(audio.play).not.toHaveBeenCalled();
    expect(hook.result.current.controller.available()).toBe(false);
  });

  it('no compressed file, or a failed read: "none"', async () => {
    const missing = setup({}, null);
    await missing.attach();
    expect(missing.hook.result.current.status).toBe('none');
    expect(missing.urls.create).not.toHaveBeenCalled();
    cleanup();
    const failing = setup({ readAudio: vi.fn(() => Promise.reject(new Error('read'))) });
    await failing.attach();
    expect(failing.hook.result.current.status).toBe('none');
  });

  it('speed: playbackRate (and the default rate) with pitch preserved, webkit fallback too', async () => {
    const { audio, hook, attach } = setup();
    await attach();
    expect(hook.result.current.speed).toBe(1);
    expect(audio.playbackRate).toBe(1);
    expect(audio.preservesPitch).toBe(true);
    expect(audio.webkitPreservesPitch).toBe(true);
    act(() => hook.result.current.setSpeed(0.75));
    expect(audio.playbackRate).toBe(0.75);
    expect(audio.defaultPlaybackRate).toBe(0.75);
    expect(audio.preservesPitch).toBe(true);
    act(() => hook.result.current.setSpeed(0.5));
    expect(audio.playbackRate).toBe(0.5);
  });
});

describe('usePlayback: play, trim and end', () => {
  it('Play / Pause; the playing state follows the element', async () => {
    const { audio, hook, attach } = setup();
    await attach();
    act(() => hook.result.current.toggle());
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(hook.result.current.playing).toBe(true);
    act(() => hook.result.current.toggle());
    expect(audio.pause).toHaveBeenCalled();
    expect(hook.result.current.playing).toBe(false);
  });

  it('starts at the trim start when the playhead is before it, and resumes where it paused', async () => {
    const { audio, hook, attach, at } = setup({ take: { ...TAKE, trimStartMs: 1000 } });
    await attach();
    act(() => hook.result.current.toggle());
    expect(audio.currentTime).toBe(1);
    at(1.4);
    act(() => hook.result.current.toggle());
    act(() => hook.result.current.toggle());
    expect(audio.currentTime).toBe(1.4);
  });

  it('pauses at the trim end and clears the cursor; Play then restarts from the trim start', async () => {
    const { audio, hook, attach, at } = setup({
      take: { ...TAKE, trimStartMs: 500, trimEndMs: 1800 },
    });
    await attach();
    act(() => hook.result.current.toggle());
    at(1.6);
    expect(hook.result.current.playingNoteId).toBe('b');
    at(1.85);
    expect(audio.paused).toBe(true);
    expect(audio.currentTime).toBe(1.8);
    expect(hook.result.current.playing).toBe(false);
    expect(hook.result.current.playingNoteId).toBeNull();
    act(() => hook.result.current.toggle());
    expect(audio.currentTime).toBe(0.5);
    expect(audio.paused).toBe(false);
  });

  it('the trim end is also caught on timeupdate (no frames in a background tab)', async () => {
    const { audio, hook, attach } = setup({ take: { ...TAKE, trimEndMs: 3000 } });
    await attach();
    act(() => hook.result.current.toggle());
    audio.currentTime = 3.1;
    act(() => void audio.dispatchEvent(new Event('timeupdate')));
    expect(audio.paused).toBe(true);
    expect(audio.currentTime).toBe(3);
  });

  it('the media end: paused, cursor cleared; Play restarts from the trim start', async () => {
    const { audio, hook, attach, at } = setup({ take: { ...TAKE, trimStartMs: 200 } });
    await attach();
    act(() => hook.result.current.toggle());
    at(2.5);
    expect(hook.result.current.playingNoteId).toBe('c');
    audio.currentTime = 4;
    act(() => audio.end());
    expect(hook.result.current.playing).toBe(false);
    expect(hook.result.current.playingNoteId).toBeNull();
    act(() => hook.result.current.toggle());
    expect(audio.currentTime).toBe(0.2);
    expect(audio.paused).toBe(false);
  });

  it('the time display: whole seconds of the playhead, and the take duration', async () => {
    const { hook, attach, at } = setup();
    await attach();
    expect(hook.result.current.durationMs).toBe(4000);
    act(() => hook.result.current.toggle());
    at(1.75);
    expect(hook.result.current.currentMs).toBe(1000);
    at(2.01);
    expect(hook.result.current.currentMs).toBe(2000);
  });
});

describe('usePlayback: the cursor', () => {
  it('outlines the last note started at or before the media clock, by id, in played order', async () => {
    const { hook, attach, at, frames } = setup();
    await attach();
    act(() => hook.result.current.toggle());
    expect(frames.pending).toBe(1);
    at(0.5);
    expect(hook.result.current.playingNoteId).toBeNull();
    at(1.0);
    expect(hook.result.current.playingNoteId).toBe('a');
    at(1.49);
    expect(hook.result.current.playingNoteId).toBe('a');
    at(1.5);
    expect(hook.result.current.playingNoteId).toBe('b');
    at(2.3);
    expect(hook.result.current.playingNoteId).toBe('c');
  });

  it('a mid-take pause keeps the cursor and stops the loop', async () => {
    const { hook, attach, at, frames } = setup();
    await attach();
    act(() => hook.result.current.toggle());
    at(1.6);
    act(() => hook.result.current.toggle());
    expect(hook.result.current.playingNoteId).toBe('b');
    expect(frames.pending).toBe(0);
  });

  it('DEV: each cursor change to a note appends { noteId, mediaMs } to the trace', async () => {
    const { hook, attach, at } = setup();
    await attach();
    act(() => hook.result.current.toggle());
    at(0.2);
    at(1.01);
    at(1.2);
    at(1.52);
    expect(window.__playbackTrace).toEqual([
      { noteId: 'a', mediaMs: 1010 },
      { noteId: 'b', mediaMs: 1520 },
    ]);
  });

  it('notes re-analysed while playing: the cursor follows the new notes', async () => {
    const { hook, attach, at, options } = setup();
    await attach();
    act(() => hook.result.current.toggle());
    at(1.6);
    expect(hook.result.current.playingNoteId).toBe('b');
    hook.rerender({ ...options, notes: [note('x', 1550)] });
    at(1.7);
    expect(hook.result.current.playingNoteId).toBe('x');
  });
});

describe('usePlayback: seek', () => {
  it('seekToNote: 100 ms before the note, never before the trim start; plays only when asked', async () => {
    const { audio, hook, attach } = setup({ take: { ...TAKE, trimStartMs: 1450 } });
    await attach();
    act(() => hook.result.current.seekToNote('c', false));
    expect(audio.currentTime).toBeCloseTo(1.9);
    expect(audio.play).not.toHaveBeenCalled();
    act(() => hook.result.current.seekToNote('b', true));
    expect(audio.currentTime).toBeCloseTo(1.45);
    expect(audio.play).toHaveBeenCalledTimes(1);
    // Already playing: seeks without another play.
    act(() => hook.result.current.seekToNote('c', true));
    expect(audio.currentTime).toBeCloseTo(1.9);
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it('the controller: playFromNote seeks and plays; an unknown note does nothing', async () => {
    const { audio, hook, attach } = setup();
    await attach();
    act(() => hook.result.current.controller.playFromNote('a'));
    expect(audio.currentTime).toBeCloseTo(0.9);
    expect(audio.paused).toBe(false);
    act(() => hook.result.current.controller.toggle());
    expect(audio.paused).toBe(true);
    act(() => hook.result.current.controller.playFromNote('zz'));
    expect(audio.currentTime).toBeCloseTo(0.9);
    expect(audio.paused).toBe(true);
  });
});

describe('usePlayback: review fixes', () => {
  it('an element error: status "error", Play and the controller do nothing', async () => {
    const { audio, hook, attach } = setup();
    await attach();
    act(() => void audio.dispatchEvent(new Event('error')));
    expect(hook.result.current.status).toBe('error');
    expect(hook.result.current.controller.available()).toBe(false);
    act(() => hook.result.current.toggle());
    act(() => hook.result.current.controller.playFromNote('a'));
    expect(audio.play).not.toHaveBeenCalled();
  });

  it('a play() rejected as NotSupportedError: status "error"', async () => {
    const { audio, hook, attach } = setup();
    await attach();
    audio.unsupported = true;
    await act(async () => hook.result.current.toggle());
    expect(hook.result.current.status).toBe('error');
  });

  it('another play() rejection (an interrupted play) keeps it ready', async () => {
    const { audio, hook, attach } = setup();
    await attach();
    audio.play.mockImplementationOnce(() => Promise.reject(new DOMException('x', 'AbortError')));
    await act(async () => hook.result.current.toggle());
    expect(hook.result.current.status).toBe('ready');
  });

  it('seeks to notes outside the trim range are ignored', async () => {
    const { audio, hook, attach } = setup({
      take: { ...TAKE, trimStartMs: 1200, trimEndMs: 2000 },
    });
    await attach();
    audio.currentTime = 1.3;
    act(() => hook.result.current.seekToNote('a', true)); // 1000: before the trim start
    act(() => hook.result.current.seekToNote('c', true)); // 2000: at the trim end
    expect(audio.currentTime).toBe(1.3);
    expect(audio.play).not.toHaveBeenCalled();
    act(() => hook.result.current.seekToNote('b', false)); // 1500: inside
    expect(audio.currentTime).toBeCloseTo(1.4);
  });

  it('a new element starts its time display at 0:00', async () => {
    const { hook, attach, at } = setup();
    await attach();
    act(() => hook.result.current.toggle());
    at(2.5);
    expect(hook.result.current.currentMs).toBe(2000);
    const next = new FakeAudio();
    await act(async () => {
      hook.result.current.attachAudio(next as unknown as HTMLAudioElement);
    });
    expect(hook.result.current.currentMs).toBe(0);
    expect(hook.result.current.playingNoteId).toBeNull();
  });

  it('DEV trace: written after the outline is committed, with the media clock read then', async () => {
    const { audio, hook, attach, frames } = setup();
    await attach();
    act(() => hook.result.current.toggle());
    audio.currentTime = 1.02;
    // The frame reads 1.02 s; by the commit the clock has moved on to 1.03 s.
    const tickRead = Object.getOwnPropertyDescriptor(audio, 'currentTime')!;
    let reads = 0;
    Object.defineProperty(audio, 'currentTime', {
      configurable: true,
      get: () => (reads++ === 0 ? 1.02 : 1.03),
      set: () => {},
    });
    frames.flush();
    Object.defineProperty(audio, 'currentTime', tickRead);
    expect(hook.result.current.playingNoteId).toBe('a');
    expect(window.__playbackTrace).toEqual([{ noteId: 'a', mediaMs: 1030 }]);
  });
});
