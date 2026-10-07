import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastHost } from '../../src/ui/components/ToastHost';
import { strings } from '../../src/ui/strings';
import { dismissToast, getToast, showToast, subscribeToast, TOAST_MS } from '../../src/ui/toast';
import { Announcer } from '../../src/ui/a11y/announcer';
import {
  BUSY_POLL_MS,
  RELOAD_SETTLE_MS,
  startUpdatePrompt,
  type UpdatePromptDeps,
} from '../../src/ui/update-prompt';

// Story "Update available prompt" (EXPERIENCE.md "Update available", spine AD-19): the persistent
// toast, shown only while an update waits and the app is idle, offered again after busy or
// after a toast that replaced it, and Reload through the guarded update reload.

const updateToast = () => {
  const t = getToast();
  return t?.message === strings['global.updateAvailable'] ? t : null;
};

function setup(initial: { available?: boolean; busy?: boolean } = {}) {
  const state = { available: initial.available ?? false, busy: initial.busy ?? false };
  const listeners = new Set<() => void>();
  const visibles = new Set<() => void>();
  const reload = vi.fn(() => Promise.resolve(true));
  const deps: UpdatePromptDeps = {
    update: {
      isUpdateAvailable: () => state.available,
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
    isBusy: () => state.busy,
    reload,
    toast: { show: showToast, dismiss: dismissToast, get: getToast, subscribe: subscribeToast },
    setInterval: (run, ms) => setInterval(run, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    setTimeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    onVisible: (l) => {
      visibles.add(l);
      return () => visibles.delete(l);
    },
  };
  const stop = startUpdatePrompt(deps);
  const markAvailable = () => {
    state.available = true;
    for (const l of [...listeners]) l();
  };
  const becomeVisible = () => [...visibles].forEach((l) => l());
  return { state, stop, reload, markAvailable, becomeVisible };
}

/** Lets queued microtasks (the prompt's toast-change handling) run. */
const microtasks = () => act(async () => {});
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe('update prompt', () => {
  let stop: (() => void) | null = null;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    stop?.();
    stop = null;
    act(() => dismissToast());
    cleanup();
    vi.useRealTimers();
  });

  it('nothing while no update waits', async () => {
    ({ stop } = setup());
    await advance(5 * BUSY_POLL_MS);
    expect(getToast()).toBeNull();
  });

  it('an update while idle: the persistent "Update available — Reload" toast, which stays', async () => {
    render(<ToastHost />);
    const s = setup();
    stop = s.stop;
    act(() => s.markAvailable());
    expect(updateToast()).toMatchObject({
      message: strings['global.updateAvailable'],
      action: { label: strings['global.reload'] },
      persistent: true,
    });
    expect(screen.getByTestId('toast').textContent).toBe('Update availableReload');
    await advance(TOAST_MS * 10);
    expect(screen.queryByTestId('toast')).not.toBeNull();
  });

  it('marked available twice: one toast, not re-shown', () => {
    const s = setup();
    stop = s.stop;
    s.markAvailable();
    const first = getToast()!.id;
    s.markAvailable();
    expect(getToast()!.id).toBe(first);
  });

  it('not while busy; shown once the app turns idle (polled)', async () => {
    const s = setup({ available: true, busy: true });
    stop = s.stop;
    expect(getToast()).toBeNull();
    await advance(3 * BUSY_POLL_MS);
    expect(getToast()).toBeNull();
    s.state.busy = false;
    await advance(BUSY_POLL_MS);
    expect(updateToast()).not.toBeNull();
  });

  it('hidden when the app turns busy, offered again when idle', async () => {
    const s = setup({ available: true });
    stop = s.stop;
    expect(updateToast()).not.toBeNull();
    s.state.busy = true;
    await advance(BUSY_POLL_MS);
    expect(getToast()).toBeNull();
    s.state.busy = false;
    await advance(BUSY_POLL_MS);
    expect(updateToast()).not.toBeNull();
  });

  it('replaced by another toast: returns when that one goes; a busy-time toast is left alone', async () => {
    render(<ToastHost />);
    const s = setup({ available: true });
    stop = s.stop;
    act(() => showToast({ message: 'Tab copied' }));
    await microtasks();
    expect(getToast()?.message).toBe('Tab copied');
    s.state.busy = true;
    await advance(BUSY_POLL_MS);
    expect(getToast()?.message).toBe('Tab copied'); // not the prompt's to dismiss
    s.state.busy = false;
    await advance(TOAST_MS);
    expect(updateToast()).not.toBeNull();
  });

  it('Reload: the guarded update reload runs once, and the prompt is not offered meanwhile', async () => {
    render(<ToastHost />);
    const s = setup({ available: true });
    stop = s.stop;
    await microtasks(); // rendered
    s.reload.mockReturnValueOnce(new Promise<boolean>(() => {})); // the page is going
    act(() => screen.getByRole('button', { name: strings['global.reload'] }).click());
    await microtasks();
    await advance(5 * BUSY_POLL_MS);
    expect(s.reload).toHaveBeenCalledTimes(1);
    expect(getToast()).toBeNull();
  });

  it('Reload refused (busy): the reloadBusy toast, then the prompt again once it goes', async () => {
    render(<ToastHost />);
    const s = setup({ available: true });
    stop = s.stop;
    await microtasks(); // rendered
    s.reload.mockResolvedValueOnce(false);
    act(() => screen.getByRole('button', { name: strings['global.reload'] }).click());
    await microtasks();
    expect(getToast()?.message).toBe(strings['global.reloadBusy']);
    await advance(TOAST_MS);
    expect(updateToast()).not.toBeNull();
  });

  it('Reload went ahead but the page stayed (unload cancelled): offered again after a while', async () => {
    render(<ToastHost />);
    const s = setup({ available: true });
    stop = s.stop;
    await microtasks();
    act(() => screen.getByRole('button', { name: strings['global.reload'] }).click());
    await microtasks();
    await advance(RELOAD_SETTLE_MS - BUSY_POLL_MS);
    expect(getToast()).toBeNull();
    await advance(BUSY_POLL_MS);
    expect(updateToast()).not.toBeNull();
  });

  it('close (×): hidden until the page next becomes visible', async () => {
    render(<ToastHost />);
    const s = setup({ available: true });
    stop = s.stop;
    await microtasks();
    act(() => screen.getByRole('button', { name: strings['global.updateDismiss'] }).click());
    await microtasks();
    await advance(5 * BUSY_POLL_MS);
    expect(getToast()).toBeNull();
    act(() => s.becomeVisible());
    expect(updateToast()).not.toBeNull();
  });

  it('announced on its first showing only; offered again silently', async () => {
    render(
      <>
        <ToastHost />
        <Announcer />
      </>,
    );
    const s = setup({ available: true });
    stop = s.stop;
    await microtasks();
    expect(updateToast()?.silent).toBe(false);
    act(() => vi.advanceTimersToNextFrame());
    const polite = () => document.querySelector('[aria-live="polite"]')?.textContent ?? '';
    expect(polite()).toBe(strings['global.updateAvailable']);
    s.state.busy = true;
    await advance(BUSY_POLL_MS);
    expect(getToast()).toBeNull();
    s.state.busy = false;
    await advance(BUSY_POLL_MS);
    expect(updateToast()?.silent).toBe(true);
  });

  it('stop removes a shown prompt', () => {
    const s = setup({ available: true });
    expect(updateToast()).not.toBeNull();
    s.stop();
    expect(getToast()).toBeNull();
  });
});
