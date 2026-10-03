import { describe, expect, it, vi } from 'vitest';
import { reloadUnlessBusy } from '../../src/session/app-reload';
import type { RecordingSnapshot, RecordingState } from '../../src/session/recording-session';

// Story 3.7 (spine AD-16, AD-19): an app reload is refused while a take is in progress.

const session = (recording: RecordingState) => ({
  getSnapshot: () => ({ recording }) as RecordingSnapshot,
});

describe('reloadApp guard', () => {
  it.each(['count-in', 'starting', 'recording', 'stopping'] as const)(
    'does not reload while %s, and returns false',
    (state) => {
      const reload = vi.fn();
      expect(reloadUnlessBusy(session(state), reload)).toBe(false);
      expect(reload).not.toHaveBeenCalled();
    },
  );

  it('reloads when idle, and returns true', () => {
    const reload = vi.fn();
    expect(reloadUnlessBusy(session('idle'), reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
