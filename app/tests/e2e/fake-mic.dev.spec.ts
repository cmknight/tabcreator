import { expect, test, type Page } from '@playwright/test';
import { collectErrors } from './helpers';

// Runs in the `dev` project only: the fake mic (stories US-0.4) is installed by dev builds only.
// The storage test page is just a dev route to land on; the capture runs in page.evaluate, so no
// app code outside audio/ calls getUserMedia.

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

const TWO_DEVICES = '?fakeMic=open_strings,silence_60s';
const OPEN_ID = 'fake-mic-open_strings';
const SILENCE_ID = 'fake-mic-silence_60s';

test('a fixture list serves one device per fixture, the first by default', async ({ page }) => {
  const errors = await open(page, TWO_DEVICES);

  const result = await page.evaluate(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const settings = stream.getAudioTracks()[0]!.getSettings();
    stream.getTracks().forEach((track) => track.stop());
    return {
      devices: devices.map(({ deviceId, groupId, kind, label }) => ({
        deviceId,
        groupId,
        kind,
        label,
      })),
      defaultId: settings.deviceId,
    };
  });

  expect(result.devices.map(({ deviceId, kind, label }) => ({ deviceId, kind, label }))).toEqual([
    { deviceId: OPEN_ID, kind: 'audioinput', label: 'Fake mic: open_strings' },
    { deviceId: SILENCE_ID, kind: 'audioinput', label: 'Fake mic: silence_60s' },
  ]);
  expect(result.devices[0]!.groupId).not.toBe(result.devices[1]!.groupId);
  expect(result.defaultId).toBe(OPEN_ID);
  expect(errors).toEqual([]);
});

test('unplug ends the track, drops the device and fires devicechange', async ({ page }) => {
  const errors = await open(page, TWO_DEVICES);

  const result = await page.evaluate(async (id) => {
    const md = navigator.mediaDevices;
    const stream = await md.getUserMedia({ audio: { deviceId: { exact: id } } });
    const track = stream.getAudioTracks()[0]!;
    let ended = 0;
    let changes = 0;
    track.addEventListener('ended', () => ended++);
    md.addEventListener('devicechange', () => changes++);
    window.__fakeMic!.unplug(id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    let exactError: string | null = null;
    try {
      await md.getUserMedia({ audio: { deviceId: { exact: id } } });
    } catch (err) {
      exactError = err instanceof DOMException ? err.name : String(err);
    }
    return {
      readyState: track.readyState,
      ended,
      changes,
      devices: (await md.enumerateDevices()).map((d) => d.deviceId),
      exactError,
    };
  }, OPEN_ID);

  expect(result).toEqual({
    readyState: 'ended',
    ended: 1,
    changes: 1,
    devices: [SILENCE_ID],
    exactError: 'OverconstrainedError',
  });
  expect(errors).toEqual([]);
});

test('revoke ends the track and the device stays listed', async ({ page }) => {
  const errors = await open(page, TWO_DEVICES);

  const result = await page.evaluate(async () => {
    const md = navigator.mediaDevices;
    const stream = await md.getUserMedia({ audio: true });
    const track = stream.getAudioTracks()[0]!;
    let ended = 0;
    track.addEventListener('ended', () => ended++);
    window.__fakeMic!.revoke();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      readyState: track.readyState,
      ended,
      devices: (await md.enumerateDevices()).length,
    };
  });

  expect(result).toEqual({ readyState: 'ended', ended: 1, devices: 2 });
  expect(await tryGetUserMedia(page, { audio: true })).toBe('ok');
  expect(errors).toEqual([]);
});

test('failNext rejects the next getUserMedia only', async ({ page }) => {
  const errors = await open(page, TWO_DEVICES);

  await page.evaluate(() => window.__fakeMic!.failNext('NotReadableError', 'device busy'));
  expect(await tryGetUserMedia(page, { audio: true })).toBe('NotReadableError');
  expect(await tryGetUserMedia(page, { audio: true })).toBe('ok');
  expect(errors).toEqual([]);
});

test('configure sets the sample rate and label of later streams', async ({ page }) => {
  const errors = await open(page, TWO_DEVICES);

  const result = await page.evaluate(async (id) => {
    const md = navigator.mediaDevices;
    let changes = 0;
    md.addEventListener('devicechange', () => changes++);
    window.__fakeMic!.configure(id, { sampleRate: 16000, label: 'AirPods Pro' });
    const stream = await md.getUserMedia({ audio: { deviceId: { exact: id } } });
    const track = stream.getAudioTracks()[0]!;
    const settings = track.getSettings();
    const label = track.label;
    stream.getTracks().forEach((t) => t.stop());
    return {
      sampleRate: settings.sampleRate,
      deviceId: settings.deviceId,
      label,
      listed: (await md.enumerateDevices()).find((d) => d.deviceId === id)?.label,
      changes,
    };
  }, SILENCE_ID);

  expect(result).toEqual({
    sampleRate: 16000,
    deviceId: SILENCE_ID,
    label: 'AirPods Pro',
    listed: 'AirPods Pro',
    changes: 1,
  });
  expect(errors).toEqual([]);
});

test('a stream opened after the fixture has ended hears it from the start', async ({ page }) => {
  test.setTimeout(30_000);
  const errors = await open(page, '?fakeMic=bend_up');

  const rmsDb = await page.evaluate(async () => {
    const md = navigator.mediaDevices;
    const first = await md.getUserMedia({ audio: true });
    // bend_up is 5.9 s long: by now the first stream has played it through.
    await new Promise((resolve) => setTimeout(resolve, 6200));
    const second = await md.getUserMedia({ audio: true });
    const ctx = new AudioContext();
    await ctx.resume();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    ctx.createMediaStreamSource(second).connect(analyser);

    // The second stream's first 1.5 s, reading a full analyser window about every 20 ms.
    const frame = new Float32Array(analyser.fftSize);
    let sumSquares = 0;
    let count = 0;
    const end = performance.now() + 1500;
    while (performance.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      analyser.getFloatTimeDomainData(frame);
      for (const v of frame) sumSquares += v * v;
      count += frame.length;
    }
    [first, second].forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    await ctx.close();
    return 10 * Math.log10(sumSquares / count);
  });

  expect(rmsDb).toBeGreaterThan(-40);
  expect(errors).toEqual([]);
});
