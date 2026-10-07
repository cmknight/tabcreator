import { expect, test, type Page } from '@playwright/test';
import { collectErrors } from './helpers';
import { expectNoSeriousAxe } from './mic-helpers';
import { REQUIRED_CAPABILITIES, type CapabilityName } from '../../src/session/capability-names';

// Story "Capability check and the unsupported screen", on the production build: a browser missing
// any one required API shows only "TabCreator needs a recent desktop Chrome"; no app shell, no
// instance lock request, no storage re-check, no service-worker registration.

const UNSUPPORTED = 'TabCreator needs a recent desktop Chrome';
const appNav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

/**
 * Each init-script removal (by key) and the required capability it takes away. Together they
 * cover every capability (asserted below).
 */
const REMOVALS = [
  ['AudioWorkletNode', 'AudioWorklet'],
  ['BaseAudioContext.audioWorklet', 'AudioWorklet'],
  ['StorageManager.getDirectory', 'OPFS'],
  ['FileSystemFileHandle.createWritable', 'OPFS'],
  ['WebAssembly', 'WebAssembly'],
  ['Navigator.locks', 'Web Locks'],
  ['BroadcastChannel', 'BroadcastChannel'],
  ['MediaRecorder', 'MediaRecorder'],
  ['MediaRecorder.isTypeSupported false', 'MediaRecorder'],
  ['MediaDevices.getUserMedia', 'getUserMedia'],
  ['Crypto.randomUUID', 'crypto.randomUUID'],
  ['indexedDB', 'IndexedDB'],
  ['Worker', 'Worker'],
  ['DecompressionStream deflate-raw throws', 'DecompressionStream deflate-raw'],
  ['Blob.stream', 'Blob.stream'],
] as const satisfies readonly (readonly [string, CapabilityName])[];
type Removal = (typeof REMOVALS)[number][0];

declare global {
  interface Window {
    __capProbe?: { lockRequests: number; estimates: number; swRegisters: number };
  }
}

/** Counts the page's Web Locks requests, storage estimates and service-worker registrations. */
async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe = { lockRequests: 0, estimates: 0, swRegisters: 0 };
    window.__capProbe = probe;
    if (typeof LockManager === 'function') {
      const request = LockManager.prototype.request;
      LockManager.prototype.request = function (this: LockManager, ...args: unknown[]) {
        probe.lockRequests += 1;
        return (request as (...a: unknown[]) => Promise<unknown>).apply(this, args);
      } as typeof request;
    }
    const estimate = StorageManager.prototype.estimate;
    StorageManager.prototype.estimate = function (this: StorageManager) {
      probe.estimates += 1;
      return estimate.call(this);
    };
    if (typeof ServiceWorkerContainer === 'function') {
      const register = ServiceWorkerContainer.prototype.register;
      ServiceWorkerContainer.prototype.register = function (
        this: ServiceWorkerContainer,
        ...args: Parameters<typeof register>
      ) {
        probe.swRegisters += 1;
        return register.apply(this, args);
      };
    }
  });
}

/** Removes one required API before any app script runs. */
async function remove(page: Page, api: Removal): Promise<void> {
  await page.addInitScript((key: string) => {
    const w = window as unknown as Record<string, unknown>;
    switch (key) {
      case 'AudioWorkletNode':
        delete w.AudioWorkletNode;
        break;
      case 'BaseAudioContext.audioWorklet':
        delete (BaseAudioContext.prototype as { audioWorklet?: unknown }).audioWorklet;
        break;
      case 'StorageManager.getDirectory':
        delete (StorageManager.prototype as { getDirectory?: unknown }).getDirectory;
        break;
      case 'FileSystemFileHandle.createWritable':
        delete (FileSystemFileHandle.prototype as { createWritable?: unknown }).createWritable;
        break;
      case 'WebAssembly':
        delete w.WebAssembly;
        break;
      case 'Navigator.locks':
        delete (Navigator.prototype as { locks?: unknown }).locks;
        break;
      case 'BroadcastChannel':
        delete w.BroadcastChannel;
        break;
      case 'MediaRecorder':
        delete w.MediaRecorder;
        break;
      case 'MediaRecorder.isTypeSupported false':
        MediaRecorder.isTypeSupported = () => false;
        break;
      case 'MediaDevices.getUserMedia':
        delete (MediaDevices.prototype as { getUserMedia?: unknown }).getUserMedia;
        break;
      case 'Crypto.randomUUID':
        delete (Crypto.prototype as { randomUUID?: unknown }).randomUUID;
        break;
      case 'indexedDB':
        delete w.indexedDB;
        break;
      case 'Worker':
        delete w.Worker;
        break;
      case 'DecompressionStream deflate-raw throws': {
        const Native = DecompressionStream;
        w.DecompressionStream = class extends Native {
          constructor(format: CompressionFormat) {
            if (format === 'deflate-raw') throw new TypeError('Unsupported compression format');
            super(format);
          }
        };
        break;
      }
      case 'Blob.stream':
        delete (Blob.prototype as { stream?: unknown }).stream;
        break;
      default:
        throw new Error(`unknown removal ${key}`);
    }
  }, api);
}

test('the removals cover exactly the required capabilities', () => {
  expect(new Set(REMOVALS.map(([, capability]) => capability))).toEqual(
    new Set(REQUIRED_CAPABILITIES),
  );
});

for (const [api] of REMOVALS) {
  test(`without ${api}: only the unsupported notice, and nothing starts`, async ({ page }) => {
    const errors = collectErrors(page);
    await instrument(page);
    await remove(page, api);
    await page.goto('./#/record');
    await page.waitForLoadState('load');

    const heading = page.getByRole('heading', { name: UNSUPPORTED });
    await expect(heading).toBeVisible();
    await expect(heading).toBeFocused();
    await expect(page.getByRole('heading')).toHaveCount(1);
    await expect(page.getByRole('button')).toHaveCount(0);
    await expect(appNav(page)).toHaveCount(0);

    const counts = await page.evaluate(async () => ({
      lockRequests: window.__capProbe!.lockRequests,
      estimates: window.__capProbe!.estimates,
      swRegisters: window.__capProbe!.swRegisters,
      registrations: navigator.serviceWorker
        ? (await navigator.serviceWorker.getRegistrations()).length
        : 0,
    }));
    expect(counts).toEqual({ lockRequests: 0, estimates: 0, swRegisters: 0, registrations: 0 });

    await expectNoSeriousAxe(page);
    expect(errors).toEqual([]);
  });
}

test('a full browser starts the app as before', async ({ page }) => {
  const errors = collectErrors(page);
  await instrument(page);
  await page.goto('./#/record');

  await expect(appNav(page)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Record');
  await expect(page.getByRole('heading', { name: UNSUPPORTED })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__capProbe!.lockRequests)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.__capProbe!.estimates)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.__capProbe!.swRegisters)).toBe(1);
  expect(errors).toEqual([]);
});
