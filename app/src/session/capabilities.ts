// The unsupported-browser check (CAP-22, CAP-25, US-8.3): the browser APIs TabCreator cannot run
// without, found by feature detection only (never the user agent). `main.tsx` runs it before the
// instance lock starts; anything missing shows the unsupported notice and starts nothing else.
// It reads only the environment it is given and never throws. Every probe is a read except
// two calls: `MediaRecorder.isTypeSupported` and the deflate-raw probe, which constructs a
// `DecompressionStream` and discards it.

import { RECORDING_MIME } from '../audio/recorder';
import { REQUIRED_CAPABILITIES, type CapabilityName } from './capability-names';

export { REQUIRED_CAPABILITIES, type CapabilityName };

/** The parts of the global scope probed here, all optional, so tests can pass a fake env. */
export type CapabilityEnv = Record<string, unknown>;

/** Whether `env` has one required capability; may throw (counted as missing). */
type Probe = (env: CapabilityEnv) => boolean;

const isFunction = (value: unknown): boolean => typeof value === 'function';

/** `obj[key]`, or undefined when `obj` is not an object (or function). */
function prop(obj: unknown, key: string): unknown {
  if ((typeof obj !== 'object' && typeof obj !== 'function') || obj === null) return undefined;
  return (obj as Record<string, unknown>)[key];
}

/** Whether `key` is on `ctor.prototype` or its chain, without reading it (getters may throw). */
function onPrototype(ctor: unknown, key: string): boolean {
  const proto = prop(ctor, 'prototype');
  return typeof proto === 'object' && proto !== null && key in proto;
}

/** The probe for each required capability. */
const PROBES: Record<CapabilityName, Probe> = {
  AudioWorklet: (env) =>
    isFunction(env.AudioWorkletNode) && onPrototype(env.AudioContext, 'audioWorklet'),
  OPFS: (env) =>
    isFunction(prop(prop(env.navigator, 'storage'), 'getDirectory')) &&
    onPrototype(env.FileSystemFileHandle, 'createWritable'),
  WebAssembly: (env) =>
    isFunction(prop(env.WebAssembly, 'instantiate')) &&
    isFunction(prop(env.WebAssembly, 'compile')),
  'Web Locks': (env) => isFunction(prop(prop(env.navigator, 'locks'), 'request')),
  BroadcastChannel: (env) => isFunction(env.BroadcastChannel),
  MediaRecorder: (env) => {
    const isTypeSupported = prop(env.MediaRecorder, 'isTypeSupported');
    return (
      isFunction(env.MediaRecorder) &&
      isFunction(isTypeSupported) &&
      (isTypeSupported as (mime: string) => unknown).call(env.MediaRecorder, RECORDING_MIME) ===
        true
    );
  },
  getUserMedia: (env) => isFunction(prop(prop(env.navigator, 'mediaDevices'), 'getUserMedia')),
  'crypto.randomUUID': (env) => isFunction(prop(env.crypto, 'randomUUID')),
  IndexedDB: (env) => typeof env.indexedDB === 'object' && env.indexedDB !== null,
  // Module support cannot be probed without a request, so `Worker` itself is the check.
  Worker: (env) => isFunction(env.Worker),
  'DecompressionStream deflate-raw': (env) => {
    const Ctor = env.DecompressionStream;
    if (!isFunction(Ctor)) return false;
    new (Ctor as new (format: string) => unknown)('deflate-raw');
    return true;
  },
  'Blob.stream': (env) => isFunction(prop(prop(env.Blob, 'prototype'), 'stream')),
};

/**
 * The names of the required capabilities `env` lacks; empty when the browser can run the app.
 * A probe that throws counts as missing.
 */
export function missingCapabilities(
  env: CapabilityEnv = globalThis as unknown as CapabilityEnv,
): CapabilityName[] {
  const missing: CapabilityName[] = [];
  for (const name of REQUIRED_CAPABILITIES) {
    let ok: boolean;
    try {
      ok = PROBES[name](env);
    } catch {
      ok = false;
    }
    if (!ok) missing.push(name);
  }
  return missing;
}
