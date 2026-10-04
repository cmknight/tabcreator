// The Tab screen's hook onto its take session (spine AD-3): one session per mounted take id (the
// screen is keyed by take id), read with useSyncExternalStore and disposed on unmount. Disposal
// detaches only; an analysis in flight carries on (spine AD-16).

import { useEffect, useState, useSyncExternalStore } from 'react';
import { createAppTakeSession, type TakeSession, type TakeSnapshot } from '../session/take-session';

export function useTakeSession(
  takeId: string,
  create: (takeId: string) => TakeSession = createAppTakeSession,
): TakeSnapshot {
  const [session] = useState(() => create(takeId));
  useEffect(() => () => session.dispose(), [session]);
  return useSyncExternalStore(session.subscribe, session.getSnapshot);
}
