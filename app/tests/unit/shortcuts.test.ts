import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordingSnapshot } from '../../src/session/recording-session';
import {
  cancelCountIn,
  dispatchShortcut,
  guarded,
  installShortcuts,
  RECORD_KEYDOWN_MARK,
  recordToggle,
  SHORTCUTS,
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
  it('registers Space on Record with a description', () => {
    const space = SHORTCUTS.filter((s) => s.key === ' ');
    expect(space).toHaveLength(1);
    expect(space[0]).toMatchObject({ route: 'record', description: 'Record / stop' });
  });

  it("registers Esc as a global entry: Cancel count-in, ahead of the Tab screen's Esc", () => {
    const esc = SHORTCUTS.filter((s) => s.key === 'Escape');
    expect(esc).toHaveLength(2);
    expect(esc[0]).toMatchObject({ route: 'global', description: 'Cancel count-in' });
    expect(esc[1]).toMatchObject({ route: 'tab', description: 'Clear note selection' });
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

    it('a start clears stale marks, then sets one record-keydown', () => {
      performance.mark(RECORD_KEYDOWN_MARK);
      performance.mark('record-capture-start');
      toggleWith('idle').toggle();
      expect(performance.getEntriesByName(RECORD_KEYDOWN_MARK)).toHaveLength(1);
      expect(performance.getEntriesByName('record-capture-start')).toHaveLength(0);
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
      analysis: { kind: 'idle' },
      ...over,
    } as unknown as TakeSnapshot;
    return {
      getSnapshot: () => snapshot,
      select: vi.fn(),
      selectNext: vi.fn(),
      selectPrev: vi.fn(),
      // As the real session: the next flagged note after the selection, else after `from`,
      // else from the start, wrapping.
      selectNextFlagged: vi.fn((from?: string | null) => {
        const current = snapshot.selectedNoteId ?? from ?? null;
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
    const tab = SHORTCUTS.filter((s) => s.route === 'tab');
    expect(tab.map((s) => [s.key, s.description])).toEqual([
      ['ArrowLeft', 'Previous note'],
      ['ArrowRight', 'Next note'],
      ['Escape', 'Clear note selection'],
      ['n', 'Next note to check'],
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
    expect(session.selectNextFlagged).toHaveBeenCalledWith(null);
    expect(document.activeElement).toBe(buttons[2]);
    buttons[0]!.focus();
    press(buttons[0]!, 'n');
    expect(session.selectNextFlagged).toHaveBeenLastCalledWith('n0');
    expect(document.activeElement).toBe(buttons[2]);
    press(add('button'), 'n'); // e.g. Next to check itself
    expect(session.selectNextFlagged).toHaveBeenCalledTimes(3);
  });

  it('N starts from the focused note with nothing selected, and works with Caps Lock (N)', () => {
    const session = fakeSession(null, 4, {}, [0, 2]);
    install(session);
    const buttons = area(4);
    buttons[1]!.focus();
    expect(press(buttons[1]!, 'N').defaultPrevented).toBe(true);
    expect(session.selectNextFlagged).toHaveBeenCalledWith('n1');
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

  it('in the tab area → selects the next note, ← the previous, from the focused note', () => {
    const session = fakeSession(null);
    install(session);
    const button = note('n1');
    const right = press(button, 'ArrowRight');
    const left = press(button, 'ArrowLeft');
    expect(session.selectNext).toHaveBeenCalledWith('n1');
    expect(session.selectPrev).toHaveBeenCalledWith('n1');
    expect(right.defaultPrevented && left.defaultPrevented).toBe(true);
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

  it('Esc clears a selection from the tab area or the body; with none it is left to the page', () => {
    const session = fakeSession('n1');
    install(session);
    expect(press(document.body, 'Escape').defaultPrevented).toBe(true);
    expect(press(note('n1'), 'Escape').defaultPrevented).toBe(true);
    expect(session.select).toHaveBeenCalledTimes(2);
    expect(session.select).toHaveBeenCalledWith(null);
    expect(press(add('button'), 'Escape').defaultPrevented).toBe(false);
    expect(session.select).toHaveBeenCalledTimes(2);
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
});
