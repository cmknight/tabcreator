import { describe, expect, it, vi } from 'vitest';
import { quietly, quietlySync } from '../../src/model/quietly';

// Refactor sweep: the shared best-effort helpers (`model/quietly.ts`).

describe('quietly', () => {
  it('runs the step and waits for it', async () => {
    const order: string[] = [];
    await quietly(async () => {
      await Promise.resolve();
      order.push('step');
    });
    order.push('after');
    expect(order).toEqual(['step', 'after']);
  });

  it('ignores a rejection and a synchronous throw', async () => {
    await expect(quietly(() => Promise.reject(new Error('x')))).resolves.toBeUndefined();
    await expect(
      quietly(() => {
        throw new Error('y');
      }),
    ).resolves.toBeUndefined();
  });
});

describe('quietlySync', () => {
  it('runs the step and ignores a throw', () => {
    const step = vi.fn();
    quietlySync(step);
    expect(step).toHaveBeenCalledTimes(1);
    expect(() =>
      quietlySync(() => {
        throw new Error('z');
      }),
    ).not.toThrow();
  });
});
