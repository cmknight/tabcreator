import { afterEach, describe, expect, it, vi } from 'vitest';
import { resumeWithin, within } from '../../src/audio/context-resume';

// Refactor sweep: resuming an AudioContext without hanging on it (`audio/context-resume.ts`),
// shared by the recorder, the encoder and the dev fake mic.

afterEach(() => {
  vi.useRealTimers();
});

describe('within', () => {
  it('true when the promise settles in time, resolved or rejected', async () => {
    await expect(within(Promise.resolve(), 1000)).resolves.toBe(true);
    await expect(within(Promise.reject(new Error('x')), 1000)).resolves.toBe(true);
  });

  it('false after ms when the promise never settles', async () => {
    vi.useFakeTimers();
    const result = within(new Promise(() => {}), 1000);
    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    void result.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(false);
  });
});

/** A context whose `resume` is `resume`, starting in `state`. */
function context(state: AudioContextState, resume: () => Promise<void>) {
  const ctx = { state, resume: vi.fn(resume) };
  return ctx;
}

describe('resumeWithin', () => {
  it('a running context: true, resume never called', async () => {
    const ctx = context('running', () => Promise.resolve());
    await expect(resumeWithin(ctx as unknown as AudioContext, 1000)).resolves.toBe(true);
    expect(ctx.resume).not.toHaveBeenCalled();
  });

  it('a suspended context that resumes: true', async () => {
    const ctx = context('suspended', async () => {
      ctx.state = 'running';
    });
    await expect(resumeWithin(ctx as unknown as AudioContext, 1000)).resolves.toBe(true);
    expect(ctx.resume).toHaveBeenCalledTimes(1);
  });

  it('a resume that rejects: false, never rejects', async () => {
    const ctx = context('suspended', () => Promise.reject(new Error('closed')));
    await expect(resumeWithin(ctx as unknown as AudioContext, 1000)).resolves.toBe(false);
  });

  it('a resume that stays pending: false after ms', async () => {
    vi.useFakeTimers();
    const ctx = context('suspended', () => new Promise(() => {}));
    const result = resumeWithin(ctx as unknown as AudioContext, 2000);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(result).resolves.toBe(false);
  });
});
