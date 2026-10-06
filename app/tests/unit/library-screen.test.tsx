import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { LibraryRow } from '../../src/model/library';
import type { LibrarySnapshot } from '../../src/session/library-session';
import { Library } from '../../src/ui/screens/Library';

// Story "Library list (tracer)" (US-7.1): the Library screen's states and row markup, with
// library-session replaced by a fixed snapshot.

afterEach(cleanup);

function fakeSession(snapshot: LibrarySnapshot) {
  return { subscribe: () => () => {}, getSnapshot: () => snapshot };
}

const recorded: LibraryRow = {
  id: 't1',
  title: 'Take 2026-09-28 10:52',
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
