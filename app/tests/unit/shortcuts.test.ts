import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPTURE_START_MARK, CAPTURE_STOP_MARK } from '../../src/model/latency-marks';
import type { RecordingSnapshot } from '../../src/session/recording-types';
import {
  cancelCountIn,
  dispatchShortcut,
  guarded,
  helpShortcut,
  installShortcuts,
  isMacPlatform,
  keyLabel,
  RECORD_KEYDOWN_MARK,
  recordToggle,
  SHORTCUTS,
  shortcutGroups,
  tabEditShortcuts,
  tabExportShortcuts,
  tabPlaybackShortcuts,
  tabSelectionShortcuts,
  type Shortcut,
} from '../../src/ui/a11y/shortcuts';
import type { TakeSnapshot } from '../../src/session/take-session';

/** A cancelable keydown dispatched on `target` (bubbling to window). */
function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function add<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.append(el);
  return el;
}

describe('the registry', () => {
  it('registers Space on Record and on the Tab screen, with descriptions', () => {
    const space = SHORTCUTS.filter((s) => s.key === ' ');
    expect(space).toHaveLength(2);
    expect(space[0]).toMatchObject({ route: 'record', description: 'Record / stop' });
    expect(space[1]).toMatchObject({ route: 'tab', description: 'Play / pause' });
  });

  it("registers Esc as a global entry: Cancel count-in, ahead of the Tab screen's Esc", () => {
    const esc = SHORTCUTS.filter((s) => s.key === 'Escape' && s.handler);
    expect(esc).toHaveLength(2);
    expect(esc[0]).toMatchObject({ route: 'global', description: 'Cancel count-in' });
    expect(esc[1]).toMatchObject({ route: 'tab', description: 'Clear note selection' });
    // The overlays' Esc is listed, not dispatched (ui/a11y/overlays.ts handles it).
    const listed = SHORTCUTS.filter((s) => s.key === 'Escape' && !s.handler);
    expect(listed).toEqual([
      { key: 'Escape', route: 'global', description: 'Close dialog, popover or panel' },
    ]);
  });
});

describe('Esc cancels a count-in', () => {
  function store(recording: RecordingSnapshot['recording']) {
    const stop = vi.fn(() => Promise.resolve());
    const entry = cancelCountIn({
      getSnapshot: () =>
        ({ mic: 'live', recording, countIn: { on: false, bpm: 100 } }) as RecordingSnapshot,
      stop,
    });
    return { entry, stop };
  }

  afterEach(() => {
    window.location.hash = '';
  });

  it.each(['#/record', '#/library', '#/nowhere'])('during a count-in on %s', (hash) => {
    window.location.hash = hash;
    const s = store('count-in');
    const remove = installShortcuts(window, [s.entry]);
    const event = press(document.body, 'Escape');
    remove();
    expect(s.stop).toHaveBeenCalledWith('user');
    expect(event.defaultPrevented).toBe(true);
  });

  it.each(['idle', 'starting', 'recording', 'stopping'] as const)(
    'does nothing and leaves Esc to the page while %s',
    (recording) => {
      window.location.hash = '#/record';
      const s = store(recording);
      const remove = installShortcuts(window, [s.entry]);
      const event = press(document.body, 'Escape');
      remove();
      expect(s.stop).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    },
  );
});

describe('dispatch', () => {
  let handler: ReturnType<typeof vi.fn<() => void>>;
  let shortcuts: Shortcut[];
  let remove: () => void;

  beforeEach(() => {
    handler = vi.fn<() => void>();
    shortcuts = [{ key: ' ', route: 'record', description: 'Record / stop', handler }];
    window.location.hash = '#/record';
    remove = installShortcuts(window, shortcuts);
  });

  afterEach(() => {
    remove();
    document.body.innerHTML = '';
    window.location.hash = '';
  });

  it('runs on the route with focus on the body and prevents the scroll', () => {
    const event = press(document.body, ' ');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('does nothing on another route', () => {
    window.location.hash = '#/library';
    const event = press(document.body, ' ');
    expect(handler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('does nothing on an unknown hash', () => {
    window.location.hash = '#/nowhere';
    press(document.body, ' ');
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores auto-repeat: a held key toggles once, every repeat still prevented', () => {
    press(document.body, ' ');
    const repeats = [1, 2, 3].map(() => press(document.body, ' ', { repeat: true }));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(repeats.every((e) => e.defaultPrevented)).toBe(true);
  });

  it('ignores other keys and modified Space', () => {
    press(document.body, 'a');
    press(document.body, ' ', { ctrlKey: true });
    press(document.body, ' ', { metaKey: true });
    press(document.body, ' ', { altKey: true });
    press(document.body, ' ', { shiftKey: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ['input', () => add('input', { type: 'text' })],
    ['textarea', () => add('textarea')],
    ['select', () => add('select')],
    ['contenteditable', () => add('div', { contenteditable: 'true' })],
    ['inside contenteditable', () => add('div', { contenteditable: '' }).appendChild(add('span'))],
  ])('skips a text field (%s) and leaves its default', (_, make) => {
    const event = press(make(), ' ');
    expect(handler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it.each([
    ['button', () => add('button')],
    ['checkbox', () => add('input', { type: 'checkbox' })],
    ['role=checkbox', () => add('div', { role: 'checkbox', tabindex: '0' })],
  ])('leaves Space on a %s to its native action', (_, make) => {
    const event = press(make(), ' ');
    expect(handler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it.each([
    ['link', () => add('a', { href: '#/record' })],
    ['role=link', () => add('div', { role: 'link', tabindex: '0' })],
  ])('runs Space on a focused %s (Space does not activate links)', (_, make) => {
    const event = press(make(), ' ');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('runs with focus on a non-interactive element', () => {
    press(add('main', { tabindex: '-1' }), ' ');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('stops listening once removed', () => {
    remove();
    press(document.body, ' ');
    expect(handler).not.toHaveBeenCalled();
  });

  it('skips an event already handled', () => {
    const event = new KeyboardEvent('keydown', { key: ' ', cancelable: true });
    event.preventDefault();
    expect(dispatchShortcut(event, 'record', shortcuts)).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('the guard', () => {
  it('guards only native-action keys on a button', () => {
    const button = document.createElement('button');
    expect(guarded(button, ' ')).toBe(true);
    expect(guarded(button, 'Enter')).toBe(true);
    expect(guarded(button, '?')).toBe(false);
    const link = document.createElement('a');
    link.href = '#/library';
    expect(guarded(link, ' ')).toBe(false);
    expect(guarded(link, 'Enter')).toBe(true);
    expect(guarded(document.createElement('input'), '?')).toBe(true);
    expect(guarded(null, ' ')).toBe(false);
  });

  it('Space and Enter on a note button in the tab area are not guarded; other buttons are', () => {
    const area = add('div', { role: 'application', 'aria-label': 'Tab' });
    const noteButton = area.appendChild(document.createElement('button'));
    noteButton.setAttribute('data-note-id', 'n0');
    expect(guarded(noteButton, ' ')).toBe(false);
    expect(guarded(noteButton, 'Enter')).toBe(false);
    // A button in the area that is not a note, and a note-like button outside it, stay native.
    const other = area.appendChild(document.createElement('button'));
    expect(guarded(other, ' ')).toBe(true);
    expect(guarded(other, 'Enter')).toBe(true);
    const outside = add('button', { 'data-note-id': 'n1' });
    expect(guarded(outside, ' ')).toBe(true);
    expect(guarded(outside, 'Enter')).toBe(true);
    document.body.innerHTML = '';
  });
});

describe('Space on Record', () => {
  function store(
    mic: RecordingSnapshot['mic'],
    recording: RecordingSnapshot['recording'],
    countInOn = false,
  ) {
    const record = vi.fn(() => Promise.resolve());
    const stop = vi.fn(() => Promise.resolve());
    const mark = vi.fn();
    const countIn = { on: countInOn, bpm: 100 };
    const toggle = recordToggle(
      { getSnapshot: () => ({ mic, recording, countIn }) as RecordingSnapshot, record, stop },
      mark,
    );
    return { toggle, record, stop, mark };
  }

  it('starts a take when live and idle, marking the keydown first', () => {
    const s = store('live', 'idle');
    s.toggle();
    expect(s.record).toHaveBeenCalledTimes(1);
    expect(s.stop).not.toHaveBeenCalled();
    expect(s.mark).toHaveBeenCalledWith(true);
    expect(s.mark.mock.invocationCallOrder[0]).toBeLessThan(s.record.mock.invocationCallOrder[0]!);
  });

  it('stops the take when recording', () => {
    const s = store('live', 'recording');
    s.toggle();
    expect(s.stop).toHaveBeenCalledWith('user');
    expect(s.mark).toHaveBeenCalledWith(false);
    expect(s.record).not.toHaveBeenCalled();
  });

  it('with count-in on, starts and stops a take without the latency marks', () => {
    const idle = store('live', 'idle', true);
    idle.toggle();
    expect(idle.record).toHaveBeenCalledTimes(1);
    expect(idle.mark).not.toHaveBeenCalled();
    const rec = store('live', 'recording', true);
    rec.toggle();
    expect(rec.stop).toHaveBeenCalledWith('user');
    expect(rec.mark).not.toHaveBeenCalled();
  });

  it('cancels a count-in, with no latency mark', () => {
    const s = store('live', 'count-in');
    s.toggle();
    expect(s.stop).toHaveBeenCalledWith('user');
    expect(s.record).not.toHaveBeenCalled();
    expect(s.mark).not.toHaveBeenCalled();
  });

  // Story 5.2 (DS5): was ignored while starting too, so a quick Space-Space left a take running.
  it('stops while starting (the store holds the Stop until the take records)', () => {
    const s = store('live', 'starting');
    s.toggle();
    expect(s.stop).toHaveBeenCalledWith('user');
    expect(s.record).not.toHaveBeenCalled();
    expect(s.mark).not.toHaveBeenCalled();
  });

  it('is ignored while stopping', () => {
    const s = store('live', 'stopping');
    s.toggle();
    expect(s.record).not.toHaveBeenCalled();
    expect(s.stop).not.toHaveBeenCalled();
    expect(s.mark).not.toHaveBeenCalled();
  });

  it.each(['setup', 'requesting', 'error'] as const)('does nothing with the mic %s', (mic) => {
    const s = store(mic, 'idle');
    s.toggle();
    expect(s.record).not.toHaveBeenCalled();
    expect(s.mark).not.toHaveBeenCalled();
  });

  describe('the default marks', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      performance.clearMarks();
    });

    const toggleWith = (recording: RecordingSnapshot['recording']) => {
      const record = vi.fn(() => Promise.resolve());
      const stop = vi.fn(() => Promise.resolve());
      const toggle = recordToggle({
        getSnapshot: () =>
          ({ mic: 'live', recording, countIn: { on: false, bpm: 100 } }) as RecordingSnapshot,
        record,
        stop,
      });
      return { toggle, record, stop };
    };

    it('a start clears stale marks (keydown, capture start and stop), then sets one record-keydown', () => {
      performance.mark(RECORD_KEYDOWN_MARK);
      performance.mark(CAPTURE_START_MARK);
      performance.mark(CAPTURE_STOP_MARK);
      toggleWith('idle').toggle();
      expect(performance.getEntriesByName(RECORD_KEYDOWN_MARK)).toHaveLength(1);
      expect(performance.getEntriesByName(CAPTURE_START_MARK)).toHaveLength(0);
      expect(performance.getEntriesByName(CAPTURE_STOP_MARK)).toHaveLength(0);
    });

    it('a stop adds its mark without clearing', () => {
      toggleWith('idle').toggle();
      toggleWith('recording').toggle();
      expect(performance.getEntriesByName(RECORD_KEYDOWN_MARK)).toHaveLength(2);
    });

    it('a throwing mark still starts the take', () => {
      vi.spyOn(performance, 'mark').mockImplementation(() => {
        throw new Error('no user timing');
      });
      const t = toggleWith('idle');
      t.toggle();
      expect(t.record).toHaveBeenCalledTimes(1);
    });
  });
});

// Story "Tab screen, reflow and selection" (US-6.3): ← / → and Esc on the Tab screen.
describe('the Tab selection shortcuts', () => {
  function fakeSession(
    selectedNoteId: string | null,
    notes = 3,
    over: Partial<Pick<TakeSnapshot, 'analysis' | 'missing'>> = {},
    flagged: readonly number[] = [],
  ) {
    let snapshot = {
      tab: {
        notes: Array.from({ length: notes }, (_, i) => ({
          id: `n${i}`,
          lowConfidence: flagged.includes(i),
        })),
      },
      selectedNoteId,
      lastFocusedNoteId: null,
      analysis: { kind: 'idle' },
      ...over,
    } as unknown as TakeSnapshot;
    return {
      getSnapshot: () => snapshot,
      /** As the tab area does when a note button takes focus. */
      focusNote: (id: string) => {
        snapshot = { ...snapshot, lastFocusedNoteId: id };
      },
      select: vi.fn(),
      selectNext: vi.fn(),
      selectPrev: vi.fn(),
      // As the real session: the next flagged note after the selection, else after `from` (default
      // the last focused note), else from the start, wrapping.
      selectNextFlagged: vi.fn((from?: string | null) => {
        const current = snapshot.selectedNoteId ?? from ?? snapshot.lastFocusedNoteId;
        const at = current === null ? -1 : Number(current.slice(1));
        const next = flagged.find((i) => i > at) ?? flagged[0];
        if (next !== undefined) snapshot = { ...snapshot, selectedNoteId: `n${next}` };
      }),
    };
  }

  let remove: () => void = () => {};
  afterEach(() => {
    remove();
    document.body.innerHTML = '';
    window.location.hash = '';
  });

  function install(session: ReturnType<typeof fakeSession> | null, hash = '#/tab/t1') {
    window.location.hash = hash;
    const recording = cancelCountIn({
      getSnapshot: () =>
        ({ mic: 'live', recording: 'idle', countIn: { on: false, bpm: 100 } }) as RecordingSnapshot,
      stop: vi.fn(() => Promise.resolve()),
    });
    remove = installShortcuts(window, [recording, ...tabSelectionShortcuts(() => session)]);
  }

  /** A note button inside a tab area, focused. */
  function note(id: string): HTMLButtonElement {
    const area = add('div', { role: 'application', 'aria-label': 'Tab' });
    const button = document.createElement('button');
    button.setAttribute('data-note-id', id);
    area.append(button);
    button.focus();
    return button;
  }

  it('registers ← / → / Esc / N on the tab route with descriptions', () => {
    const tab = SHORTCUTS.filter((s) => s.route === 'tab' && s.handler);
    expect(tab.map((s) => [s.key, s.description])).toEqual([
      ['ArrowLeft', 'Previous note'],
      ['ArrowRight', 'Next note'],
      ['Escape', 'Clear note selection'],
      ['n', 'Next note to check'],
      [' ', 'Play / pause'],
      ['p', 'Seek playback to selected note'],
      ...'0123456789'
        .split('')
        .map((d) => [d, 'Set fret; two digits within 400 ms make one number']),
      ['z', 'Undo'],
      ['z', 'Redo'],
      ['y', 'Redo'],
      ['ArrowUp', 'Move note to the next thinner string, same pitch'],
      ['ArrowDown', 'Move note to the next thicker string, same pitch'],
      ['Delete', 'Delete note'],
      ['Backspace', 'Delete note'],
      ['i', 'Insert note after selection'],
      ['Enter', 'Confirm selected note (clears flag, locks it)'],
      ['c', 'Copy tab'],
    ]);
  });

  /** A tab area of note buttons n0 … n<count − 1>, none focused. */
  function area(count: number): HTMLButtonElement[] {
    const el = add('div', { role: 'application', 'aria-label': 'Tab' });
    return Array.from({ length: count }, (_, i) => {
      const button = document.createElement('button');
      button.setAttribute('data-note-id', `n${i}`);
      el.append(button);
      return button;
    });
  }

  it('N selects and focuses the next flagged note, from the body, the tab area or a button', () => {
    const session = fakeSession(null, 3, {}, [2]);
    install(session);
    const buttons = area(3);
    expect(press(document.body, 'n').defaultPrevented).toBe(true);
    expect(session.selectNextFlagged).toHaveBeenCalledWith();
    expect(document.activeElement).toBe(buttons[2]);
    buttons[0]!.focus();
    session.focusNote('n0');
    press(buttons[0]!, 'n');
    expect(session.selectNextFlagged).toHaveBeenLastCalledWith();
    expect(document.activeElement).toBe(buttons[2]);
    press(add('button'), 'n'); // e.g. Next to check itself
    expect(session.selectNextFlagged).toHaveBeenCalledTimes(3);
  });

  it('N starts from the focused note with nothing selected, and works with Caps Lock (N)', () => {
    const session = fakeSession(null, 4, {}, [0, 2]);
    install(session);
    const buttons = area(4);
    buttons[1]!.focus();
    session.focusNote('n1');
    expect(press(buttons[1]!, 'N').defaultPrevented).toBe(true);
    expect(session.selectNextFlagged).toHaveBeenCalledWith();
    expect(session.getSnapshot().selectedNoteId).toBe('n2');
    expect(document.activeElement).toBe(buttons[2]);
    press(buttons[2]!, 'n'); // wraps
    expect(session.getSnapshot().selectedNoteId).toBe('n0');
    expect(document.activeElement).toBe(buttons[0]);
    // Shift is still refused.
    expect(press(buttons[0]!, 'N', { shiftKey: true }).defaultPrevented).toBe(false);
  });

  it('N does nothing with no flagged note, from a text field, in the toolbar, or with no tab', () => {
    const none = fakeSession(null, 3);
    install(none);
    expect(press(document.body, 'n').defaultPrevented).toBe(false);
    expect(none.selectNextFlagged).not.toHaveBeenCalled();
    remove();
    const session = fakeSession(null, 3, {}, [1]);
    install(session);
    expect(press(add('input', { type: 'text' }), 'n').defaultPrevented).toBe(false);
    const toolbar = add('div', { role: 'toolbar', 'aria-label': 'Tab tools' });
    const tool = toolbar.appendChild(document.createElement('button'));
    expect(press(tool, 'n').defaultPrevented).toBe(false);
    expect(session.selectNextFlagged).not.toHaveBeenCalled();
    remove();
    const running = fakeSession(null, 3, { analysis: { kind: 'running', progress: 0.5 } }, [1]);
    install(running);
    expect(press(document.body, 'n').defaultPrevented).toBe(false);
    expect(running.selectNextFlagged).not.toHaveBeenCalled();
  });

  it('in the tab area → selects the next note, ← the previous (the session starts from its last focused note)', () => {
    const session = fakeSession(null);
    install(session);
    const button = note('n1');
    const right = press(button, 'ArrowRight');
    const left = press(button, 'ArrowLeft');
    expect(session.selectNext).toHaveBeenCalledWith();
    expect(session.selectPrev).toHaveBeenCalledWith();
    expect(right.defaultPrevented && left.defaultPrevented).toBe(true);
  });

  it("holding ← / → repeats; Record's Space and the other entries still fire once", () => {
    const session = fakeSession('n1');
    install(session);
    const button = note('n1');
    press(button, 'ArrowRight');
    press(button, 'ArrowRight', { repeat: true });
    press(button, 'ArrowRight', { repeat: true });
    press(button, 'ArrowLeft', { repeat: true });
    expect(session.selectNext).toHaveBeenCalledTimes(3);
    expect(session.selectPrev).toHaveBeenCalledTimes(1);
    press(document.body, 'Escape', { repeat: true });
    expect(session.select).not.toHaveBeenCalled();
    expect(SHORTCUTS.filter((s) => s.repeat).map((s) => [s.route, s.key])).toEqual([
      ['tab', 'ArrowLeft'],
      ['tab', 'ArrowRight'],
      ['tab', 'ArrowUp'],
      ['tab', 'ArrowDown'],
    ]);
  });

  it.each([
    ['the body', () => document.body],
    ['the skip link', () => add('a', { href: '#/tab/t1' })],
    ['a button outside the tab area', () => add('button')],
  ])('the arrows do nothing from %s', (_, make) => {
    const session = fakeSession('n1');
    install(session);
    const target = make();
    for (const key of ['ArrowLeft', 'ArrowRight']) {
      expect(press(target, key).defaultPrevented).toBe(false);
    }
    expect(session.selectNext).not.toHaveBeenCalled();
    expect(session.selectPrev).not.toHaveBeenCalled();
  });

  it('Esc clears a selection from anywhere on the screen (Global); with none it is left to the page', () => {
    const session = fakeSession('n1');
    install(session);
    expect(press(document.body, 'Escape').defaultPrevented).toBe(true);
    expect(press(note('n1'), 'Escape').defaultPrevented).toBe(true);
    // From Play (a button outside the tab area) and from a link (the skip link) too.
    const play = add('button', { 'aria-label': 'Play' });
    expect(press(play, 'Escape').defaultPrevented).toBe(true);
    expect(press(add('a', { href: '#/tab/t1' }), 'Escape').defaultPrevented).toBe(true);
    expect(session.select).toHaveBeenCalledTimes(4);
    expect(session.select).toHaveBeenCalledWith(null);
    remove();
    const none = fakeSession(null);
    install(none);
    expect(press(document.body, 'Escape').defaultPrevented).toBe(false);
    expect(none.select).not.toHaveBeenCalled();
  });

  it.each([
    ['running', { analysis: { kind: 'running', progress: 0.5 } }],
    ['failed', { analysis: { kind: 'failed', code: 'analysis-failed' } }],
    ['missing', { missing: true }],
  ] as const)('nothing while the tab is not shown (%s)', (_, over) => {
    const session = fakeSession('n1', 3, over as Partial<TakeSnapshot>);
    install(session);
    const button = note('n1');
    for (const key of ['ArrowLeft', 'ArrowRight', 'Escape']) {
      expect(press(button, key).defaultPrevented).toBe(false);
    }
    expect(press(document.body, 'Escape').defaultPrevented).toBe(false);
    expect(session.selectNext).not.toHaveBeenCalled();
    expect(session.select).not.toHaveBeenCalled();
  });

  it('nothing from the title field (a text field)', () => {
    const session = fakeSession('n1');
    install(session);
    const input = add('input', { type: 'text' });
    for (const key of ['ArrowLeft', 'ArrowRight', 'Escape']) {
      expect(press(input, key).defaultPrevented).toBe(false);
    }
    expect(session.selectNext).not.toHaveBeenCalled();
    expect(session.selectPrev).not.toHaveBeenCalled();
    expect(session.select).not.toHaveBeenCalled();
  });

  it('nothing while focus is inside the toolbar', () => {
    const session = fakeSession('n1');
    install(session);
    const toolbar = add('div', { role: 'toolbar', 'aria-label': 'Tab tools' });
    const button = toolbar.appendChild(document.createElement('button'));
    for (const key of ['ArrowLeft', 'ArrowRight', 'Escape']) {
      expect(press(button, key).defaultPrevented).toBe(false);
    }
    expect(session.selectNext).not.toHaveBeenCalled();
    expect(session.selectPrev).not.toHaveBeenCalled();
    expect(session.select).not.toHaveBeenCalled();
  });

  it('Space and Enter on a toolbar button keep their native action: a tab-route entry never fires', () => {
    window.location.hash = '#/tab/t1';
    const handler = vi.fn();
    remove = installShortcuts(window, [
      { key: ' ', route: 'tab', description: 'x', handler },
      { key: 'Enter', route: 'tab', description: 'y', handler },
    ]);
    const toolbar = add('div', { role: 'toolbar', 'aria-label': 'Tab tools' });
    const button = toolbar.appendChild(document.createElement('button'));
    expect(press(button, ' ').defaultPrevented).toBe(false);
    expect(press(button, 'Enter').defaultPrevented).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    // The same entries do fire with focus on the body: the guard, not the route, held them.
    press(document.body, ' ');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('nothing on another route, with no open session, or with no notes', () => {
    const session = fakeSession('n1');
    install(session, '#/record');
    press(note('n1'), 'ArrowRight');
    press(document.body, 'Escape');
    remove();
    install(null);
    expect(press(note('n1'), 'ArrowRight').defaultPrevented).toBe(false);
    remove();
    const empty = fakeSession(null, 0);
    install(empty);
    expect(press(note('n1'), 'ArrowRight').defaultPrevented).toBe(false);
    expect(session.selectNext).not.toHaveBeenCalled();
    expect(session.select).not.toHaveBeenCalled();
    expect(empty.selectNext).not.toHaveBeenCalled();
  });

  it('a count-in Esc keeps priority', () => {
    window.location.hash = '#/tab/t1';
    const session = fakeSession('n1');
    const stop = vi.fn(() => Promise.resolve());
    const countIn = cancelCountIn({
      getSnapshot: () =>
        ({
          mic: 'live',
          recording: 'count-in',
          countIn: { on: true, bpm: 100 },
        }) as RecordingSnapshot,
      stop,
    });
    remove = installShortcuts(window, [countIn, ...tabSelectionShortcuts(() => session)]);
    press(document.body, 'Escape');
    expect(stop).toHaveBeenCalledWith('user');
    expect(session.select).not.toHaveBeenCalled();
  });

  it('N skips flagged notes hidden by the trim, and does nothing in the Trim strip (story "Trim")', () => {
    const session = fakeSession(null, 3, {}, [0]);
    const snap = session.getSnapshot() as unknown as {
      take: unknown;
      tab: { notes: { startMs: number }[] };
    };
    // n0, the only flagged note, starts before the trim start: hidden.
    snap.take = { trimStartMs: 1000, trimEndMs: null };
    snap.tab.notes.forEach((n, i) => (n.startMs = i * 1000));
    install(session);
    expect(press(document.body, 'n').defaultPrevented).toBe(false);
    expect(session.selectNextFlagged).not.toHaveBeenCalled();
    snap.take = { trimStartMs: 0, trimEndMs: null };
    const strip = add('section', { 'data-trim-strip': '' });
    const handle = document.createElement('div');
    handle.tabIndex = 0;
    strip.append(handle);
    handle.focus();
    expect(press(handle, 'n').defaultPrevented).toBe(false);
    expect(press(document.body, 'n').defaultPrevented).toBe(true);
    expect(session.selectNextFlagged).toHaveBeenCalledTimes(1);
  });
});

describe('the Tab playback shortcuts', () => {
  function fakeSession(selectedNoteId: string | null, over: Partial<TakeSnapshot> = {}) {
    const snapshot = {
      tab: { notes: [{ id: 'n0' }, { id: 'n1' }] },
      selectedNoteId,
      missing: false,
      analysis: { kind: 'idle' },
      ...over,
    } as unknown as TakeSnapshot;
    return { getSnapshot: () => snapshot };
  }

  function fakePlayback(available = true) {
    return { available: vi.fn(() => available), toggle: vi.fn(), playFromNote: vi.fn() };
  }

  let remove: () => void = () => {};
  afterEach(() => {
    remove();
    document.body.innerHTML = '';
    window.location.hash = '';
  });

  function install(
    session: ReturnType<typeof fakeSession> | null,
    playback: ReturnType<typeof fakePlayback> | null,
    hash = '#/tab/t1',
  ) {
    window.location.hash = hash;
    remove = installShortcuts(
      window,
      tabPlaybackShortcuts(
        () => session,
        () => playback,
      ),
    );
  }

  /** A note button inside a tab area, focused. */
  function note(id: string): HTMLButtonElement {
    const area = add('div', { role: 'application', 'aria-label': 'Tab' });
    const button = document.createElement('button');
    button.setAttribute('data-note-id', id);
    area.append(button);
    button.focus();
    return button;
  }

  it('Space toggles playback from the body and from a focused note button', () => {
    const playback = fakePlayback();
    install(fakeSession(null), playback);
    expect(press(document.body, ' ').defaultPrevented).toBe(true);
    expect(playback.toggle).toHaveBeenCalledTimes(1);
    expect(press(note('n0'), ' ').defaultPrevented).toBe(true);
    expect(playback.toggle).toHaveBeenCalledTimes(2);
  });

  it('Space keeps its native action on other buttons and does nothing in text fields', () => {
    const playback = fakePlayback();
    install(fakeSession(null), playback);
    const play = add('button');
    play.setAttribute('aria-label', 'Play');
    expect(press(play, ' ').defaultPrevented).toBe(false);
    const input = add('input');
    expect(press(input, ' ').defaultPrevented).toBe(false);
    expect(playback.toggle).not.toHaveBeenCalled();
  });

  it('Space and P do nothing in the toolbar, even on a note-like element there', () => {
    const playback = fakePlayback();
    install(fakeSession('n1'), playback);
    const toolbar = add('div', { role: 'toolbar', 'aria-label': 'Tab tools' });
    const span = toolbar.appendChild(document.createElement('span'));
    span.tabIndex = 0;
    expect(press(span, ' ').defaultPrevented).toBe(false);
    expect(press(span, 'p').defaultPrevented).toBe(false);
    expect(playback.toggle).not.toHaveBeenCalled();
    expect(playback.playFromNote).not.toHaveBeenCalled();
  });

  it('no audio (or still loading): Space and P are left to the page', () => {
    const playback = fakePlayback(false);
    install(fakeSession('n1'), playback);
    expect(press(document.body, ' ').defaultPrevented).toBe(false);
    expect(press(document.body, 'p').defaultPrevented).toBe(false);
    expect(playback.toggle).not.toHaveBeenCalled();
    expect(playback.playFromNote).not.toHaveBeenCalled();
  });

  it('nothing without a shown tab, a mounted playback, or on another route', () => {
    const playback = fakePlayback();
    install(fakeSession('n1', { analysis: { kind: 'running', progress: 0.5 } }), playback);
    expect(press(document.body, ' ').defaultPrevented).toBe(false);
    remove();
    install(
      fakeSession('n1', { tab: { notes: [] } } as unknown as Partial<TakeSnapshot>),
      playback,
    );
    expect(press(document.body, ' ').defaultPrevented).toBe(false);
    remove();
    install(fakeSession('n1'), null);
    expect(press(document.body, ' ').defaultPrevented).toBe(false);
    remove();
    install(fakeSession('n1'), playback, '#/record');
    expect(press(document.body, ' ').defaultPrevented).toBe(false);
    expect(press(document.body, 'p').defaultPrevented).toBe(false);
    expect(playback.toggle).not.toHaveBeenCalled();
    expect(playback.playFromNote).not.toHaveBeenCalled();
  });

  it('P plays from the selected note, case-insensitively; with no selection it does nothing', () => {
    const playback = fakePlayback();
    install(fakeSession('n1'), playback);
    expect(press(document.body, 'p').defaultPrevented).toBe(true);
    expect(playback.playFromNote).toHaveBeenCalledWith('n1');
    expect(press(note('n1'), 'P').defaultPrevented).toBe(true);
    expect(playback.playFromNote).toHaveBeenCalledTimes(2);
    // Shift+P is refused, as for every shortcut.
    expect(press(document.body, 'P', { shiftKey: true }).defaultPrevented).toBe(false);
    remove();
    const none = fakePlayback();
    install(fakeSession(null), none);
    expect(press(document.body, 'p').defaultPrevented).toBe(false);
    expect(none.playFromNote).not.toHaveBeenCalled();
  });

  it('P in a text field does nothing', () => {
    const playback = fakePlayback();
    install(fakeSession('n1'), playback);
    expect(press(add('input'), 'p').defaultPrevented).toBe(false);
    expect(playback.playFromNote).not.toHaveBeenCalled();
  });

  it('in the Trim strip, Space and P are left to the strip (story "Trim")', () => {
    const playback = fakePlayback();
    install(fakeSession('n0'), playback);
    const strip = add('section', { 'data-trim-strip': '' });
    const handle = document.createElement('div');
    handle.setAttribute('role', 'slider');
    handle.tabIndex = 0;
    strip.append(handle);
    handle.focus();
    expect(press(handle, ' ').defaultPrevented).toBe(false);
    expect(press(handle, 'p').defaultPrevented).toBe(false);
    expect(playback.toggle).not.toHaveBeenCalled();
    expect(playback.playFromNote).not.toHaveBeenCalled();
  });
});

// Story "Change a fret and undo it": the digit keys and the undo / redo modifier entries.
describe('the Tab edit shortcuts', () => {
  function fakeSession(selectedNoteId: string | null, over: Partial<TakeSnapshot> = {}) {
    const snapshot = {
      tab: { notes: [{ id: 'n0' }, { id: 'n1' }] },
      selectedNoteId,
      missing: false,
      analysis: { kind: 'idle' },
      ...over,
    } as unknown as TakeSnapshot;
    return {
      getSnapshot: () => snapshot,
      typeDigit: vi.fn(),
      undo: vi.fn(() => Promise.resolve()),
      redo: vi.fn(() => Promise.resolve()),
      canUndo: vi.fn(() => false),
      canRedo: vi.fn(() => false),
      moveStringBy: vi.fn(() => Promise.resolve()),
      deleteSelected: vi.fn(() => Promise.resolve()),
      insert: vi.fn(() => Promise.resolve()),
      confirm: vi.fn(() => Promise.resolve()),
    };
  }

  let remove: () => void = () => {};
  afterEach(() => {
    remove();
    document.body.innerHTML = '';
    window.location.hash = '';
  });

  function install(session: ReturnType<typeof fakeSession> | null, mac = false, hash = '#/tab/t1') {
    window.location.hash = hash;
    remove = installShortcuts(
      window,
      tabEditShortcuts(() => session),
      () => mac,
    );
  }

  it('each digit sets the fret of the selected note', () => {
    const session = fakeSession('n1');
    install(session);
    for (const d of '0123456789') expect(press(document.body, d).defaultPrevented).toBe(true);
    expect(session.typeDigit.mock.calls.map(([d]) => d)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('digits do nothing with focus in the toolbar; undo and redo still work there', () => {
    const session = fakeSession('n1');
    install(session);
    const toolbar = add('div', { role: 'toolbar', 'aria-label': 'Tab tools' });
    const undoButton = toolbar.appendChild(document.createElement('button'));
    undoButton.focus();
    expect(press(undoButton, '5').defaultPrevented).toBe(false);
    expect(session.typeDigit).not.toHaveBeenCalled();
    expect(press(undoButton, 'z', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(session.undo).toHaveBeenCalledTimes(1);
    expect(press(undoButton, 'y', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(session.redo).toHaveBeenCalledTimes(1);
  });

  it('undo and redo match the physical key on non-Latin layouts (Ctrl+я is Ctrl+Z)', () => {
    const session = fakeSession('n1');
    install(session);
    expect(press(document.body, 'я', { ctrlKey: true, code: 'KeyZ' }).defaultPrevented).toBe(true);
    expect(session.undo).toHaveBeenCalledTimes(1);
    expect(
      press(document.body, 'Я', { ctrlKey: true, shiftKey: true, code: 'KeyZ' }).defaultPrevented,
    ).toBe(true);
    expect(press(document.body, 'н', { ctrlKey: true, code: 'KeyY' }).defaultPrevented).toBe(true);
    expect(session.redo).toHaveBeenCalledTimes(2);
    // Without a modifier, a code alone matches nothing.
    expect(press(document.body, 'я', { code: 'KeyZ' }).defaultPrevented).toBe(false);
  });

  it('digits need a selected note and a shown tab, and are left to the page otherwise', () => {
    const none = fakeSession(null);
    install(none);
    expect(press(document.body, '5').defaultPrevented).toBe(false);
    remove();
    const analysing = fakeSession('n1', { analysis: { kind: 'running', progress: 0.2 } });
    install(analysing);
    expect(press(document.body, '5').defaultPrevented).toBe(false);
    remove();
    const elsewhere = fakeSession('n1');
    install(elsewhere, false, '#/library');
    expect(press(document.body, '5').defaultPrevented).toBe(false);
    for (const s of [none, analysing, elsewhere]) expect(s.typeDigit).not.toHaveBeenCalled();
  });

  it('a digit in a text field is typed, not a fret', () => {
    const session = fakeSession('n1');
    install(session);
    const input = add('input');
    expect(press(input, '5').defaultPrevented).toBe(false);
    expect(session.typeDigit).not.toHaveBeenCalled();
  });

  it('a digit typed with Shift (AZERTY number row) sets the fret; Ctrl, ⌘ or Alt still refused', () => {
    const session = fakeSession('n1');
    install(session);
    expect(press(document.body, '5', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(session.typeDigit).toHaveBeenCalledWith(5);
    for (const mod of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      expect(press(document.body, '5', { shiftKey: true, [mod]: true }).defaultPrevented).toBe(
        false,
      );
    }
    expect(session.typeDigit).toHaveBeenCalledTimes(1);
  });

  it('a held digit fires once; a digit with a modifier is left to the page', () => {
    const session = fakeSession('n1');
    install(session);
    press(document.body, '5');
    press(document.body, '5', { repeat: true });
    expect(press(document.body, '5', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press(document.body, '5', { altKey: true }).defaultPrevented).toBe(false);
    expect(session.typeDigit).toHaveBeenCalledTimes(1);
  });

  it('non-Mac: Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo; ⌘ does nothing', () => {
    const session = fakeSession(null);
    install(session, false);
    expect(press(document.body, 'z', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(session.undo).toHaveBeenCalledTimes(1);
    expect(press(document.body, 'Z', { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(
      true,
    );
    expect(press(document.body, 'y', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(session.redo).toHaveBeenCalledTimes(2);
    expect(press(document.body, 'z', { metaKey: true }).defaultPrevented).toBe(false);
    expect(press(document.body, 'z', { ctrlKey: true, altKey: true }).defaultPrevented).toBe(false);
    expect(press(document.body, 'z').defaultPrevented).toBe(false);
    expect(session.undo).toHaveBeenCalledTimes(1);
  });

  it('Mac: ⌘Z undoes, ⌘⇧Z and Ctrl+Y redo; Ctrl+Z does nothing', () => {
    const session = fakeSession(null);
    install(session, true);
    expect(press(document.body, 'z', { metaKey: true }).defaultPrevented).toBe(true);
    expect(session.undo).toHaveBeenCalledTimes(1);
    expect(press(document.body, 'z', { metaKey: true, shiftKey: true }).defaultPrevented).toBe(
      true,
    );
    expect(press(document.body, 'y', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(session.redo).toHaveBeenCalledTimes(2);
    expect(press(document.body, 'z', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press(document.body, 'z', { metaKey: true, ctrlKey: true }).defaultPrevented).toBe(
      false,
    );
    expect(session.undo).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+Z in the title field stays native', () => {
    const session = fakeSession('n1');
    install(session);
    const input = add('input');
    expect(press(input, 'z', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press(input, 'y', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(session.undo).not.toHaveBeenCalled();
    expect(session.redo).not.toHaveBeenCalled();
  });

  it('undo and redo need a shown tab', () => {
    const session = fakeSession(null, { missing: true });
    install(session);
    expect(press(document.body, 'z', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(session.undo).not.toHaveBeenCalled();
  });

  it('undo and redo work in the No notes found state only while there is history', () => {
    const session = fakeSession(null, {
      tab: { notes: [] },
      take: {},
    } as unknown as Partial<TakeSnapshot>);
    install(session);
    expect(press(document.body, 'z', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press(document.body, 'y', { ctrlKey: true }).defaultPrevented).toBe(false);
    session.canUndo.mockReturnValue(true);
    expect(press(document.body, 'z', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(session.undo).toHaveBeenCalledTimes(1);
    expect(press(document.body, 'y', { ctrlKey: true }).defaultPrevented).toBe(false);
    session.canRedo.mockReturnValue(true);
    expect(press(document.body, 'y', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(press(document.body, 'Z', { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(
      true,
    );
    expect(session.redo).toHaveBeenCalledTimes(2);
  });

  // Story "String moves, delete, insert and confirm".
  /** A note button inside a tab area, focused. */
  function noteButton(id: string): HTMLButtonElement {
    const area = add('div', { role: 'application', 'aria-label': 'Tab' });
    const button = document.createElement('button');
    button.setAttribute('data-note-id', id);
    area.append(button);
    button.focus();
    return button;
  }

  it('↑ / ↓ in the tab area move the selected note a string thinner / thicker, repeating', () => {
    const session = fakeSession('n1');
    install(session);
    const button = noteButton('n1');
    expect(press(button, 'ArrowUp').defaultPrevented).toBe(true);
    expect(session.moveStringBy).toHaveBeenLastCalledWith(-1);
    expect(press(button, 'ArrowDown').defaultPrevented).toBe(true);
    expect(session.moveStringBy).toHaveBeenLastCalledWith(1);
    press(button, 'ArrowDown', { repeat: true });
    expect(session.moveStringBy).toHaveBeenCalledTimes(3);
  });

  it('↑ / ↓ need focus in the tab area (not the toolbar), a shown tab and a selection', () => {
    const session = fakeSession('n1');
    install(session);
    expect(press(document.body, 'ArrowUp').defaultPrevented).toBe(false);
    const toolbar = add('div', { role: 'toolbar' });
    const tool = toolbar.appendChild(document.createElement('button'));
    expect(press(tool, 'ArrowDown').defaultPrevented).toBe(false);
    remove();
    const none = fakeSession(null);
    install(none);
    expect(press(noteButton('n0'), 'ArrowUp').defaultPrevented).toBe(false);
    expect(session.moveStringBy).not.toHaveBeenCalled();
    expect(none.moveStringBy).not.toHaveBeenCalled();
  });

  it.each(['Delete', 'Backspace'])(
    '%s deletes the selected note from anywhere but a text field or the toolbar',
    (key) => {
      const session = fakeSession('n1');
      install(session);
      expect(press(document.body, key).defaultPrevented).toBe(true);
      expect(press(noteButton('n1'), key).defaultPrevented).toBe(true);
      expect(session.deleteSelected).toHaveBeenCalledTimes(2);
      expect(press(add('input'), key).defaultPrevented).toBe(false);
      const toolbar = add('div', { role: 'toolbar' });
      expect(
        press(toolbar.appendChild(document.createElement('button')), key).defaultPrevented,
      ).toBe(false);
      expect(session.deleteSelected).toHaveBeenCalledTimes(2);
      remove();
      const none = fakeSession(null);
      install(none);
      expect(press(document.body, key).defaultPrevented).toBe(false);
      expect(none.deleteSelected).not.toHaveBeenCalled();
    },
  );

  it('I inserts a note (selection or not) while the tab is shown, not in a text field', () => {
    const session = fakeSession(null);
    install(session);
    expect(press(document.body, 'i').defaultPrevented).toBe(true);
    expect(press(document.body, 'I').defaultPrevented).toBe(true); // Caps Lock
    expect(press(add('input'), 'i').defaultPrevented).toBe(false);
    expect(session.insert).toHaveBeenCalledTimes(2);
    remove();
    const empty = fakeSession(null, { tab: { notes: [] } } as unknown as Partial<TakeSnapshot>);
    install(empty);
    expect(press(document.body, 'i').defaultPrevented).toBe(false);
    expect(empty.insert).not.toHaveBeenCalled();
  });

  it('Enter on a note confirms the selected note; Enter on another button stays native', () => {
    const session = fakeSession('n1');
    install(session);
    expect(press(noteButton('n1'), 'Enter').defaultPrevented).toBe(true);
    expect(session.confirm).toHaveBeenCalledWith('n1');
    const toolbar = add('div', { role: 'toolbar' });
    const tool = toolbar.appendChild(document.createElement('button'));
    expect(press(tool, 'Enter').defaultPrevented).toBe(false);
    expect(press(add('button'), 'Enter').defaultPrevented).toBe(false);
    expect(press(document.body, 'Enter').defaultPrevented).toBe(false);
    expect(session.confirm).toHaveBeenCalledTimes(1);
  });

  it('no shortcut runs while an overlay is open', async () => {
    const { openOverlay } = await import('../../src/ui/a11y/overlays');
    const session = fakeSession('n1');
    install(session);
    const opener = noteButton('n1');
    const popover = add('div');
    popover.appendChild(document.createElement('button'));
    const release = openOverlay({ element: popover, opener, onDismiss: () => {} });
    for (const key of ['n', ' ', 'Delete', 'i', '5']) {
      expect(press(document.body, key).defaultPrevented).toBe(false);
    }
    expect(session.deleteSelected).not.toHaveBeenCalled();
    expect(session.insert).not.toHaveBeenCalled();
    expect(session.typeDigit).not.toHaveBeenCalled();
    release();
    expect(press(document.body, 'Delete').defaultPrevented).toBe(true);
  });

  it('the registry still refuses modifier combinations no entry declares', () => {
    const handler = vi.fn();
    const shortcuts: Shortcut[] = [{ key: 'n', route: 'global', description: 'x', handler }];
    for (const mod of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) {
      const event = new KeyboardEvent('keydown', { key: 'n', cancelable: true, [mod]: true });
      expect(dispatchShortcut(event, 'tab', shortcuts, false)).toBe(false);
      expect(dispatchShortcut(event, 'tab', shortcuts, true)).toBe(false);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  // Story "Trim".
  /** A focused trim handle inside the Trim strip. */
  function trimHandle(): HTMLElement {
    const strip = add('section', { 'data-trim-strip': '' });
    const handle = document.createElement('div');
    handle.setAttribute('role', 'slider');
    handle.tabIndex = 0;
    strip.append(handle);
    handle.focus();
    return handle;
  }

  it('in the Trim strip, digits, Delete, Backspace and I are left to the strip', () => {
    const session = fakeSession('n1');
    install(session);
    const handle = trimHandle();
    for (const key of ['5', 'Delete', 'Backspace', 'i']) {
      expect(press(handle, key).defaultPrevented).toBe(false);
    }
    expect(session.typeDigit).not.toHaveBeenCalled();
    expect(session.deleteSelected).not.toHaveBeenCalled();
    expect(session.insert).not.toHaveBeenCalled();
    // Outside the strip they still work.
    expect(press(document.body, '5').defaultPrevented).toBe(true);
    expect(session.typeDigit).toHaveBeenCalledWith(5);
  });

  it('every note hidden by the trim (No notes found) with history: Ctrl+Z undoes', () => {
    const session = fakeSession(null, {
      take: { trimStartMs: 5000, trimEndMs: null },
      tab: { notes: [{ id: 'n0', startMs: 100 }] },
    } as unknown as Partial<TakeSnapshot>);
    session.canUndo.mockReturnValue(true);
    install(session);
    expect(press(document.body, 'z', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(session.undo).toHaveBeenCalledTimes(1);
  });
});

describe('isMacPlatform', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (navigator as Navigator & { userAgentData?: unknown }).userAgentData;
  });

  const platform = (value: string) => vi.spyOn(navigator, 'platform', 'get').mockReturnValue(value);
  const userAgentData = (value: string) =>
    Object.defineProperty(navigator, 'userAgentData', {
      value: { platform: value },
      configurable: true,
    });

  it.each([
    ['MacIntel', true],
    ['iPhone', true],
    ['iPad', true],
    ['iPod touch', true],
    ['Win32', false],
    ['Linux x86_64', false],
  ])('navigator.platform %s, no userAgentData: %s', (value, mac) => {
    platform(value);
    expect(isMacPlatform()).toBe(mac);
  });

  it.each([
    ['macOS', true],
    ['iOS', true],
    ['Windows', false],
  ])('userAgentData.platform %s wins: %s', (value, mac) => {
    platform(mac ? 'Win32' : 'MacIntel');
    userAgentData(value);
    expect(isMacPlatform()).toBe(mac);
  });
});

// Story "Copy and Download on the Tab screen": Ctrl/⌘+Shift+C copies the shown tab.
describe('the Tab copy shortcut', () => {
  const take = {
    title: 'Riff',
    createdAt: new Date(2026, 9, 4, 9, 5).toISOString(),
    countInBpm: 100,
    trimStartMs: 1000,
    trimEndMs: null,
  };
  const notes = [0, 500, 1500, 2000].map((startMs, i) => ({
    id: `n${i}`,
    string: 1,
    fret: i,
    startMs,
    endMs: startMs + 100,
    midi: 0,
    confidence: 1,
    locked: false,
    lowConfidence: false,
  }));
  function fakeSession(over: Partial<TakeSnapshot> = {}) {
    const snapshot = {
      take,
      tab: { notes },
      selectedNoteId: null,
      missing: false,
      analysis: { kind: 'idle' },
      ...over,
    } as unknown as TakeSnapshot;
    return { getSnapshot: () => snapshot };
  }

  let remove: () => void = () => {};
  afterEach(() => {
    remove();
    document.body.innerHTML = '';
    window.location.hash = '';
  });

  function install(
    session: ReturnType<typeof fakeSession> | null,
    { mac = false, barLines = true, hash = '#/tab/t1' } = {},
  ) {
    window.location.hash = hash;
    const copy = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    remove = installShortcuts(
      window,
      tabExportShortcuts(
        () => session,
        () => barLines,
        copy,
      ),
      () => mac,
    );
    return copy;
  }

  it('is registered on the Tab route as Ctrl/⌘+Shift+C', () => {
    expect(SHORTCUTS.find((s) => s.key === 'c')).toMatchObject({
      route: 'tab',
      mod: 'mod+shift',
      description: 'Copy tab',
    });
  });

  it('copies the visible notes (the trim applied) with Ctrl+Shift+C, or ⌘+Shift+C on a Mac', async () => {
    const { tabExportText } = await import('../../src/ui/tab-export');
    const copy = install(fakeSession());
    expect(press(document.body, 'C', { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(
      true,
    );
    const visible = notes.slice(2) as unknown as Parameters<typeof tabExportText>[1];
    expect(copy).toHaveBeenCalledWith(tabExportText(take, visible, true));
    remove();
    const mac = install(fakeSession(), { mac: true });
    expect(press(document.body, 'C', { metaKey: true, shiftKey: true }).defaultPrevented).toBe(
      true,
    );
    expect(mac).toHaveBeenCalledTimes(1);
    // Ctrl+C without Shift stays the browser's.
    expect(press(document.body, 'c', { metaKey: true }).defaultPrevented).toBe(false);
  });

  it('leaves out bar lines while the toggle is off', async () => {
    const { tabExportText } = await import('../../src/ui/tab-export');
    const copy = install(fakeSession(), { barLines: false });
    press(document.body, 'C', { ctrlKey: true, shiftKey: true });
    const visible = notes.slice(2) as unknown as Parameters<typeof tabExportText>[1];
    expect(copy).toHaveBeenCalledWith(tabExportText(take, visible, false));
  });

  it("reads Bar lines from settingsSession's prefs by default (the Tab screen's default store)", async () => {
    const { settingsSession } = await import('../../src/session/settings-session');
    const { tabExportText } = await import('../../src/ui/tab-export');
    const real = settingsSession.getSnapshot();
    const spy = vi.spyOn(settingsSession, 'getSnapshot');
    window.location.hash = '#/tab/t1';
    const copy = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    const session = fakeSession();
    remove = installShortcuts(
      window,
      tabExportShortcuts(() => session, undefined, copy),
      () => false,
    );
    const visible = notes.slice(2) as unknown as Parameters<typeof tabExportText>[1];
    for (const barLines of [false, true]) {
      spy.mockReturnValue({ ...real, prefs: { ...real.prefs, barLines } });
      press(document.body, 'C', { ctrlKey: true, shiftKey: true });
      expect(copy).toHaveBeenLastCalledWith(tabExportText(take, visible, barLines));
    }
    spy.mockRestore();
  });

  it('does nothing in a text field, the Trim strip, under an overlay, or with no tab shown', async () => {
    const copy = install(fakeSession());
    const input = add('input');
    expect(press(input, 'C', { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    const strip = add('section', { 'data-trim-strip': '' });
    const handle = strip.appendChild(document.createElement('div'));
    expect(press(handle, 'C', { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    const { openOverlay } = await import('../../src/ui/a11y/overlays');
    const popover = add('div');
    popover.appendChild(document.createElement('button'));
    const release = openOverlay({ element: popover, opener: null, onDismiss: () => {} });
    expect(press(document.body, 'C', { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(
      false,
    );
    release();
    expect(copy).not.toHaveBeenCalled();
    remove();
    for (const over of [
      { analysis: { kind: 'running', progress: 0.2 } },
      { tab: { notes: notes.slice(0, 2) } }, // all hidden by the trim: No notes found
      { missing: true },
    ] as Partial<TakeSnapshot>[]) {
      const none = install(fakeSession(over));
      expect(press(document.body, 'C', { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(
        false,
      );
      expect(none).not.toHaveBeenCalled();
      remove();
    }
    const elsewhere = install(fakeSession(), { hash: '#/library' });
    expect(press(document.body, 'C', { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(
      false,
    );
    expect(elsewhere).not.toHaveBeenCalled();
  });
});

describe('story "Shell reflow, focus and shortcuts help"', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    window.location.hash = '';
  });

  it('registers `?` as a global entry allowing Shift', () => {
    expect(SHORTCUTS.filter((s) => s.key === '?')).toEqual([
      expect.objectContaining({
        route: 'global',
        shiftOk: true,
        description: 'Show keyboard shortcuts',
      }),
    ]);
  });

  it('`?` opens the dialog (with or without Shift), naming the focused element as opener', () => {
    const open = vi.fn<(opener: HTMLElement | null) => void>();
    const entry = helpShortcut(open);
    const button = add('button');
    button.focus();
    const event = new KeyboardEvent('keydown', { key: '?', shiftKey: true, cancelable: true });
    expect(dispatchShortcut(event, 'library', [entry])).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(open).toHaveBeenLastCalledWith(button);
    button.blur();
    const plain = new KeyboardEvent('keydown', { key: '?', cancelable: true });
    expect(dispatchShortcut(plain, null, [entry])).toBe(true);
    expect(open).toHaveBeenLastCalledWith(null);
  });

  it('`?` is guarded in a text field: it types', () => {
    const open = vi.fn<(opener: HTMLElement | null) => void>();
    window.location.hash = '#/library';
    const remove = installShortcuts(window, [helpShortcut(open)]);
    const event = press(add('input', { type: 'search' }), '?', { shiftKey: true });
    remove();
    expect(open).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('the count-in Esc fires from a text field; a field that handled Esc keeps it', () => {
    const stop = vi.fn(() => Promise.resolve());
    const entry = cancelCountIn({
      getSnapshot: () =>
        ({
          mic: 'live',
          recording: 'count-in',
          countIn: { on: true, bpm: 40 },
        }) as RecordingSnapshot,
      stop,
    });
    expect(entry.textFieldOk).toBe(true);
    window.location.hash = '#/settings';
    const remove = installShortcuts(window, [entry]);
    const field = add('input', { type: 'number' });
    const event = press(field, 'Escape');
    expect(stop).toHaveBeenCalledWith('user');
    expect(event.defaultPrevented).toBe(true);
    stop.mockClear();
    field.addEventListener('keydown', (e) => e.preventDefault());
    press(field, 'Escape');
    remove();
    expect(stop).not.toHaveBeenCalled();
  });

  it('other entries stay guarded in a text field', () => {
    expect(guarded(document.createElement('input'), 'Escape')).toBe(true);
    expect(guarded(document.createElement('input'), 'Escape', true)).toBe(false);
  });

  it('listing-only entries never dispatch', () => {
    const listed = SHORTCUTS.filter((s) => !s.handler);
    expect(listed.map((s) => [s.key, s.mod ?? null, s.group ?? s.route, s.description])).toEqual([
      ['Escape', null, 'global', 'Close dialog, popover or panel'],
      ['ArrowLeft', null, 'tab', 'Move between toolbar buttons'],
      ['ArrowRight', null, 'tab', 'Move between toolbar buttons'],
      ['Home', null, 'tab', 'First / last toolbar button'],
      ['End', null, 'tab', 'First / last toolbar button'],
      ['ArrowLeft', null, 'trim', 'Nudge 10 ms'],
      ['ArrowRight', null, 'trim', 'Nudge 10 ms'],
      ['ArrowLeft', 'shift', 'trim', 'Nudge 100 ms'],
      ['ArrowRight', 'shift', 'trim', 'Nudge 100 ms'],
    ]);
    for (const entry of listed) {
      const event = new KeyboardEvent('keydown', {
        key: entry.key,
        shiftKey: entry.mod === 'shift',
        cancelable: true,
      });
      expect(dispatchShortcut(event, 'tab', listed)).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    }
  });

  it('groups the registry: Global, Record, Tab, Trim handle; same descriptions merged', () => {
    const groups = shortcutGroups(SHORTCUTS, false);
    expect(groups.map((g) => g.title)).toEqual(['Global', 'Record', 'Tab', 'Trim handle']);
    const rows = Object.fromEntries(
      groups.map((g) => [g.title, g.rows.map((r) => [r.keys.join(' / '), r.description])]),
    );
    expect(rows).toEqual({
      Global: [
        ['?', 'Show keyboard shortcuts'],
        ['Esc', 'Cancel count-in'],
        ['Esc', 'Close dialog, popover or panel'],
      ],
      Record: [['Space', 'Record / stop']],
      Tab: [
        ['←', 'Previous note'],
        ['→', 'Next note'],
        ['Esc', 'Clear note selection'],
        ['N', 'Next note to check'],
        ['Space', 'Play / pause'],
        ['P', 'Seek playback to selected note'],
        ['0–9', 'Set fret; two digits within 400 ms make one number'],
        ['Ctrl+Z', 'Undo'],
        ['Ctrl+Shift+Z / Ctrl+Y', 'Redo'],
        ['↑', 'Move note to the next thinner string, same pitch'],
        ['↓', 'Move note to the next thicker string, same pitch'],
        ['Delete / Backspace', 'Delete note'],
        ['I', 'Insert note after selection'],
        ['Enter', 'Confirm selected note (clears flag, locks it)'],
        ['Ctrl+Shift+C', 'Copy tab'],
        ['← / →', 'Move between toolbar buttons'],
        ['Home / End', 'First / last toolbar button'],
      ],
      'Trim handle': [
        ['← / →', 'Nudge 10 ms'],
        ['Shift+← / Shift+→', 'Nudge 100 ms'],
      ],
    });
    // Every description appears once, in exactly one group.
    const all = groups.flatMap((g) => g.rows.map((r) => r.description));
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(all)).toEqual(new Set(SHORTCUTS.map((s) => s.description)));
  });

  it('labels the command modifier ⌘ on a Mac (Ctrl+Y stays Ctrl)', () => {
    const tab = shortcutGroups(SHORTCUTS, true).find((g) => g.id === 'tab')!;
    const keys = (description: string) => tab.rows.find((r) => r.description === description)!.keys;
    expect(keys('Undo')).toEqual(['⌘+Z']);
    expect(keys('Redo')).toEqual(['⌘+Shift+Z', 'Ctrl+Y']);
    expect(keys('Copy tab')).toEqual(['⌘+Shift+C']);
    expect(keyLabel({ key: 'ArrowRight', mod: 'shift' }, true)).toBe('Shift+→');
  });

  it('leaves out groups with no entries', () => {
    const only: Shortcut[] = [{ key: 'x', route: 'tab', description: 'X', handler: () => {} }];
    expect(shortcutGroups(only, false)).toEqual([
      { id: 'tab', title: 'Tab', rows: [{ keys: ['X'], description: 'X' }] },
    ]);
  });
});
