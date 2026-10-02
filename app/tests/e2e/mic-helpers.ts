import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/**
 * Counts every `getUserMedia` call from page start: wraps the native method and any
 * replacement later defined on `navigator.mediaDevices` (the dev fake mic's). Call before
 * `goto`; read with `gumCalls`. The count resets on reload.
 */
export async function countGetUserMedia(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __gumCalls: number };
    w.__gumCalls = 0;
    const wrap = (fn: (...args: unknown[]) => unknown) =>
      function (this: unknown, ...args: unknown[]) {
        w.__gumCalls += 1;
        return fn.apply(this, args);
      };
    const proto = MediaDevices.prototype as unknown as {
      getUserMedia: (...args: unknown[]) => unknown;
    };
    proto.getUserMedia = wrap(proto.getUserMedia);
    const define = Object.defineProperty;
    Object.defineProperty = function <T>(
      target: T,
      key: PropertyKey,
      desc: PropertyDescriptor & ThisType<unknown>,
    ): T {
      if (target instanceof MediaDevices && key === 'getUserMedia' && desc.value) {
        desc = { ...desc, value: wrap(desc.value) };
      }
      return define(target, key, desc);
    } as typeof Object.defineProperty;
  });
}

export function gumCalls(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __gumCalls: number }).__gumCalls);
}

/** Axe on the page: no serious or critical violations. */
export async function expectNoSeriousAxe(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const serious = violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  expect(serious).toEqual([]);
}
