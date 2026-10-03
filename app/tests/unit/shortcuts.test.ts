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
  type Shortcut,
} from '../../src/ui/a11y/shortcuts';

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

  it('registers Esc as a global entry: Cancel count-in', () => {
    const esc = SHORTCUTS.filter((s) => s.key === 'Escape');
    expect(esc).toHaveLength(1);
    expect(esc[0]).toMatchObject({ route: 'global', description: 'Cancel count-in' });
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

  it.each(['starting', 'stopping'] as const)('is ignored while %s', (recording) => {
    const s = store('live', recording);
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
