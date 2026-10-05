import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { collectErrors } from './helpers';

/** The fake mic fixture the recording specs play by default (7.95 s at 48 kHz). */
export const FIXTURE = 'c_major_scale_pos1';

/**
 * `fixtures` with the dev-only `holdAnalysis` switch, for `goLive` (story 5.6): the Tab screen
 * analyses every stopped take, deleting its raw file and moving it to `analyzed` moments later,
 * so tests that read a stopped take's raw file or `recorded` status hold analysis.
 */
export const held = (fixtures: string = FIXTURE) => `${fixtures}&holdAnalysis`;

/** The live input level meter. */
export const meter = (page: Page) => page.getByRole('meter', { name: 'Input level' });

/**
 * Opens Record with the dev fake mic playing `fixtures` (`?fakeMic=`, which may carry more
 * `&key=value` dev params; `null` opens it without, for the production lane's real capture
 * device), clicks Allow microphone and waits for the meter. Returns the console and page errors collected from before the `goto`. `before` runs
 * once Allow microphone shows, just before it is clicked (the app renders only once the fake mic
 * is installed). Set up init scripts (`countGetUserMedia`, probes) before calling this.
 */
export async function goLive(
  page: Page,
  fixtures: string | null = FIXTURE,
  { before }: { before?: () => Promise<void> } = {},
): Promise<string[]> {
  const errors = collectErrors(page);
  await page.goto(fixtures === null ? './#/record' : `./?fakeMic=${fixtures}#/record`);
  const allow = page.getByRole('button', { name: 'Allow microphone' });
  if (before) {
    await expect(allow).toBeVisible();
    await before();
  }
  await allow.click();
  await expect(meter(page)).toBeVisible();
  return errors;
}

/** One `getUserMedia` call, as `countGetUserMedia` logs it. */
export interface GumCall {
  /** The `deviceId` constraint, as JSON. */
  deviceId: string;
  /** How many tracks from earlier calls were still live when this call was made. */
  liveBefore: number;
}

/**
 * Counts and logs every `getUserMedia` call from page start: wraps the native method and any
 * replacement later defined on `navigator.mediaDevices` (the dev fake mic's). Each call is logged
 * with its device constraint and how many tracks from earlier calls were still live at that
 * moment. Call before `goto`; read with `gumCalls` and `gumLog`. Both reset on reload.
 */
export async function countGetUserMedia(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __gumCalls: number; __gumLog: GumCall[] };
    w.__gumCalls = 0;
    w.__gumLog = [];
    const tracks: MediaStreamTrack[] = [];
    const wrap = (fn: (...args: unknown[]) => unknown) =>
      function (this: unknown, ...args: unknown[]) {
        w.__gumCalls += 1;
        const constraints = args[0] as MediaStreamConstraints | undefined;
        const audio = typeof constraints?.audio === 'object' ? constraints.audio : {};
        w.__gumLog.push({
          deviceId: JSON.stringify(audio.deviceId ?? null),
          liveBefore: tracks.filter((t) => t.readyState === 'live').length,
        });
        const result = fn.apply(this, args);
        void Promise.resolve(result).then(
          (stream) => tracks.push(...(stream as MediaStream).getTracks()),
          () => {},
        );
        return result;
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

/** How many times `getUserMedia` was called (`countGetUserMedia`). */
export function gumCalls(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __gumCalls: number }).__gumCalls);
}

/** Every `getUserMedia` call, in order (`countGetUserMedia`). */
export function gumLog(page: Page): Promise<GumCall[]> {
  return page.evaluate(() => (window as unknown as { __gumLog: GumCall[] }).__gumLog);
}

/** Axe on the page: no serious or critical violations. */
export async function expectNoSeriousAxe(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const serious = violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  expect(serious).toEqual([]);
}
