import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Take } from '../../src/model/types';
import { LISTING_ONLY } from '../../src/ui/a11y/shortcuts';
import { TrimStrip } from '../../src/ui/components/TrimStrip';
import { strings } from '../../src/ui/strings';

// Story "Refactor sweep" (7.10 triage): the `?` dialog's Trim handle entries (`group: 'trim'`,
// listing-only in ui/a11y/shortcuts.ts) are written by hand, apart from TrimStrip's own key
// handling. This test fails when a key a Trim handle handles is not listed, or a listed one is
// not handled.

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
  trimStartMs: 1_000,
  trimEndMs: 3_000,
  settings: { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 },
  analysisVersion: '0.4.0',
  updatedAt: '2026-10-04T10:00:04.000Z',
};

/**
 * Keys a handle handles that the listing leaves out on purpose: Home and End, the standard
 * slider keys, which EXPERIENCE.md's shortcut table does not list (adding them is a copy change,
 * deferred to UX by the refactor sweep). Shift does not change them.
 */
const NOT_LISTED = new Set(['Home', 'End', 'Shift+Home', 'Shift+End']);

/**
 * The keys probed on a handle: every named key a slider could take, and the printable ones.
 * Esc is the strip's own (it closes the strip, whatever has focus inside it), not a handle's.
 */
const CANDIDATES = [
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Enter',
  ' ',
  'Tab',
  'Backspace',
  'Delete',
  'Insert',
  ...'abcdefghijklmnopqrstuvwxyz0123456789+-=[],./'.split(''),
];

/** The modifier combinations probed: none, Shift, and each of Ctrl, Alt and Meta (alone). */
const MODIFIERS = [
  {},
  { shiftKey: true },
  { ctrlKey: true },
  { altKey: true },
  { metaKey: true },
] as const satisfies readonly KeyboardEventInit[];

/** A key with its modifiers, e.g. `Shift+ArrowLeft`. */
const label = (key: string, mods: KeyboardEventInit) =>
  [
    mods.ctrlKey && 'Ctrl+',
    mods.altKey && 'Alt+',
    mods.metaKey && 'Meta+',
    mods.shiftKey && 'Shift+',
    key,
  ]
    .filter(Boolean)
    .join('');

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

/** The keys (with each probed modifier) a Trim handle handles: their default is prevented. */
function handledKeys(): Set<string> {
  render(
    <TrimStrip
      take={TAKE}
      lockedShown={false}
      running={null}
      onSave={vi.fn()}
      onReset={vi.fn()}
      onCancel={vi.fn()}
      onEscape={vi.fn()}
      loadPeaks={() => new Promise(() => {})}
      releasePeaks={vi.fn()}
    />,
  );
  const handled = new Set<string>();
  for (const name of [strings['tab.trimStart'], strings['tab.trimEnd']]) {
    const handle = screen.getByRole('slider', { name });
    for (const key of CANDIDATES)
      for (const mods of MODIFIERS)
        if (!fireEvent.keyDown(handle, { key, ...mods })) handled.add(label(key, mods));
  }
  return handled;
}

/** The Trim handle keys the `?` dialog lists. */
function listedKeys(): Set<string> {
  const trim = LISTING_ONLY.filter((s) => s.group === 'trim');
  for (const s of trim) expect(s.mod === undefined || s.mod === 'shift', s.key).toBe(true);
  return new Set(trim.map((s) => label(s.key, { shiftKey: s.mod === 'shift' })));
}

describe("the `?` dialog's Trim handle listing", () => {
  it('lists every key a Trim handle handles (bar the unlisted slider keys)', () => {
    const handled = handledKeys();
    expect(handled.size).toBeGreaterThan(0);
    const listed = listedKeys();
    const missing = [...handled].filter((k) => !listed.has(k) && !NOT_LISTED.has(k));
    expect(missing).toEqual([]);
  });

  it('lists no key a Trim handle does not handle', () => {
    const handled = handledKeys();
    expect([...listedKeys()].filter((k) => !handled.has(k))).toEqual([]);
  });

  it('the unlisted slider keys are still handled and still unlisted', () => {
    const handled = handledKeys();
    const listed = listedKeys();
    for (const k of NOT_LISTED) {
      expect(handled.has(k), k).toBe(true);
      expect(listed.has(k), k).toBe(false);
    }
  });
});
