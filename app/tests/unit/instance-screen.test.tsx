import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { instanceLock } from '../../src/session/instance-lock';
import { InstanceScreen } from '../../src/ui/components/InstanceScreen';

// Story 3.10: the full-screen instance notices.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('instance screen', () => {
  it('other tab: the heading takes focus; Use here calls useHere; the status line is empty', () => {
    const useHere = vi.spyOn(instanceLock, 'useHere').mockImplementation(() => {});
    render(<InstanceScreen state="other-tab" />);
    const heading = screen.getByRole('heading', { name: 'TabCreator is open in another tab' });
    expect(document.activeElement).toBe(heading);
    expect(screen.getByRole('status').textContent).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Use here' }));
    expect(useHere).toHaveBeenCalledTimes(1);
  });

  it('handing over: Use here aria-disabled and inert, with "Moving TabCreator here…"', () => {
    const useHere = vi.spyOn(instanceLock, 'useHere').mockImplementation(() => {});
    render(<InstanceScreen state="handing-over" />);
    const button = screen.getByRole('button', { name: 'Use here' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('Moving TabCreator here…');
    fireEvent.click(button);
    expect(useHere).not.toHaveBeenCalled();
  });

  it('upgrade blocked and unsupported: their notice only, with no Use here', () => {
    render(<InstanceScreen state="upgrade-blocked" />);
    expect(
      screen.getByRole('heading', { name: 'Close other TabCreator tabs to finish updating' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    render(<InstanceScreen state="unsupported" />);
    expect(
      screen.getByRole('heading', { name: 'TabCreator needs a recent desktop Chrome' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
