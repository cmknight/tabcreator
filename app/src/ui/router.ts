import { useEffect, useSyncExternalStore } from 'react';

export type Route =
  | { name: 'record' }
  | { name: 'tab'; takeId: string }
  | { name: 'library' }
  | { name: 'tuner' }
  | { name: 'settings' };

export const DEFAULT_HASH = '#/record';

/** Parses a location hash. Returns `null` for anything that is not a known route. */
export function parseRoute(hash: string): Route | null {
  const path = hash.startsWith('#') ? hash.slice(1) : hash;
  switch (path) {
    case '/record':
      return { name: 'record' };
    case '/library':
      return { name: 'library' };
    case '/tuner':
      return { name: 'tuner' };
    case '/settings':
      return { name: 'settings' };
  }
  const tab = /^\/tab\/([^/]+)$/.exec(path);
  if (tab?.[1]) {
    let takeId: string;
    try {
      takeId = decodeURIComponent(tab[1]);
    } catch {
      return null;
    }
    return takeId ? { name: 'tab', takeId } : null;
  }
  return null;
}

export function routeToHash(route: Route): string {
  return route.name === 'tab' ? `#/tab/${encodeURIComponent(route.takeId)}` : `#/${route.name}`;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

function getHash(): string {
  return window.location.hash;
}

/**
 * Current route from `location.hash`, updated on `hashchange` (so browser
 * back/forward work). An empty or unknown hash is replaced with `#/record`
 * without adding a history entry.
 */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, getHash);
  const route = parseRoute(hash);
  const fallback = route === null && hash !== DEFAULT_HASH;
  useEffect(() => {
    if (!fallback) return;
    const oldURL = window.location.href;
    const url = new URL(oldURL);
    url.hash = DEFAULT_HASH;
    window.history.replaceState(window.history.state, '', url);
    // replaceState fires no hashchange; notify subscribers so the snapshot catches up.
    window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: url.href }));
  }, [fallback, hash]);
  return route ?? { name: 'record' };
}
