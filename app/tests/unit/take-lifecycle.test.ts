import { describe, expect, it } from 'vitest';
import {
  canTransition,
  createRecordingMachine,
  enterState,
  RECORDING_TRANSITIONS,
} from '../../src/session/take-lifecycle';
import type { RecordingState } from '../../src/session/recording-types';

// The take lifecycle's recording state machine: every change goes through the transition table,
// and one not in it is refused with the state unchanged.

const STATES: RecordingState[] = ['idle', 'count-in', 'starting', 'recording', 'stopping'];

/** A machine driven along allowed transitions to `target`. */
function machineAt(target: RecordingState) {
  const machine = createRecordingMachine();
  const path: Record<RecordingState, RecordingState[]> = {
    idle: [],
    'count-in': ['count-in'],
    starting: ['starting'],
    recording: ['starting', 'recording'],
    stopping: ['starting', 'recording', 'stopping'],
  };
  for (const next of path[target]) expect(machine.to(next)).toBe(true);
  expect(machine.state).toBe(target);
  return machine;
}

describe('recording state machine', () => {
  it('starts idle', () => {
    expect(createRecordingMachine().state).toBe('idle');
  });

  it('follows idle → count-in → starting → recording → stopping → idle', () => {
    const machine = createRecordingMachine();
    for (const next of ['count-in', 'starting', 'recording', 'stopping', 'idle'] as const) {
      expect(machine.to(next)).toBe(true);
      expect(machine.state).toBe(next);
    }
  });

  it('illegal transition: stopping → count-in is refused, the state unchanged', () => {
    const machine = machineAt('stopping');
    expect(machine.to('count-in')).toBe(false);
    expect(machine.state).toBe('stopping');
  });

  it('every transition not in the table is refused and leaves the state as it was', () => {
    for (const from of STATES) {
      for (const to of STATES) {
        const machine = machineAt(from);
        const allowed = from === to || RECORDING_TRANSITIONS[from].includes(to);
        expect(canTransition(from, to)).toBe(allowed);
        expect(machine.to(to)).toBe(allowed);
        expect(machine.state).toBe(allowed ? to : from);
      }
    }
  });

  it('refuses the skips: idle → recording or stopping, stopping → starting or recording', () => {
    expect(canTransition('idle', 'recording')).toBe(false);
    expect(canTransition('idle', 'stopping')).toBe(false);
    expect(canTransition('stopping', 'starting')).toBe(false);
    expect(canTransition('stopping', 'recording')).toBe(false);
    expect(canTransition('recording', 'count-in')).toBe(false);
  });

  it('every state can fall back to idle', () => {
    for (const from of STATES) expect(canTransition(from, 'idle')).toBe(true);
  });

  it('a refused transition throws in dev and test builds, naming both states', () => {
    expect(import.meta.env.DEV).toBe(true);
    const machine = machineAt('stopping');
    expect(() => enterState(machine, 'count-in')).toThrow(
      'Refused recording state transition: stopping → count-in',
    );
    expect(machine.state).toBe('stopping');
    expect(enterState(machine, 'idle')).toBe(true);
    expect(machine.state).toBe('idle');
  });
});
