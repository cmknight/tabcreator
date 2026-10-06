// The Trim strip (story "Trim"; DESIGN.md Trim strip; EXPERIENCE.md Trim strip): an inline
// section below the Tab toolbar, not a dialog. A full-width 64 px waveform of the take (its
// per-column min/max peaks from `session/waveform.ts`, "Loading waveform…" until they arrive)
// with two handles, Trim start and Trim end: `role="slider"` bars in ms, moved by dragging
// (pointer events) or by ← / → (10 ms), Shift+← / → (100 ms), Home and End, and kept at least
// 500 ms apart. A moved handle announces its time politely once it settles (300 ms). Columns
// outside the handles are dimmed to 30%.
//
// Save (the screen's primary while the strip is open) saves the range and re-analyses it, after
// the Confirm dialog when a shown note is locked; it is disabled until a handle differs from
// the saved trim. Reset trim re-analyses the full take, after the same Confirm; disabled when
// the trim is already the full take. While the run goes, the strip shows "Analysing…", the bar and Cancel. Esc inside
// the strip closes it without saving (the handles go back to the saved trim).
//
// The handles consume their own keys (the Tab screen's shortcuts skip the strip too). The
// waveform's column count follows the strip's width, debounced; the take's peaks are released
// when the strip goes. The canvas backing store is scaled by `devicePixelRatio`. A drag keeps
// the pointer's offset from the handle's time, so the handle never jumps when grabbed.

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import {
  clampMs,
  endLimits,
  shownEnd,
  startLimits,
  TRIM_BIG_STEP_MS,
  TRIM_STEP_MS,
  isFullTake,
} from '../../model/trim';
import type { Take } from '../../model/types';
import {
  loadPeaks as sessionLoadPeaks,
  releasePeaks as sessionReleasePeaks,
  type Peaks,
} from '../../session/waveform';
import { announce } from '../a11y/announcer';
import { formatTrimTime } from '../format';
import { strings } from '../strings';
import buttons from './buttons.module.css';
import { ConfirmDialog } from './ConfirmDialog';
import styles from './TrimStrip.module.css';

/** How long after a handle's last move its time is announced. */
export const TRIM_ANNOUNCE_MS = 300;
/** The waveform's height, CSS px (DESIGN.md Trim strip). */
const WAVE_HEIGHT = 64;
/** The column count when the strip's width cannot be measured (jsdom). */
const FALLBACK_COLUMNS = 600;
/** The dimmed columns' opacity, outside the handles. */
const DIMMED = 0.3;
/** How long the strip's width must settle before the waveform is reloaded for it. */
export const RESIZE_DEBOUNCE_MS = 150;

type Handle = 'start' | 'end';

export interface TrimStripProps {
  take: Take;
  /** Whether a shown note is locked: Save asks first in the Confirm dialog. */
  lockedShown: boolean;
  /** The trim run in flight (its progress), or null. */
  running: { progress: number } | null;
  onSave(startMs: number, endMs: number): void;
  onReset(): void;
  onCancel(): void;
  /** Esc inside the strip (not while a run goes): close it. */
  onEscape(): void;
  /** The take's waveform peaks (default `session/waveform.ts`'s; tests pass their own). */
  loadPeaks?: (take: Take, columns: number) => Promise<Peaks>;
  /** Drops the take's peaks when the strip goes (default `session/waveform.ts`'s). */
  releasePeaks?: (takeId: string) => void;
}

/** The whole percentage shown for a progress fraction (the epsilon absorbs float error). */
function percentOf(progress: number): number {
  return Math.floor(progress * 100 + 1e-9);
}

/** Draws `peaks` on `canvas`, the columns outside `from`..`to` (fractions) dimmed. */
function draw(canvas: HTMLCanvasElement, peaks: Peaks, from: number, to: number) {
  let ctx: CanvasRenderingContext2D | null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    ctx = null; // no canvas (jsdom)
  }
  if (!ctx) return;
  const columns = peaks.min.length;
  // The backing store at device pixels; drawing stays in CSS pixels (one column each).
  const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
  // Resized only when the size changes: a handle move redraws without reallocating.
  const width = Math.round(columns * dpr);
  const height = Math.round(WAVE_HEIGHT * dpr);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const style = getComputedStyle(canvas);
  const surface = style.getPropertyValue('--color-surface').trim() || '#fff';
  const ink = style.getPropertyValue('--color-text-muted').trim() || '#5e5a54';
  ctx.globalAlpha = 1;
  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, columns, WAVE_HEIGHT);
  ctx.fillStyle = ink;
  const mid = WAVE_HEIGHT / 2;
  for (let x = 0; x < columns; x++) {
    const at = (x + 0.5) / columns;
    ctx.globalAlpha = at < from || at > to ? DIMMED : 1;
    const top = mid - Math.max(0, peaks.max[x]!) * mid;
    const bottom = mid - Math.min(0, peaks.min[x]!) * mid;
    ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
  }
  ctx.globalAlpha = 1;
}

export function TrimStrip({
  take,
  lockedShown,
  running,
  onSave,
  onReset,
  onCancel,
  onEscape,
  loadPeaks = sessionLoadPeaks,
  releasePeaks = sessionReleasePeaks,
}: TrimStripProps) {
  const headingId = useId();
  const duration = Math.max(0, take.durationMs);
  const savedStart = take.trimStartMs;
  const savedEnd = shownEnd(take, duration);

  // The handles' drafts, back to the saved trim whenever it changes (a Save, Reset or undo).
  const savedKey = `${savedStart}:${savedEnd}`;
  const [draft, setDraft] = useState({ key: savedKey, start: savedStart, end: savedEnd });
  let start = draft.start;
  let end = draft.end;
  if (draft.key !== savedKey) {
    start = savedStart;
    end = savedEnd;
    setDraft({ key: savedKey, start, end });
  }
  const changed = start !== savedStart || end !== savedEnd;
  const disabled = running !== null;

  /** The command the Confirm dialog is asking about, or null. */
  const [confirming, setConfirming] = useState<'save' | 'reset' | null>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const resetButton = useRef<HTMLButtonElement>(null);
  const startHandle = useRef<HTMLDivElement>(null);
  const progressId = useId();
  const cancelButton = useRef<HTMLButtonElement>(null);

  // Focus follows the run: from Save or Reset trim (disabled) to Cancel when it starts, and back
  // to Save when it ends with focus lost (Cancel gone).
  const isRunning = running !== null;
  const wasRunning = useRef(isRunning);
  useLayoutEffect(() => {
    const before = wasRunning.current;
    wasRunning.current = isRunning;
    if (before === isRunning) return;
    const active = document.activeElement;
    const lost = active === null || active === document.body;
    const onButton = active instanceof HTMLButtonElement && active.disabled;
    if (isRunning && (lost || onButton)) cancelButton.current?.focus();
    if (!isRunning && lost) {
      // Save (or else Reset trim) when enabled; after a successful run both may be disabled,
      // so then the start handle.
      const target = [saveButton.current, resetButton.current].find((b) => b && !b.disabled);
      (target ?? startHandle.current)?.focus();
    }
  }, [isRunning]);

  // The handle's time, announced politely once it has not moved for TRIM_ANNOUNCE_MS.
  const announceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (announceTimer.current !== null) clearTimeout(announceTimer.current);
    },
    [],
  );
  const announceLater = (handle: Handle, ms: number) => {
    if (announceTimer.current !== null) clearTimeout(announceTimer.current);
    announceTimer.current = setTimeout(() => {
      announceTimer.current = null;
      const label = handle === 'start' ? strings['tab.trimStart'] : strings['tab.trimEnd'];
      announce(strings['tab.trimMoved'](label, formatTrimTime(ms)));
    }, TRIM_ANNOUNCE_MS);
  };

  const limitsOf = (handle: Handle) =>
    handle === 'start' ? startLimits(end) : endLimits(start, duration);
  const move = (handle: Handle, ms: number) => {
    const value = clampMs(ms, limitsOf(handle));
    const current = handle === 'start' ? start : end;
    if (value === current) return;
    setDraft({
      key: savedKey,
      start: handle === 'start' ? value : start,
      end: handle === 'end' ? value : end,
    });
    announceLater(handle, value);
  };

  const onHandleKey = (handle: Handle, event: KeyboardEvent<HTMLDivElement>) => {
    // While a run goes the handles are disabled; a modified key is left to the page.
    if (running !== null || event.ctrlKey || event.altKey || event.metaKey) return;
    const current = handle === 'start' ? start : end;
    const step = event.shiftKey ? TRIM_BIG_STEP_MS : TRIM_STEP_MS;
    const limits = limitsOf(handle);
    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
        next = current - step;
        break;
      case 'ArrowRight':
        next = current + step;
        break;
      case 'Home':
        next = limits.min;
        break;
      case 'End':
        next = limits.max;
        break;
      default:
        return;
    }
    // The handle consumes the key: no Tab screen shortcut runs too.
    event.preventDefault();
    event.stopPropagation();
    move(handle, next);
  };

  // Dragging: the pointer's x over the track, as ms.
  const track = useRef<HTMLDivElement>(null);
  /** The handle being dragged and the pointer's offset from its time (ms), or null. */
  const dragging = useRef<{ handle: Handle; offset: number } | null>(null);
  const msAt = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return null;
    return ((clientX - rect.left) / rect.width) * duration;
  };
  const onPointerDown = (handle: Handle, event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || running !== null) return;
    event.preventDefault();
    event.currentTarget.focus();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // No capture (jsdom): moves still arrive while the pointer stays over the handle.
    }
    const at = msAt(event.clientX);
    const value = handle === 'start' ? start : end;
    dragging.current = { handle, offset: at === null ? 0 : at - value };
  };
  const onPointerMove = (handle: Handle, event: PointerEvent<HTMLDivElement>) => {
    const drag = dragging.current;
    if (drag?.handle !== handle) return;
    // No button down (the release was missed) or a run started: the drag is over.
    if (event.buttons === 0 || running !== null) {
      dragging.current = null;
      return;
    }
    const ms = msAt(event.clientX);
    if (ms !== null) move(handle, ms - drag.offset);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    dragging.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Not captured.
    }
  };

  // The waveform: its width in columns, the peaks for it, and the drawing.
  const [columns, setColumns] = useState(0);
  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    // Without layout (no ResizeObserver: jsdom) a fixed column count; with it, a width of 0
    // (not laid out yet) waits for a measured one.
    const layout = typeof ResizeObserver !== 'undefined';
    const measure = () => {
      const width = Math.round(el.clientWidth);
      if (width > 0) setColumns(width);
      else if (!layout) setColumns(FALLBACK_COLUMNS);
    };
    measure();
    if (!layout) return;
    // A resize reloads the peaks only once the width has settled.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        measure();
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(el);
    return () => {
      if (timer !== null) clearTimeout(timer);
      observer.disconnect();
    };
  }, []);
  // The take's PCM and peaks are dropped when the strip goes.
  const release = useRef(releasePeaks);
  useLayoutEffect(() => {
    release.current = releasePeaks;
  });
  useEffect(() => {
    const takeId = take.id;
    return () => release.current(takeId);
  }, [take.id]);
  /** The latest peaks loaded for the take (kept while another width loads), or its failure. */
  const [peaks, setPeaks] = useState<{
    takeId: string;
    peaks: Peaks | null;
    failed: boolean;
  } | null>(null);
  const peaksKey = `${take.id}:${columns}`;
  const loader = useRef(loadPeaks);
  useLayoutEffect(() => {
    loader.current = loadPeaks;
  });
  useEffect(() => {
    if (columns <= 0) return;
    // A superseded request (another width, the strip gone) is ignored when it settles.
    let cancelled = false;
    loader.current(take, columns).then(
      (p) => {
        if (!cancelled) setPeaks({ takeId: take.id, peaks: p, failed: false });
      },
      () => {
        if (!cancelled)
          setPeaks((prev) => ({
            takeId: take.id,
            // A failed reload keeps the waveform already drawn.
            peaks: prev?.takeId === take.id ? prev.peaks : null,
            failed: true,
          }));
      },
    );
    return () => {
      cancelled = true;
    };
    // The take's audio never changes: its id and the width decide the peaks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peaksKey]);
  // The last peaks drawn stay until the new width's arrive: no flash on a resize.
  const shownPeaks = peaks?.takeId === take.id ? peaks : null;
  const canvas = useRef<HTMLCanvasElement>(null);
  const fromFraction = duration > 0 ? start / duration : 0;
  const toFraction = duration > 0 ? end / duration : 1;
  useEffect(() => {
    if (!canvas.current || !shownPeaks?.peaks) return;
    draw(canvas.current, shownPeaks.peaks, fromFraction, toFraction);
  }, [shownPeaks, fromFraction, toFraction]);

  const percent = strings['tab.analysingPercent'](percentOf(running?.progress ?? 0));
  const handleProps = (handle: Handle) => {
    const value = handle === 'start' ? start : end;
    const limits = limitsOf(handle);
    const pct = duration > 0 ? (value / duration) * 100 : handle === 'start' ? 0 : 100;
    return {
      value,
      limits,
      style: { insetInlineStart: `${pct}%` },
      label: handle === 'start' ? strings['tab.trimStart'] : strings['tab.trimEnd'],
    };
  };

  return (
    <section
      className={styles.strip}
      aria-labelledby={headingId}
      data-testid="trim-strip"
      data-trim-strip=""
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault(); // the Tab screen's Esc (clear the selection) does not run too
        if (running !== null) return; // its progress and Cancel stay while it runs
        setDraft({ key: savedKey, start: savedStart, end: savedEnd });
        onEscape();
      }}
    >
      <h2 id={headingId} className={styles.title}>
        {strings['tab.trim']}
      </h2>
      <div ref={track} className={styles.track}>
        <canvas
          ref={canvas}
          className={styles.wave}
          aria-hidden="true"
          data-testid="trim-waveform"
          hidden={!shownPeaks?.peaks}
        />
        {!shownPeaks?.peaks && (
          <p className={styles.waveMessage} data-testid="trim-loading">
            {shownPeaks?.failed ? strings['tab.trimWaveformFailed'] : strings['tab.trimLoading']}
          </p>
        )}
        {(['start', 'end'] as const).map((handle) => {
          const h = handleProps(handle);
          const time = formatTrimTime(h.value);
          return (
            <div
              key={handle}
              className={`${styles.handle} ${handle === 'start' ? styles.startHandle : styles.endHandle}`}
              style={h.style}
              ref={handle === 'start' ? startHandle : undefined}
              role="slider"
              tabIndex={0}
              aria-disabled={running !== null || undefined}
              aria-label={h.label}
              aria-valuemin={h.limits.min}
              aria-valuemax={h.limits.max}
              aria-valuenow={h.value}
              aria-valuetext={time}
              aria-orientation="horizontal"
              data-testid={`trim-${handle}`}
              onKeyDown={(event) => onHandleKey(handle, event)}
              onPointerDown={(event) => onPointerDown(handle, event)}
              onPointerMove={(event) => onPointerMove(handle, event)}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onLostPointerCapture={() => {
                dragging.current = null;
              }}
            >
              <span className={styles.bar} aria-hidden="true" />
              <span className={styles.time} aria-hidden="true">
                {time}
              </span>
            </div>
          );
        })}
      </div>
      <div className={styles.actions}>
        <button
          ref={saveButton}
          type="button"
          className={buttons.primary}
          disabled={!changed || disabled}
          onClick={() => {
            if (lockedShown) setConfirming('save');
            else onSave(start, end);
          }}
        >
          {strings['tab.trimSave']}
        </button>
        <button
          ref={resetButton}
          type="button"
          className={buttons.secondary}
          disabled={isFullTake(take) || disabled}
          onClick={() => {
            if (lockedShown) setConfirming('reset');
            else onReset();
          }}
        >
          {strings['tab.trimReset']}
        </button>
      </div>
      {running !== null && (
        <div className={styles.progressBlock} data-testid="trim-progress">
          <label className={styles.label} htmlFor={progressId}>
            {strings['tab.analysing']}
          </label>
          <div className={styles.progressRow}>
            <progress
              id={progressId}
              className={styles.progress}
              max={1}
              value={running.progress}
              aria-valuetext={percent}
            />
            <span className={styles.percent}>{percent}</span>
            <button
              ref={cancelButton}
              type="button"
              className={buttons.secondary}
              onClick={onCancel}
            >
              {strings['tab.cancel']}
            </button>
          </div>
        </div>
      )}
      {confirming !== null && (
        <ConfirmDialog
          title={strings['tab.reanalyseConfirmTitle'](take.title)}
          body={strings['tab.reanalyseConfirmBody']}
          confirmLabel={strings['tab.trimConfirm']}
          opener={() => (confirming === 'reset' ? resetButton.current : saveButton.current)}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const action = confirming;
            setConfirming(null);
            if (action === 'reset') onReset();
            else onSave(start, end);
          }}
        />
      )}
    </section>
  );
}
