// Confirmation toasts (DESIGN.md Toast; EXPERIENCE.md: confirmations only, never the only place
// an error appears). One toast at a time: a new one replaces the current one. `ToastHost`,
// mounted once in the shell, renders it, runs its timer and announces it.

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  message: string;
  action?: ToastAction;
  /**
   * Stays until its action, a replacement or `dismissToast` (no timer). Only the update prompt
   * (ui/update-prompt.ts), which must wait for the player and be offered again (spine AD-19);
   * every other toast auto-dismisses (DESIGN.md Toast).
   */
  persistent?: boolean;
  /**
   * A persistent toast's close (×) button: its accessible name (default `global.dismiss`) and
   * what closing it does besides removing it.
   */
  close?: { label: string; run: () => void };
  /** Shown without announcing it (an update prompt offered again; ui/update-prompt.ts). */
  silent?: boolean;
}

/** A shown toast; `id` changes on every `showToast`, so a repeat restarts the timer. */
export interface ShownToast extends Toast {
  id: number;
}

/** How long a toast stays up while not hovered or focused. */
export const TOAST_MS = 4000;

let current: ShownToast | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Shows `toast`, replacing any toast already shown. */
export function showToast(toast: Toast): void {
  current = { ...toast, id: nextId++ };
  emit();
}

/** Removes the current toast, if any. */
export function dismissToast(): void {
  if (current === null) return;
  current = null;
  emit();
}

export function subscribeToast(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getToast(): ShownToast | null {
  return current;
}
