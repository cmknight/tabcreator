import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Take } from '../../src/model/types';
import type { Peaks } from '../../src/session/waveform';
import { announce } from '../../src/ui/a11y/announcer';
import {
  RESIZE_DEBOUNCE_MS,
  TRIM_ANNOUNCE_MS,
  TrimStrip,
  type TrimStripProps,
} from '../../src/ui/components/TrimStrip';
import { strings } from '../../src/ui/strings';
import { deferred } from './helpers';

vi.mock('../../src/ui/a11y/announcer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ui/a11y/announcer')>()),
  announce: vi.fn(),
}));

// Story "Trim": the Trim strip — the handles, their keys, limits and announcements, the
// waveform's loading state, Save / Reset trim, the Confirm dialog, Esc and the run's progress.

const TAKE: Take = {
  id: 't1',
  title: 'Take 3',
  createdAt: '2026-10-04T10:00:00.000Z',
  status: 'analyzed',
  durationMs: 4_000,
  sampleRate: 48_000,
  tuning: 'EADGBE',
  micLabel: 'Mic',
  audioMime: 'audio/webm;codecs=opus',
  trimStartMs: 0,
  trimEndMs: null,
  settings: { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 },
  analysisVersion: '0.4.0',
  updatedAt: '2026-10-04T10:00:04.000Z',
};

const PEAKS: Peaks = { min: new Float32Array(600), max: new Float32Array(600) };

function setup(over: Partial<TrimStripProps> = {}) {
  const peaks = deferred<Peaks>();
  const props: TrimStripProps = {
    take: TAKE,
    lockedShown: false,
    running: null,
    onSave: vi.fn(),
    onReset: vi.fn(),
    onCancel: vi.fn(),
    onEscape: vi.fn(),
    loadPeaks: vi.fn(() => peaks.promise),
    releasePeaks: vi.fn(),
    ...over,
  };
  const view = render(<TrimStrip {...props} />);
  return {
    props,
    peaks,
    rerender: (next: Partial<TrimStripProps>) => view.rerender(<TrimStrip {...props} {...next} />),
  };
}

const handle = (name: 'Trim start' | 'Trim end') => screen.getByRole('slider', { name });
const key = (el: HTMLElement, k: string, shiftKey = false) =>
  fireEvent.keyDown(el, { key: k, shiftKey });
const save = () =>
  screen.getByRole('button', { name: strings['tab.trimSave'] }) as HTMLButtonElement;
const reset = () =>
  screen.getByRole('button', { name: strings['tab.trimReset'] }) as HTMLButtonElement;

/** The waveform's drawn columns: x and the opacity each was filled at. */
let drawn: { x: number; alpha: number }[] = [];

beforeEach(() => {
  drawn = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: '',
    setTransform: vi.fn(),
    fillRect(x: number, _y: number, w: number) {
      if (w === 1) drawn.push({ x, alpha: ctx.globalAlpha });
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ctx as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('TrimStrip', () => {
  it('an inline "Trim" section with two sliders in ms over the saved trim', () => {
    setup({ take: { ...TAKE, trimStartMs: 1000, trimEndMs: 3000 } });
    expect(screen.getByRole('region', { name: 'Trim' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    const start = handle('Trim start');
    expect(start.getAttribute('aria-valuenow')).toBe('1000');
    expect(start.getAttribute('aria-valuemin')).toBe('0');
    expect(start.getAttribute('aria-valuemax')).toBe('2500');
    expect(start.getAttribute('aria-valuetext')).toBe('0:01.00');
    const end = handle('Trim end');
    expect(end.getAttribute('aria-valuenow')).toBe('3000');
    expect(end.getAttribute('aria-valuemin')).toBe('1500');
    expect(end.getAttribute('aria-valuemax')).toBe('4000');
    expect(end.getAttribute('aria-valuetext')).toBe('0:03.00');
  });

  it('"Loading waveform…" until the peaks arrive; the handles work meanwhile', async () => {
    const { peaks, props } = setup();
    expect(screen.getByTestId('trim-loading').textContent).toBe(strings['tab.trimLoading']);
    expect(props.loadPeaks).toHaveBeenCalledWith(TAKE, 600);
    key(handle('Trim start'), 'ArrowRight');
    expect(handle('Trim start').getAttribute('aria-valuenow')).toBe('10');
    await act(async () => peaks.resolve(PEAKS));
    expect(screen.queryByTestId('trim-loading')).toBeNull();
    expect((screen.getByTestId('trim-waveform') as HTMLCanvasElement).hidden).toBe(false);
    // One column per pixel; those outside the handles (start now at 10 ms) dimmed to 30%.
    expect(drawn).toHaveLength(600);
    expect(drawn[0]).toEqual({ x: 0, alpha: 0.3 });
    expect(drawn[300]).toEqual({ x: 300, alpha: 1 });
  });

  it('a failed waveform says so; the handles still work', async () => {
    const { peaks } = setup();
    await act(async () => peaks.reject(new Error('no audio')));
    expect(screen.getByTestId('trim-loading').textContent).toBe(strings['tab.trimWaveformFailed']);
  });

  it('keys: → ×3 and Shift+→ make 130 ms, "0:00.13", announced once 300 ms after the last', () => {
    vi.useFakeTimers();
    setup();
    const start = handle('Trim start');
    for (let i = 0; i < 3; i++) key(start, 'ArrowRight');
    act(() => vi.advanceTimersByTime(TRIM_ANNOUNCE_MS - 10));
    key(start, 'ArrowRight', true);
    expect(start.getAttribute('aria-valuenow')).toBe('130');
    expect(start.getAttribute('aria-valuetext')).toBe('0:00.13');
    expect(announce).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(TRIM_ANNOUNCE_MS));
    expect(vi.mocked(announce).mock.calls).toEqual([['Trim start 0:00.13']]);
    key(start, 'ArrowLeft', true);
    expect(start.getAttribute('aria-valuenow')).toBe('30');
  });

  it('limits: start stops at end − 500, end at start + 500; Home and End go to them', () => {
    setup();
    const start = handle('Trim start');
    const end = handle('Trim end');
    key(start, 'End');
    expect(start.getAttribute('aria-valuenow')).toBe('3500');
    key(start, 'ArrowRight', true);
    expect(start.getAttribute('aria-valuenow')).toBe('3500');
    expect(end.getAttribute('aria-valuemin')).toBe('4000');
    key(start, 'Home');
    expect(start.getAttribute('aria-valuenow')).toBe('0');
    key(start, 'ArrowLeft');
    expect(start.getAttribute('aria-valuenow')).toBe('0');
    key(end, 'Home');
    expect(end.getAttribute('aria-valuenow')).toBe('500');
    key(end, 'End');
    expect(end.getAttribute('aria-valuenow')).toBe('4000');
  });

  it('a drag moves the handle with the pointer, within its limits', () => {
    setup();
    const start = handle('Trim start');
    const track = start.parentElement!;
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      width: 400,
      top: 0,
      height: 64,
      right: 500,
      bottom: 64,
      x: 100,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(start, { button: 0, pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(start, { pointerId: 1, clientX: 300 }); // halfway: 2000 ms
    expect(start.getAttribute('aria-valuenow')).toBe('2000');
    fireEvent.pointerMove(start, { pointerId: 1, clientX: 500 }); // the end: stops at 3500
    expect(start.getAttribute('aria-valuenow')).toBe('3500');
    fireEvent.pointerUp(start, { pointerId: 1 });
    fireEvent.pointerMove(start, { pointerId: 1, clientX: 100 }); // released: no move
    expect(start.getAttribute('aria-valuenow')).toBe('3500');
  });

  it('Save is primary and disabled until a handle moves; it saves the drafts', () => {
    const { props } = setup();
    expect(save().className).toContain('primary');
    expect(save().disabled).toBe(true);
    key(handle('Trim start'), 'ArrowRight', true);
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    expect(props.onSave).toHaveBeenCalledWith(100, 4000);
  });

  it('Reset trim is disabled on the full take, enabled on a trimmed one', () => {
    const { props, rerender } = setup();
    expect(reset().disabled).toBe(true);
    rerender({ take: { ...TAKE, trimStartMs: 2000 } });
    expect(reset().disabled).toBe(false);
    fireEvent.click(reset());
    expect(props.onReset).toHaveBeenCalledTimes(1);
  });

  it('a shown locked note: Save asks first; Cancel runs nothing; "Trim and re-analyse" saves', () => {
    const { props } = setup({ lockedShown: true });
    key(handle('Trim start'), 'ArrowRight', true);
    fireEvent.click(save());
    const dialog = screen.getByRole('alertdialog', { name: 'Re-analyse Take 3?' });
    expect(dialog.textContent).toContain(strings['tab.reanalyseConfirmBody']);
    fireEvent.click(screen.getByRole('button', { name: strings['global.cancel'] }));
    expect(props.onSave).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(save());
    fireEvent.click(screen.getByRole('button', { name: strings['tab.trimConfirm'] }));
    expect(props.onSave).toHaveBeenCalledWith(100, 4000);
  });

  it('Esc closes without saving; the handles go back to the saved trim', () => {
    const { props } = setup();
    key(handle('Trim start'), 'ArrowRight', true);
    key(handle('Trim start'), 'Escape');
    expect(props.onEscape).toHaveBeenCalledTimes(1);
    expect(props.onSave).not.toHaveBeenCalled();
    expect(handle('Trim start').getAttribute('aria-valuenow')).toBe('0');
  });

  it('the saved trim changing (a Save, an undo) moves the handles to it', () => {
    const { rerender } = setup();
    key(handle('Trim start'), 'ArrowRight', true);
    rerender({ take: { ...TAKE, trimStartMs: 2000, trimEndMs: 3000 } });
    expect(handle('Trim start').getAttribute('aria-valuenow')).toBe('2000');
    expect(handle('Trim end').getAttribute('aria-valuenow')).toBe('3000');
    expect(save().disabled).toBe(true);
  });

  it('while its run goes: progress and Cancel; Save and Reset disabled; Esc does nothing', () => {
    const { props, rerender } = setup({ take: { ...TAKE, trimStartMs: 1000 } });
    key(handle('Trim start'), 'ArrowRight', true);
    rerender({ running: { progress: 0.45 } });
    const bar = screen.getByRole('progressbar', { name: strings['tab.analysing'] });
    expect((bar as HTMLProgressElement).value).toBeCloseTo(0.45);
    expect(screen.getByTestId('trim-progress').textContent).toContain('45%');
    expect(save().disabled).toBe(true);
    expect(reset().disabled).toBe(true);
    key(handle('Trim start'), 'Escape');
    expect(props.onEscape).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: strings['tab.cancel'] }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it('the canvas backing store is scaled by devicePixelRatio', async () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const { peaks } = setup();
    await act(async () => peaks.resolve(PEAKS));
    const canvas = screen.getByTestId('trim-waveform') as HTMLCanvasElement;
    expect([canvas.width, canvas.height]).toEqual([1200, 128]);
    vi.unstubAllGlobals();
  });

  it('a drag keeps the pointer’s offset from the handle: grabbing it does not move it', () => {
    setup();
    const end = handle('Trim end');
    vi.spyOn(end.parentElement!, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      width: 400,
      top: 0,
      height: 64,
      right: 400,
      bottom: 64,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    // The end handle's bar sits 8 px left of its time (4000 ms at x 400): grabbed at x 396.
    fireEvent.pointerDown(end, { button: 0, pointerId: 1, clientX: 396 });
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 396 });
    expect(end.getAttribute('aria-valuenow')).toBe('4000');
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 296 }); // 100 px left: 1000 ms earlier
    expect(end.getAttribute('aria-valuenow')).toBe('3000');
  });

  it('the handles consume their keys: no shortcut listener above sees them', () => {
    setup();
    const seen: string[] = [];
    const listener = (event: KeyboardEvent) => seen.push(event.key);
    window.addEventListener('keydown', listener);
    try {
      key(handle('Trim start'), 'ArrowRight');
      key(handle('Trim start'), 'End');
      key(handle('Trim start'), '5'); // not a handle key: left to the page
    } finally {
      window.removeEventListener('keydown', listener);
    }
    expect(seen).toEqual(['5']);
  });

  it('a shown locked note: Reset trim asks the same Confirm first', () => {
    const { props } = setup({ take: { ...TAKE, trimStartMs: 2000 }, lockedShown: true });
    fireEvent.click(reset());
    expect(screen.getByRole('alertdialog', { name: 'Re-analyse Take 3?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: strings['global.cancel'] }));
    expect(props.onReset).not.toHaveBeenCalled();
    fireEvent.click(reset());
    fireEvent.click(screen.getByRole('button', { name: strings['tab.trimConfirm'] }));
    expect(props.onReset).toHaveBeenCalledTimes(1);
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it('a resize reloads the peaks once the width settles (150 ms); the take is released on unmount', () => {
    vi.useFakeTimers();
    let resize: (() => void) | null = null;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          resize = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(500);
    const { props } = setup();
    expect(props.loadPeaks).toHaveBeenLastCalledWith(TAKE, 500);
    width.mockReturnValue(450);
    act(() => resize!());
    width.mockReturnValue(420);
    act(() => resize!());
    act(() => vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS - 1));
    expect(props.loadPeaks).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));
    expect(props.loadPeaks).toHaveBeenCalledTimes(2);
    expect(props.loadPeaks).toHaveBeenLastCalledWith(TAKE, 420);
    cleanup();
    expect(props.releasePeaks).toHaveBeenCalledWith('t1');
    vi.unstubAllGlobals();
  });
});
