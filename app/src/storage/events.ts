// Storage change events (spine AD-5). Every committed write in storage/ emits exactly one
// event per changed aggregate, after the transaction commits and never on rollback. Events
// carry ids, never payloads; a store ignores events whose `writer` is itself.

import type { TakeWriter } from '../model/types';

export type StorageEvent =
  | { type: 'take-put'; takeId: string; writer: TakeWriter }
  | { type: 'take-deleted'; takeId: string; writer: TakeWriter }
  | { type: 'tab-put'; takeId: string; writer: TakeWriter }
  | { type: 'library-restored'; count: number; writer: 'restore' };

export type StorageListener = (event: StorageEvent) => void;

const listeners = new Set<StorageListener>();

/** Listens to every storage event. Returns the unsubscribe function. */
export function subscribe(listener: StorageListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Storage-internal: delivers one event to every listener. A throwing listener does not stop
 * the others; its error is rethrown asynchronously so it still surfaces.
 */
export function emit(event: StorageEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (err) {
      queueMicrotask(() => {
        throw err;
      });
    }
  }
}
