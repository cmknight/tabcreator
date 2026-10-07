import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isOverlayOpen } from '../../src/ui/a11y/overlays';
import { SHORTCUTS, shortcutGroups } from '../../src/ui/a11y/shortcuts';
import {
  returnTarget,
  ShortcutsDialog,
  ShortcutsDialogHost,
} from '../../src/ui/components/ShortcutsDialog';
import {
  closeShortcutsDialog,
  getShortcutsDialog,
  openShortcutsDialog,
} from '../../src/ui/shortcuts-dialog';
import { act } from 'react';

// Story "Shell reflow, focus and shortcuts help" (EXPERIENCE.md :89; mockup settings.html): the
// Keyboard shortcuts dialog renders from the registry, one table per group, Close focused.

afterEach(() => {
  act(() => closeShortcutsDialog());
  cleanup();
  document.body.innerHTML = '';
});

describe('ShortcutsDialog', () => {
  it('is a modal dialog titled Keyboard shortcuts, with Close focused and the note', () => {
    render(<ShortcutsDialog opener={null} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(within(dialog).getByRole('heading', { level: 2 }).textContent).toBe(
      'Keyboard shortcuts',
    );
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close' }));
    expect(within(dialog).getAllByRole('button')).toHaveLength(1);
    expect(dialog.textContent).toContain(
      "Shortcuts don't fire while you are typing in a field, except Esc cancelling a count-in.",
    );
    expect(screen.getByRole('region', { name: 'Shortcut list' }).getAttribute('tabindex')).toBe(
      '0',
    );
    expect(isOverlayOpen()).toBe(true);
  });

  it('lists every registry description once, in its group, keys in row headers', () => {
    render(<ShortcutsDialog opener={null} onClose={() => {}} />);
    const tables = screen.getAllByRole('table');
    const groups = shortcutGroups();
    expect(tables.map((t) => t.querySelector('caption')?.textContent)).toEqual(
      groups.map((g) => g.title),
    );
    const listed = tables.flatMap((t) => [...t.querySelectorAll('td')].map((td) => td.textContent));
    expect(listed).toHaveLength(new Set(listed).size);
    expect(new Set(listed)).toEqual(new Set(SHORTCUTS.map((s) => s.description)));
    for (const th of tables.flatMap((t) => [...t.querySelectorAll('th')])) {
      expect(th.getAttribute('scope')).toBe('row');
      expect(th.querySelector('kbd')).not.toBeNull();
    }
    const fret = screen.getByRole('cell', {
      name: 'Set fret; two digits within 400 ms make one number',
    });
    expect(fret.closest('tr')!.querySelector('th')!.textContent).toBe('0–9');
    const del = screen.getByRole('cell', { name: 'Delete note' });
    expect([...del.closest('tr')!.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual([
      'Delete',
      'Backspace',
    ]);
  });

  it('Close and Esc call onClose', () => {
    const onClose = vi.fn();
    render(<ShortcutsDialog opener={null} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('ShortcutsDialogHost', () => {
  it('opens on openShortcutsDialog and returns focus to the opener on Esc', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    render(<ShortcutsDialogHost />);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => openShortcutsDialog(opener));
    expect(screen.getByRole('dialog')).toBeTruthy();
    // A second open while open changes nothing.
    act(() => openShortcutsDialog(null));
    expect(getShortcutsDialog().opener).toBe(opener);
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(isOverlayOpen()).toBe(false);
    expect(document.activeElement).toBe(opener);
  });
});

describe('focus return', () => {
  it('a note button re-created while the dialog is open gets focus back on Esc', () => {
    const area = document.createElement('div');
    area.setAttribute('role', 'application');
    document.body.append(area);
    const note = document.createElement('button');
    note.setAttribute('data-note-id', 'n7');
    area.append(note);
    note.focus();
    render(<ShortcutsDialogHost />);
    act(() => openShortcutsDialog(note));
    expect(screen.getByRole('dialog')).toBeTruthy();
    // A reflow replaces the note's button.
    const replacement = document.createElement('button');
    replacement.setAttribute('data-note-id', 'n7');
    note.replaceWith(replacement);
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(replacement);
  });

  it('with no opener (`?` from <body>) focus goes to main', () => {
    const main = document.createElement('main');
    main.tabIndex = -1;
    document.body.append(main);
    expect(returnTarget(null)).toBe(main);
    render(<ShortcutsDialogHost />);
    act(() => openShortcutsDialog(null));
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(main);
  });

  it('unmounting the host closes the dialog', () => {
    const { unmount } = render(<ShortcutsDialogHost />);
    act(() => openShortcutsDialog(null));
    expect(getShortcutsDialog().open).toBe(true);
    unmount();
    expect(getShortcutsDialog().open).toBe(false);
  });
});
