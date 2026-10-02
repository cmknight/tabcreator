import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/model/errors';
import { createRecordingSession, type RecordingDeps } from '../../src/session/recording-session';

const stream = {} as MediaStream;
const analyser = {} as AnalyserNode;

function setup(overrides: Partial<RecordingDeps> = {}) {
  const input = { analyser, readRms: vi.fn(() => 0.25), close: vi.fn() };
  const deps = {
    requestMic: vi.fn(() => Promise.resolve(stream)),
    openInput: vi.fn(() => input),
    updatePrefs: vi.fn(),
    ...overrides,
  };
  const session = createRecordingSession(deps);
  const listener = vi.fn();
  session.subscribe(listener);
  return { session, deps, input, listener };
}

describe('recording session', () => {
  it('starts in setup without touching the mic', () => {
    const { session, deps } = setup();
    expect(session.getSnapshot()).toEqual({ mic: 'setup' });
    expect(session.readLevel()).toBe(0);
    expect(session.getAnalyser()).toBeNull();
    expect(deps.requestMic).not.toHaveBeenCalled();
  });

  it('goes setup → requesting → live, opens the input and records micGranted', async () => {
    const { session, deps, listener } = setup();
    const done = session.allowMic();
    expect(session.getSnapshot()).toEqual({ mic: 'requesting' });
    await done;
    expect(session.getSnapshot()).toEqual({ mic: 'live' });
    expect(deps.requestMic).toHaveBeenCalledTimes(1);
    expect(deps.openInput).toHaveBeenCalledWith(stream);
    expect(deps.updatePrefs).toHaveBeenCalledWith({ micGranted: true });
    expect(session.readLevel()).toBe(0.25);
    expect(session.getAnalyser()).toBe(analyser);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('requests once even when Allow is clicked again while requesting or live', async () => {
    const { session, deps } = setup();
    const first = session.allowMic();
    await session.allowMic();
    await first;
    await session.allowMic();
    expect(deps.requestMic).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().mic).toBe('live');
  });

  it('maps a rejection to error with mic-failed, and allows a later retry', async () => {
    const requestMic = vi
      .fn<RecordingDeps['requestMic']>()
      .mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
      .mockResolvedValueOnce(stream);
    const { session, deps } = setup({ requestMic });
    await session.allowMic();
    expect(session.getSnapshot()).toEqual({ mic: 'error', errorCode: 'mic-failed' });
    expect(deps.updatePrefs).not.toHaveBeenCalled();
    expect(session.readLevel()).toBe(0);

    await session.allowMic();
    expect(requestMic).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot()).toEqual({ mic: 'live' });
  });

  it("keeps an AppError's code from audio/", async () => {
    const { session } = setup({
      openInput: vi.fn(() => {
        throw new AppError('mic-failed', 'graph');
      }),
    });
    await session.allowMic();
    expect(session.getSnapshot()).toEqual({ mic: 'error', errorCode: 'mic-failed' });
  });

  it('stays live when saving micGranted fails', async () => {
    const { session } = setup({
      updatePrefs: vi.fn(() => {
        throw new AppError('storage-full', 'full');
      }),
    });
    await session.allowMic();
    expect(session.getSnapshot()).toEqual({ mic: 'live' });
  });

  it('stops notifying after unsubscribe', async () => {
    const { session } = setup();
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);
    unsubscribe();
    await session.allowMic();
    expect(listener).not.toHaveBeenCalled();
  });
});
