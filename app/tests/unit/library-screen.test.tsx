import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchKey, type LibraryRow } from '../../src/model/library';
import { announce } from '../../src/ui/a11y/announcer';
import type { BackupResult, LibrarySnapshot } from '../../src/session/library-session';
import { downloadBlob } from '../../src/ui/platform';
import { Library } from '../../src/ui/screens/Library';
import { dismissToast, getToast } from '../../src/ui/toast';

// Story "Library list (tracer)" (US-7.1): the Library screen's states and row markup, with
// library-session replaced by a fixed snapshot.

afterEach(cleanup);

vi.mock('../../src/ui/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ui/platform')>()),
  downloadBlob: vi.fn(),
}));

vi.mock('../../src/ui/a11y/announcer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ui/a11y/announcer')>()),
  announce: vi.fn(),
}));

/** A session with a fixed snapshot (`backup` null unless given) and spies for its writes. */
function fakeSession(given: Omit<LibrarySnapshot, 'backup'> & Partial<LibrarySnapshot>) {
  const snapshot: LibrarySnapshot = { backup: null, ...given };
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    rename: vi.fn(async () => {}),
    deleteTake: vi.fn(async () => {}),
    deleteAudio: vi.fn(async () => {}),
    backUp: vi.fn(async (): Promise<BackupResult | null> => null),
  };
}

const recorded: LibraryRow = {
  id: 't1',
  title: 'Take 2026-09-28 10:52',
  searchKey: 'take 2026-09-28 10:52',
  createdAt: '2026-09-28T10:52:00.000Z',
  status: 'recorded',
  durationMs: 182_000,
  noteCount: null,
  sizeBytes: 2_900_000,
  audioDeleted: false,
  preview: null,
  opens: true,
};

it('a failed read shows the alert and no empty state', () => {
  render(<Library session={fakeSession({ loading: false, rows: [], error: 'storage-failed' })} />);
  expect(screen.getByRole('alert').textContent).toContain("Couldn't load your takes");
  expect(screen.queryByText('No takes yet')).toBeNull();
});

it('loading with no rows shows the loading line and no empty state', () => {
  render(<Library session={fakeSession({ loading: true, rows: [], error: null })} />);
  const line = screen.getByText('Loading takes…');
  expect(line.getAttribute('aria-busy')).toBe('true');
  expect(screen.queryByText('No takes yet')).toBeNull();
});

it('an empty library shows "No takes yet" and Record', () => {
  render(<Library session={fakeSession({ loading: false, rows: [], error: null })} />);
  expect(screen.getByRole('heading', { name: 'No takes yet' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Record' }).getAttribute('href')).toBe('#/record');
});

it('a recorded row: Not analysed, its size, no note count, "—"; the link is named by the title', () => {
  render(<Library session={fakeSession({ loading: false, rows: [recorded], error: null })} />);
  const link = screen.getByRole('link', { name: 'Take 2026-09-28 10:52' });
  expect(link.getAttribute('href')).toBe('#/tab/t1');
  const text = link.textContent ?? '';
  expect(text).toContain('Not analysed');
  expect(text).toContain('3:02 · 2.9 MB');
  expect(text).not.toMatch(/notes?\b/);
  expect(text).toContain('—');
  const described = (link.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent);
  expect(described[0]).toBe('Not analysed');
  expect(described[1]).toContain('2.9 MB');
  expect(described[2]).toBe('—');
});

it('a recording row shows no duration and is not a link', () => {
  const row: LibraryRow = {
    ...recorded,
    status: 'recording',
    durationMs: 0,
    sizeBytes: null,
    opens: false,
  };
  render(<Library session={fakeSession({ loading: false, rows: [row], error: null })} />);
  expect(screen.queryByRole('link', { name: row.title })).toBeNull();
  expect(screen.getByText('Recording')).toBeTruthy();
  expect(document.body.textContent).not.toContain('0:00');
});

// Story "Rename, delete take and delete audio" (6.2): the row menu, inline rename and the
// delete dialogs, with library-session's writes as spies.
describe('row actions', () => {
  const analysed: LibraryRow = {
    ...recorded,
    id: 't2',
    title: 'Blues lick in A',
    searchKey: 'blues lick in a',
    status: 'analyzed',
    noteCount: 64,
    preview: 'G|5 G|7',
  };

  function renderRows(rows: LibraryRow[]) {
    const session = fakeSession({ loading: false, rows, error: null });
    const view = render(<Library session={session} />);
    return { session, view };
  }
  const kebab = (title: string) =>
    screen.getByRole('button', { name: `More actions for ${title}` });
  const items = () => screen.queryAllByRole('menuitem').map((i) => i.textContent);
  function openMenu(title: string) {
    fireEvent.click(kebab(title));
    return screen.getByRole('menu', { name: `Actions for ${title}` });
  }

  it('the "⋯" button: named for the row, a menu popup, collapsed; none on a recording row', () => {
    const recording: LibraryRow = {
      ...recorded,
      id: 't3',
      title: 'Rec',
      status: 'recording',
      opens: false,
    };
    renderRows([analysed, recording]);
    const button = kebab('Blues lick in A');
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'More actions for Rec' })).toBeNull();
  });

  it('an analysed row: Rename, Delete audio only, a separator, Delete take; focus on Rename', () => {
    renderRows([analysed]);
    const menu = openMenu('Blues lick in A');
    expect(kebab('Blues lick in A').getAttribute('aria-expanded')).toBe('true');
    expect(items()).toEqual(['Rename', 'Delete audio only', 'Delete take']);
    expect(menu.querySelector('[role="separator"]')).toBeTruthy();
    expect(document.activeElement?.textContent).toBe('Rename');
  });

  it('an unanalysed row, or one whose audio is gone, has no Delete audio only', () => {
    renderRows([recorded, { ...analysed, audioDeleted: true, sizeBytes: null }]);
    openMenu(recorded.title);
    expect(items()).toEqual(['Rename', 'Delete take']);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    openMenu('Blues lick in A');
    expect(items()).toEqual(['Rename', 'Delete take']);
  });

  it('↑/↓ move between items (wrapping); Esc closes and focus returns to the "⋯" button', () => {
    renderRows([analysed]);
    openMenu('Blues lick in A');
    const key = (k: string) => fireEvent.keyDown(document.activeElement!, { key: k });
    key('ArrowDown');
    expect(document.activeElement?.textContent).toBe('Delete audio only');
    key('ArrowDown');
    expect(document.activeElement?.textContent).toBe('Delete take');
    key('ArrowDown');
    expect(document.activeElement?.textContent).toBe('Rename');
    key('ArrowUp');
    expect(document.activeElement?.textContent).toBe('Delete take');
    key('Escape');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(kebab('Blues lick in A'));
    expect(kebab('Blues lick in A').getAttribute('aria-expanded')).toBe('false');
  });

  it('an outside pointer-down closes it; a second click on "⋯" closes it too', () => {
    renderRows([analysed]);
    openMenu('Blues lick in A');
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    openMenu('Blues lick in A');
    fireEvent.pointerDown(kebab('Blues lick in A'));
    fireEvent.click(kebab('Blues lick in A'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Rename: the title becomes a focused, selected field; Enter saves through the session', () => {
    const { session } = renderRows([analysed]);
    openMenu('Blues lick in A');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const field = screen.getByRole('textbox', { name: 'Take title' }) as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe('Blues lick in A');
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, field.value.length]);
    expect(screen.queryByRole('link', { name: 'Blues lick in A' })).toBeNull();
    fireEvent.change(field, { target: { value: 'Blues' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(session.rename).toHaveBeenCalledWith('t2', 'Blues');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.activeElement).toBe(kebab('Blues lick in A'));
  });

  it('Rename: Esc cancels with nothing written; blur saves', () => {
    const { session } = renderRows([analysed]);
    openMenu('Blues lick in A');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    let field = screen.getByRole('textbox', { name: 'Take title' });
    fireEvent.change(field, { target: { value: 'Nope' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(session.rename).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.activeElement).toBe(kebab('Blues lick in A'));

    openMenu('Blues lick in A');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    field = screen.getByRole('textbox', { name: 'Take title' });
    fireEvent.change(field, { target: { value: 'Blurred' } });
    fireEvent.blur(field);
    expect(session.rename).toHaveBeenCalledTimes(1);
    expect(session.rename).toHaveBeenCalledWith('t2', 'Blurred');
  });

  it('Delete take: the dialog names the take; Cancel is first and focused; Cancel and Esc change nothing', () => {
    const { session } = renderRows([analysed]);
    openMenu('Blues lick in A');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete take' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete "Blues lick in A"?' });
    expect(dialog.textContent).toContain(
      "Its tab and recording are removed from this computer. This can't be undone.",
    );
    const buttons = [...dialog.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toEqual(['Cancel', 'Delete take']);
    expect(document.activeElement?.textContent).toBe('Cancel');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(kebab('Blues lick in A'));

    openMenu('Blues lick in A');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete take' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(kebab('Blues lick in A'));
    expect(session.deleteTake).not.toHaveBeenCalled();
  });

  it('Delete take confirmed: deleteTake; the row going with focus in it moves focus to the heading', () => {
    const { session, view } = renderRows([analysed]);
    openMenu('Blues lick in A');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete take' }));
    const confirm = screen.getAllByRole('button', { name: 'Delete take' }).at(-1)!;
    fireEvent.click(confirm);
    expect(session.deleteTake).toHaveBeenCalledWith('t2');
    expect(document.activeElement).toBe(kebab('Blues lick in A'));
    // The take-deleted event removes the row.
    act(() => {
      view.rerender(<Library session={fakeSession({ loading: false, rows: [], error: null })} />);
    });
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Library' }));
  });

  it('Delete audio only: its dialog; Cancel changes nothing; confirmed, deleteAudio', () => {
    const { session } = renderRows([analysed]);
    openMenu('Blues lick in A');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete audio only' }));
    const dialog = screen.getByRole('alertdialog', {
      name: 'Delete the audio of "Blues lick in A"?',
    });
    expect(dialog.textContent).toContain(
      "Its recording is removed from this computer; the tab stays. This can't be undone.",
    );
    expect([...dialog.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Cancel',
      'Delete audio',
    ]);
    expect(document.activeElement?.textContent).toBe('Cancel');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(session.deleteAudio).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(kebab('Blues lick in A'));

    openMenu('Blues lick in A');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete audio only' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete audio' }));
    expect(session.deleteAudio).toHaveBeenCalledWith('t2');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('the "⋯" button controls the open menu by id', () => {
    renderRows([analysed]);
    expect(kebab('Blues lick in A').getAttribute('aria-controls')).toBeNull();
    const menu = openMenu('Blues lick in A');
    expect(menu.id).not.toBe('');
    expect(kebab('Blues lick in A').getAttribute('aria-controls')).toBe(menu.id);
  });

  it('Tab and Shift+Tab close the menu (no trap): focus is on "⋯" to move on from', () => {
    renderRows([analysed]);
    for (const shiftKey of [false, true]) {
      openMenu('Blues lick in A');
      const event = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        document.activeElement!.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(kebab('Blues lick in A'));
    }
  });

  it('a window scroll or resize closes the menu', () => {
    renderRows([analysed]);
    for (const type of ['scroll', 'resize']) {
      openMenu('Blues lick in A');
      act(() => {
        window.dispatchEvent(new Event(type));
      });
      expect(screen.queryByRole('menu')).toBeNull();
    }
  });

  it('the row removed while its menu or a dialog is open: focus goes to the heading', () => {
    for (const open of ['menu', 'dialog'] as const) {
      const { view } = renderRows([analysed]);
      openMenu('Blues lick in A');
      if (open === 'dialog') {
        fireEvent.click(screen.getByRole('menuitem', { name: 'Delete take' }));
        expect(screen.getByRole('alertdialog')).toBeTruthy();
      }
      act(() => {
        view.rerender(<Library session={fakeSession({ loading: false, rows: [], error: null })} />);
      });
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Library' }));
      cleanup();
    }
  });

  it('Rename: an unedited field saves nothing (Enter or blur); the trimmed draft is capped at save', () => {
    const { session } = renderRows([analysed]);
    openMenu('Blues lick in A');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    openMenu('Blues lick in A');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    fireEvent.blur(screen.getByRole('textbox'));
    expect(session.rename).not.toHaveBeenCalled();

    openMenu('Blues lick in A');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const field = screen.getByRole('textbox') as HTMLInputElement;
    const long = '  ' + 'x'.repeat(120) + '  ';
    fireEvent.change(field, { target: { value: long } });
    expect(field.value).toBe(long); // not capped while typing
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(session.rename).toHaveBeenCalledWith('t2', 'x'.repeat(100));
  });

  it('a failed write shows its toast', async () => {
    const { session } = renderRows([analysed]);
    session.rename.mockRejectedValueOnce(new Error('x'));
    session.deleteTake.mockRejectedValueOnce(new Error('x'));
    session.deleteAudio.mockRejectedValueOnce(new Error('x'));

    openMenu('Blues lick in A');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Blues' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await act(async () => {});
    expect(getToast()?.message).toBe("Couldn't rename the take");

    openMenu('Blues lick in A');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete take' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete take' }).at(-1)!);
    await act(async () => {});
    expect(getToast()?.message).toBe("Couldn't delete the take");

    openMenu('Blues lick in A');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete audio only' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete audio' }));
    await act(async () => {});
    expect(getToast()?.message).toBe("Couldn't delete the audio");
    dismissToast();
  });
});

// Story "Search 500 takes" (6.3): the search field, no match, Clear search, the announced count,
// live updates during a search and the virtualised list.
describe('search', () => {
  const mk = (i: number, title: string): LibraryRow => ({
    ...recorded,
    id: `s${i}`,
    title,
    searchKey: searchKey(title),
    createdAt: new Date(Date.UTC(2026, 8, 1) - i * 60_000).toISOString(),
  });

  /** A session whose snapshot can change, notifying the screen like library-session. */
  function liveSession(rows: LibraryRow[]) {
    let snapshot: LibrarySnapshot = { loading: false, rows, error: null, backup: null };
    const listeners = new Set<() => void>();
    const session = {
      ...fakeSession(snapshot),
      subscribe: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      getSnapshot: () => snapshot,
    };
    const set = (next: LibraryRow[]) =>
      act(() => {
        snapshot = { ...snapshot, rows: next };
        for (const l of listeners) l();
      });
    return { session, set };
  }

  const field = () => screen.getByRole('searchbox', { name: 'Search takes' }) as HTMLInputElement;
  const type = (q: string) => fireEvent.change(field(), { target: { value: q } });
  const listed = () =>
    screen.queryAllByRole('listitem').map((li) => li.querySelector('[id$="-title"]')?.textContent);

  const cafe = mk(1, 'Café Blues');
  const riff = mk(2, 'Riff');
  const lick = mk(3, 'blues lick');

  it('the field: type search, named and placeholdered "Search takes", above the list', () => {
    render(<Library session={fakeSession({ loading: false, rows: [cafe], error: null })} />);
    expect(field().type).toBe('search');
    expect(field().placeholder).toBe('Search takes');
    expect(field().disabled).toBe(false);
    expect(
      field().compareDocumentPosition(screen.getByRole('list')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('accents and case: "cafe" lists only Café Blues; "BLUES" matches blues lick too', () => {
    render(
      <Library session={fakeSession({ loading: false, rows: [cafe, riff, lick], error: null })} />,
    );
    type('cafe');
    expect(listed()).toEqual(['Café Blues']);
    type('BLUES');
    expect(listed()).toEqual(['Café Blues', 'blues lick']);
    type('   ');
    expect(listed()).toEqual(['Café Blues', 'Riff', 'blues lick']);
  });

  it('no match: the sentence and Clear search, which empties and focuses the field', () => {
    render(<Library session={fakeSession({ loading: false, rows: [cafe, riff], error: null })} />);
    type('zzz');
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByRole('heading', { name: 'No takes match "zzz"' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(field().value).toBe('');
    expect(document.activeElement).toBe(field());
    expect(listed()).toEqual(['Café Blues', 'Riff']);
  });

  it('clearing by deleting the query brings every row back', () => {
    render(<Library session={fakeSession({ loading: false, rows: [cafe, riff], error: null })} />);
    type('riff');
    expect(listed()).toEqual(['Riff']);
    type('');
    expect(listed()).toEqual(['Café Blues', 'Riff']);
  });

  it('an empty library disables the field', () => {
    render(<Library session={fakeSession({ loading: false, rows: [], error: null })} />);
    expect(field().disabled).toBe(true);
  });

  it('live updates keep the query: a matching new take appears; a row renamed out disappears', () => {
    const { session, set } = liveSession([cafe, riff]);
    render(<Library session={session} />);
    type('blues');
    expect(listed()).toEqual(['Café Blues']);
    set([lick, cafe, riff]);
    expect(listed()).toEqual(['blues lick', 'Café Blues']);
    set([{ ...cafe, title: 'Jazz', searchKey: 'jazz' }, lick, riff]);
    expect(listed()).toEqual(['blues lick']);
    expect(field().value).toBe('blues');
  });

  it('the count is announced once typing settles: "2 takes", "1 take", the no-match sentence', () => {
    vi.useFakeTimers();
    try {
      vi.mocked(announce).mockClear();
      const { session, set } = liveSession([cafe, riff, lick]);
      render(<Library session={session} />);
      set([cafe, riff]); // a live update alone announces nothing
      act(() => vi.advanceTimersByTime(1000));
      expect(announce).not.toHaveBeenCalled();
      set([cafe, riff, lick]);
      type('b');
      act(() => vi.advanceTimersByTime(200));
      type('bl');
      act(() => vi.advanceTimersByTime(499));
      expect(announce).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1));
      expect(vi.mocked(announce).mock.calls).toEqual([['2 takes']]);
      type('riff');
      act(() => vi.advanceTimersByTime(500));
      type('zzz');
      act(() => vi.advanceTimersByTime(500));
      expect(vi.mocked(announce).mock.calls.slice(1)).toEqual([
        ['1 take'],
        ['No takes match "zzz"'],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the library emptying clears the query, moves focus from the field to the heading and announces nothing', () => {
    vi.useFakeTimers();
    try {
      vi.mocked(announce).mockClear();
      const { session, set } = liveSession([cafe, riff]);
      render(<Library session={session} />);
      act(() => field().focus());
      type('riff');
      set([]);
      expect(field().value).toBe('');
      expect(field().disabled).toBe(true);
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Library' }));
      act(() => vi.advanceTimersByTime(1000));
      expect(announce).not.toHaveBeenCalled();
      set([cafe]);
      expect(listed()).toEqual(['Café Blues']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a row title carries its full text as a tooltip (it may be cut with an ellipsis)', () => {
    render(<Library session={fakeSession({ loading: false, rows: [cafe], error: null })} />);
    expect(screen.getByText('Café Blues').getAttribute('title')).toBe('Café Blues');
  });

  describe('virtualised list', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => mk(i, `Take ${i}`));

    it('80 takes: every row rendered, positions and set size on each', () => {
      render(<Library session={fakeSession({ loading: false, rows: many(80), error: null })} />);
      const items = screen.getAllByRole('listitem');
      expect(items).toHaveLength(80);
      expect(screen.getByRole('list').getAttribute('role')).toBe('list');
      expect(items[0]!.getAttribute('aria-posinset')).toBe('1');
      expect(items[79]!.getAttribute('aria-posinset')).toBe('80');
      expect(items[79]!.getAttribute('aria-setsize')).toBe('80');
    });

    it('500 takes: only the rows near the viewport, the rest held by the list height', () => {
      render(<Library session={fakeSession({ loading: false, rows: many(500), error: null })} />);
      const items = screen.getAllByRole('listitem');
      expect(items.length).toBeGreaterThan(0);
      expect(items.length).toBeLessThanOrEqual(40);
      expect(items[0]!.getAttribute('aria-posinset')).toBe('1');
      expect(items[0]!.getAttribute('aria-setsize')).toBe('500');
      const list = screen.getByRole('list') as HTMLElement;
      // The unrendered rows after the last rendered one are its bottom padding.
      expect(parseFloat(list.style.paddingBlockEnd)).toBeGreaterThan(0);
    });

    it('scrolling renders the rows at the new position', () => {
      render(<Library session={fakeSession({ loading: false, rows: many(500), error: null })} />);
      const list = screen.getByRole('list');
      // The list's top 20 000 px above the viewport (rows 80 px tall before measuring): row 250.
      const rect = vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({
        top: -20_000,
      } as DOMRect);
      act(() => {
        window.dispatchEvent(new Event('scroll'));
      });
      const pos = screen
        .getAllByRole('listitem')
        .map((li) => Number(li.getAttribute('aria-posinset')));
      expect(pos[0]).toBe(241);
      expect(pos).toContain(260);
      expect(pos.length).toBeLessThanOrEqual(40);
      // Its first row's top margin stands for the 240 rows above it.
      expect(screen.getAllByRole('listitem')[0]!.style.marginBlockStart).toBe(`${240 * 80}px`);
      rect.mockRestore();
    });

    it('a row with its menu open stays rendered when scrolled away', () => {
      render(<Library session={fakeSession({ loading: false, rows: many(500), error: null })} />);
      fireEvent.click(screen.getByRole('button', { name: 'More actions for Take 0' }));
      expect(screen.getByRole('menu', { name: 'Actions for Take 0' })).toBeTruthy();
      const list = screen.getByRole('list');
      vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({ top: -20_000 } as DOMRect);
      act(() => {
        window.dispatchEvent(new Event('scroll'));
      });
      // The scroll closes the menu; focus goes back to the row's "⋯" button, which keeps it.
      expect(screen.queryByRole('menu')).toBeNull();
      const kebab = screen.getByRole('button', { name: 'More actions for Take 0' });
      expect(document.activeElement).toBe(kebab);
      expect(kebab.getAttribute('aria-expanded')).toBe('false');
      expect(positions()).toEqual([1, ...range(241, positions().length - 1)]);
    });

    const positions = () =>
      screen.getAllByRole('listitem').map((li) => Number(li.getAttribute('aria-posinset')));
    const range = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => from + i);
    function scrollAway() {
      vi.spyOn(screen.getByRole('list'), 'getBoundingClientRect').mockReturnValue({
        top: -20_000,
      } as DOMRect);
      act(() => {
        window.dispatchEvent(new Event('scroll'));
      });
    }

    it('a focused row stays rendered when scrolled away; once focus leaves, it goes', () => {
      render(<Library session={fakeSession({ loading: false, rows: many(500), error: null })} />);
      const link = screen.getByRole('link', { name: 'Take 2' });
      act(() => link.focus());
      scrollAway();
      expect(positions()[0]).toBe(3);
      expect(document.activeElement).toBe(link);
      expect(positions().slice(1)).toEqual(range(241, positions().length - 1));
      act(() => screen.getByRole('searchbox').focus());
      expect(positions()[0]).toBe(241);
    });

    it('a focused row stays rendered when the window loses focus', () => {
      render(<Library session={fakeSession({ loading: false, rows: many(500), error: null })} />);
      const link = screen.getByRole('link', { name: 'Take 2' });
      act(() => link.focus());
      const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
      fireEvent.focusOut(link, { relatedTarget: null });
      scrollAway();
      expect(positions()[0]).toBe(3);
      hasFocus.mockRestore();
    });

    it('a row with its Confirm dialog open stays rendered when scrolled away', () => {
      const session = fakeSession({ loading: false, rows: many(500), error: null });
      render(<Library session={session} />);
      fireEvent.click(screen.getByRole('button', { name: 'More actions for Take 4' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete take' }));
      const dialog = screen.getByRole('alertdialog', { name: 'Delete "Take 4"?' });
      scrollAway();
      expect(positions()[0]).toBe(5);
      expect(screen.getByRole('alertdialog')).toBe(dialog);
      fireEvent.click(screen.getAllByRole('button', { name: 'Delete take' }).at(-1)!);
      expect(session.deleteTake).toHaveBeenCalledWith('s4');
    });

    it('a row being renamed stays rendered when scrolled away', () => {
      const { session } = {
        session: fakeSession({ loading: false, rows: many(500), error: null }),
      };
      render(<Library session={session} />);
      fireEvent.click(screen.getByRole('button', { name: 'More actions for Take 3' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
      const input = screen.getByRole('textbox', { name: 'Take title' });
      const list = screen.getByRole('list');
      vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({ top: -20_000 } as DOMRect);
      act(() => {
        window.dispatchEvent(new Event('scroll'));
      });
      expect(screen.getByRole('textbox', { name: 'Take title' })).toBe(input);
      fireEvent.change(input, { target: { value: 'Renamed' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(session.rename).toHaveBeenCalledWith('s3', 'Renamed');
    });
  });
});

// Story "Back up the library" (6.5): the button, the progress bar, the download and the toasts.
describe('Back up library', () => {
  afterEach(() => {
    dismissToast();
    vi.mocked(downloadBlob).mockClear();
    vi.mocked(announce).mockClear();
  });

  const button = () => screen.getByRole('button', { name: 'Back up library' });

  it('is disabled with no takes (loading or empty) or only recording ones, enabled with takes', () => {
    const view = render(
      <Library session={fakeSession({ loading: true, rows: [], error: null })} />,
    );
    expect((button() as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<Library session={fakeSession({ loading: false, rows: [], error: null })} />);
    expect((button() as HTMLButtonElement).disabled).toBe(true);
    const recording: LibraryRow = { ...recorded, id: 'r', status: 'recording', opens: false };
    view.rerender(
      <Library session={fakeSession({ loading: false, rows: [recording], error: null })} />,
    );
    expect((button() as HTMLButtonElement).disabled).toBe(true);
    view.rerender(
      <Library
        session={fakeSession({ loading: false, rows: [recording, recorded], error: null })}
      />,
    );
    expect((button() as HTMLButtonElement).disabled).toBe(false);
    expect(button().getAttribute('aria-disabled')).toBeNull();
    expect(screen.queryByTestId('backup-progress')).toBeNull();
  });

  it('downloads the result through platform; no toast when nothing was missing', async () => {
    const session = fakeSession({ loading: false, rows: [recorded], error: null });
    const blob = new Blob(['zip']);
    session.backUp.mockResolvedValueOnce({
      blob,
      fileName: 'tabcreator-backup-20261006.zip',
      takes: 1,
      missingAudio: 0,
      unsupportedAudio: 0,
    });
    render(<Library session={session} />);
    await act(async () => fireEvent.click(button()));
    expect(session.backUp).toHaveBeenCalledTimes(1);
    expect(downloadBlob).toHaveBeenCalledWith('tabcreator-backup-20261006.zip', blob);
    expect(getToast()).toBeNull();
    // Announced politely: the start, then how many takes were backed up.
    expect(vi.mocked(announce).mock.calls).toEqual([['Backing up…'], ['Backed up 1 take']]);
  });

  it('unsupported audio formats: a toast with the count, with missing files too', async () => {
    const session = fakeSession({ loading: false, rows: [recorded], error: null });
    const result = {
      blob: new Blob([]),
      fileName: 'b.zip',
      takes: 3,
      missingAudio: 0,
      unsupportedAudio: 2,
    };
    session.backUp.mockResolvedValueOnce(result);
    render(<Library session={session} />);
    await act(async () => fireEvent.click(button()));
    expect(getToast()?.message).toBe('2 recordings in an unsupported format were left out');
    session.backUp.mockResolvedValueOnce({ ...result, missingAudio: 1, unsupportedAudio: 1 });
    await act(async () => fireEvent.click(button()));
    expect(getToast()?.message).toBe(
      'Backed up — 1 recording was missing · 1 recording in an unsupported format was left out',
    );
  });

  it('missing audio files: a toast with the count', async () => {
    const session = fakeSession({ loading: false, rows: [recorded], error: null });
    session.backUp.mockResolvedValueOnce({
      blob: new Blob([]),
      fileName: 'b.zip',
      takes: 3,
      missingAudio: 2,
      unsupportedAudio: 0,
    });
    render(<Library session={session} />);
    await act(async () => fireEvent.click(button()));
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    expect(getToast()?.message).toBe('Backed up — 2 recordings were missing');
  });

  it('a failure: a toast and an assertive announcement; nothing downloads', async () => {
    const session = fakeSession({ loading: false, rows: [recorded], error: null });
    session.backUp.mockRejectedValueOnce(new Error('worker'));
    render(<Library session={session} />);
    await act(async () => fireEvent.click(button()));
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(getToast()?.message).toBe("Couldn't back up the library");
    expect(announce).toHaveBeenCalledWith("Couldn't back up the library", 'assertive');
  });

  it('while a backup runs: "Backing up…" and the bar, the button disabled and a click ignored', () => {
    const session = fakeSession({
      loading: false,
      rows: [recorded],
      error: null,
      backup: { progress: 0.46 },
    });
    render(<Library session={session} />);
    const bar = screen.getByRole('progressbar', { name: 'Backing up…' });
    expect(bar.getAttribute('aria-valuetext')).toBe('46%');
    expect((bar as HTMLProgressElement).value).toBeCloseTo(0.46);
    expect(screen.getByTestId('backup-progress').textContent).toContain('46%');
    expect(button().getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button());
    expect(session.backUp).not.toHaveBeenCalled();
    // No Cancel.
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
  });

  it('while a backup runs, the row menu items are disabled with the reason "Backing up…"', () => {
    const analysed: LibraryRow = { ...recorded, id: 'a', status: 'analyzed', noteCount: 3 };
    const session = fakeSession({
      loading: false,
      rows: [analysed],
      error: null,
      backup: { progress: 0.1 },
    });
    render(<Library session={session} />);
    fireEvent.click(screen.getByRole('button', { name: `More actions for ${analysed.title}` }));
    const items = screen.getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Rename', 'Delete audio only', 'Delete take']);
    for (const item of items) {
      expect(item.getAttribute('aria-disabled')).toBe('true');
      const why = document.getElementById(item.getAttribute('aria-describedby')!);
      expect(why?.textContent).toBe('Backing up…');
      fireEvent.click(item);
    }
    // Nothing happened: no rename field, no dialog, the menu still open.
    expect(screen.queryByRole('textbox', { name: 'Take title' })).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(session.rename).not.toHaveBeenCalled();
  });
});
