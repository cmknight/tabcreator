import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRoute, routeToHash, useRoute } from './router';

describe('parseRoute', () => {
  it.each([
    ['#/record', { name: 'record' }],
    ['#/library', { name: 'library' }],
    ['#/tuner', { name: 'tuner' }],
    ['#/settings', { name: 'settings' }],
    ['#/tab/abc', { name: 'tab', takeId: 'abc' }],
    ['#/tab/a%20b', { name: 'tab', takeId: 'a b' }],
  ])('parses %s', (hash, route) => {
    expect(parseRoute(hash)).toEqual(route);
  });

  it.each(['', '#', '#/', '#/nope', '#/tab/', '#/tab', '#/tab/a/b', '#/record/x', '#/tab/%E0'])(
    'returns null for %j',
    (hash) => {
      expect(parseRoute(hash)).toBeNull();
    },
  );

  it('round-trips through routeToHash', () => {
    expect(parseRoute(routeToHash({ name: 'tab', takeId: 'a/b c' }))).toEqual({
      name: 'tab',
      takeId: 'a/b c',
    });
  });
});

describe('useRoute', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '#');
  });

  function setHash(hash: string) {
    act(() => {
      window.location.hash = hash;
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
  }

  it.each(['', '#/', '#/nope', '#/tab/'])('falls back from %j to #/record', (hash) => {
    window.history.replaceState(null, '', hash || window.location.pathname);
    const { result } = renderHook(() => useRoute());
    expect(result.current).toEqual({ name: 'record' });
    expect(window.location.hash).toBe('#/record');
  });

  it('follows hashchange', () => {
    window.history.replaceState(null, '', '#/record');
    const { result } = renderHook(() => useRoute());
    setHash('#/library');
    expect(result.current).toEqual({ name: 'library' });
    setHash('#/tab/abc');
    expect(result.current).toEqual({ name: 'tab', takeId: 'abc' });
    setHash('#/nope');
    expect(result.current).toEqual({ name: 'record' });
    expect(window.location.hash).toBe('#/record');
  });
});
