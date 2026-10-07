// The Keyboard shortcuts dialog's open state (EXPERIENCE.md :89). One host, `ShortcutsDialogHost`
// in the shell, renders the dialog while it is open; the registry's `?` and Settings' About
// button open it through `openShortcutsDialog`, naming where focus returns when it closes.

export interface ShortcutsDialogState {
  open: boolean;
  /** Where focus returns on close: the element that had it when the dialog opened. */
  opener: HTMLElement | null;
}

const CLOSED: ShortcutsDialogState = { open: false, opener: null };

let state: ShortcutsDialogState = CLOSED;
const listeners = new Set<() => void>();

function set(next: ShortcutsDialogState): void {
  state = next;
  for (const listener of [...listeners]) listener();
}

/** Opens the dialog (a no-op while it is open); focus returns to `opener` on close. */
export function openShortcutsDialog(opener: HTMLElement | null): void {
  if (state.open) return;
  set({ open: true, opener });
}

/** Closes the dialog, if open. */
export function closeShortcutsDialog(): void {
  if (!state.open) return;
  set(CLOSED);
}

export function getShortcutsDialog(): ShortcutsDialogState {
  return state;
}

export function subscribeShortcutsDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
