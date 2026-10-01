import { expect, test, type Page } from '@playwright/test';

// Runs in the `dev` project only: the fake mic (stories US-0.4) is installed by dev builds only.
// The storage test page is just a dev route to land on; the capture runs in page.evaluate, so no
// app code outside audio/ calls getUserMedia.

/** Collects console errors and warnings plus uncaught page errors. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

async function open(page: Page, search: string): Promise<string[]> {
  const errors = collectErrors(page);
  await page.goto(`./${search}#/__test/storage`);
  await expect(page.getByRole('heading', { name: 'Storage test page' })).toBeVisible();
  return errors;
}

/**
 * Captures 3 s from the fake mic and returns the device list and the capture's RMS in dBFS.
 * With `stopFirst`, a first stream is opened and stopped before the captured one.
 */
function capture(page: Page, stopFirst: boolean) {
  return page.evaluate(async (stopFirst) => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (stopFirst) {
      const first = await navigator.mediaDevices.getUserMedia({ audio: true });
      first.getTracks().forEach((track) => track.stop());
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new AudioContext();
    await ctx.resume();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    ctx.createMediaStreamSource(stream).connect(analyser);

    // Capture 3 s, reading a full analyser window about every 20 ms.
    const frame = new Float32Array(analyser.fftSize);
    let sumSquares = 0;
    let count = 0;
    const end = performance.now() + 3000;
    while (performance.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      analyser.getFloatTimeDomainData(frame);
      for (const v of frame) sumSquares += v * v;
      count += frame.length;
    }
    stream.getTracks().forEach((track) => track.stop());
    await ctx.close();
    return {
      devices: devices.map((d) => ({ kind: d.kind, label: d.label })),
      rmsDb: 10 * Math.log10(sumSquares / count),
    };
  }, stopFirst);
}

/** Calls getUserMedia with `constraints`; returns 'ok' or the rejection's DOMException name. */
function tryGetUserMedia(page: Page, constraints: MediaStreamConstraints) {
  return page.evaluate(async (constraints) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      stream.getTracks().forEach((track) => track.stop());
      return 'ok';
    } catch (err) {
      return err instanceof DOMException ? err.name : String(err);
    }
  }, constraints);
}

test('?fakeMic=open_strings serves the fixture as the microphone', async ({ page }) => {
  const errors = await open(page, '?fakeMic=open_strings');

  const result = await capture(page, false);

  expect(result.devices).toEqual([{ kind: 'audioinput', label: 'Fake mic: open_strings' }]);
  expect(result.rmsDb).toBeGreaterThan(-40);
  expect(errors).toEqual([]);
});

test("stopping one caller's stream leaves the next one playing", async ({ page }) => {
  const errors = await open(page, '?fakeMic=open_strings');

  const result = await capture(page, true);

  expect(result.rmsDb).toBeGreaterThan(-40);
  expect(errors).toEqual([]);
});

test('a video request rejects with NotFoundError', async ({ page }) => {
  const errors = await open(page, '?fakeMic=open_strings');

  expect(await tryGetUserMedia(page, { video: true })).toBe('NotFoundError');
  expect(errors).toEqual([]);
});

test('a failed fixture load rejects, and the next call retries and succeeds', async ({ page }) => {
  let failed = false;
  // Fail the WAV fetch itself, not Vite's `?import&url` module that only exports its URL.
  await page.route(
    (url) => url.pathname.endsWith('.wav') && !url.searchParams.has('import'),
    async (route) => {
      if (failed) return route.fallback();
      failed = true;
      return route.fulfill({ status: 500, body: 'fixture load failure' });
    },
  );
  // The 500 logs a console error, so errors are not asserted here.
  await open(page, '?fakeMic=open_strings');

  expect(await tryGetUserMedia(page, { audio: true })).not.toBe('ok');
  expect(failed).toBe(true);
  expect(await tryGetUserMedia(page, { audio: true })).toBe('ok');
});

test('an unknown fixture lists no device and getUserMedia rejects with NotFoundError', async ({
  page,
}) => {
  const errors = await open(page, '?fakeMic=nope');

  const result = await page.evaluate(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      return { devices: devices.length, error: null };
    } catch (err) {
      return {
        devices: devices.length,
        error: err instanceof DOMException ? err.name : String(err),
      };
    }
  });

  expect(result).toEqual({ devices: 0, error: 'NotFoundError' });
  expect(errors).toEqual([]);
});

test('without ?fakeMic the real mediaDevices are untouched', async ({ page }) => {
  const errors = await open(page, '');

  const native = await page.evaluate(() => {
    const md = navigator.mediaDevices;
    return {
      ownGetUserMedia: Object.hasOwn(md, 'getUserMedia'),
      ownEnumerateDevices: Object.hasOwn(md, 'enumerateDevices'),
      getUserMedia: Function.prototype.toString.call(md.getUserMedia),
      enumerateDevices: Function.prototype.toString.call(md.enumerateDevices),
    };
  });

  expect(native.ownGetUserMedia).toBe(false);
  expect(native.ownEnumerateDevices).toBe(false);
  expect(native.getUserMedia).toContain('[native code]');
  expect(native.enumerateDevices).toContain('[native code]');
  expect(errors).toEqual([]);
});
