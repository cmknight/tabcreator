import { describe, expect, it } from 'vitest';
import { RECORDING_MIME } from '../../src/audio/recorder';
import {
  missingCapabilities,
  REQUIRED_CAPABILITIES,
  type CapabilityEnv,
  type CapabilityName,
} from '../../src/session/capabilities';

// Story "Capability check and the unsupported screen": the pure check on a fake environment.

const noop = () => {};

/** A fake environment with every required API present. */
function fullEnv(): CapabilityEnv {
  class AudioContext {}
  Object.defineProperty(AudioContext.prototype, 'audioWorklet', {
    get() {
      throw new TypeError('Illegal invocation');
    },
  });
  class DecompressionStream {
    constructor(format: string) {
      if (!['gzip', 'deflate', 'deflate-raw'].includes(format)) throw new TypeError(format);
    }
  }
  class Blob {
    stream() {}
  }
  class FileSystemFileHandle {
    createWritable() {}
  }
  class MediaRecorder {
    static isTypeSupported(mime: string) {
      return mime === RECORDING_MIME;
    }
  }
  return {
    AudioWorkletNode: class {},
    AudioContext,
    navigator: {
      storage: { getDirectory: noop },
      locks: { request: noop },
      mediaDevices: { getUserMedia: noop },
    },
    FileSystemFileHandle,
    WebAssembly: { instantiate: noop, compile: noop },
    BroadcastChannel: class {},
    MediaRecorder,
    crypto: { randomUUID: noop },
    indexedDB: {},
    Worker: class {},
    DecompressionStream,
    Blob,
  };
}

/** Each required API and how a test removes it from a full env. */
const nav = (env: CapabilityEnv) => env.navigator as Record<string, unknown>;

const REMOVALS: [CapabilityName, (env: CapabilityEnv) => void][] = [
  ['AudioWorklet', (env) => delete env.AudioWorkletNode],
  ['AudioWorklet', (env) => (env.AudioContext = class {})],
  ['AudioWorklet', (env) => delete env.AudioContext],
  ['OPFS', (env) => (nav(env).storage = {})],
  ['OPFS', (env) => (nav(env).storage = undefined)],
  ['OPFS', (env) => (nav(env).storage = { getDirectory: 42 })],
  ['OPFS', (env) => (env.FileSystemFileHandle = class {})],
  ['OPFS', (env) => delete env.FileSystemFileHandle],
  ['WebAssembly', (env) => delete env.WebAssembly],
  ['WebAssembly', (env) => (env.WebAssembly = { instantiate: noop })],
  ['Web Locks', (env) => (nav(env).locks = undefined)],
  ['Web Locks', (env) => (nav(env).locks = {})],
  ['Web Locks', (env) => (nav(env).locks = { request: 'request' })],
  ['BroadcastChannel', (env) => delete env.BroadcastChannel],
  ['MediaRecorder', (env) => delete env.MediaRecorder],
  ['MediaRecorder', (env) => (env.MediaRecorder = class {})],
  [
    'MediaRecorder',
    (env) =>
      (env.MediaRecorder = class {
        static isTypeSupported() {
          return false;
        }
      }),
  ],
  [
    'MediaRecorder',
    (env) =>
      (env.MediaRecorder = class {
        static isTypeSupported() {
          throw new Error('boom');
        }
      }),
  ],
  ['getUserMedia', (env) => delete nav(env).mediaDevices],
  ['getUserMedia', (env) => (nav(env).mediaDevices = {})],
  ['getUserMedia', (env) => (nav(env).mediaDevices = { getUserMedia: true })],
  ['crypto.randomUUID', (env) => delete env.crypto],
  ['crypto.randomUUID', (env) => (env.crypto = {})],
  ['crypto.randomUUID', (env) => (env.crypto = { randomUUID: 'uuid' })],
  ['IndexedDB', (env) => delete env.indexedDB],
  ['IndexedDB', (env) => (env.indexedDB = null)],
  ['Worker', (env) => delete env.Worker],
  ['DecompressionStream deflate-raw', (env) => delete env.DecompressionStream],
  ['Blob.stream', (env) => (env.Blob = class {})],
  ['Blob.stream', (env) => delete env.Blob],
];

describe('missingCapabilities', () => {
  it('the removals cover exactly the required capabilities', () => {
    expect(new Set(REMOVALS.map(([name]) => name))).toEqual(new Set(REQUIRED_CAPABILITIES));
  });

  it('asks MediaRecorder about the recording MIME type', () => {
    const env = fullEnv();
    const asked: unknown[] = [];
    env.MediaRecorder = class {
      static isTypeSupported(mime: string) {
        asked.push(mime);
        return true;
      }
    };
    expect(missingCapabilities(env)).toEqual([]);
    expect(asked).toEqual([RECORDING_MIME]);
  });

  it('a full environment lacks nothing', () => {
    expect(missingCapabilities(fullEnv())).toEqual([]);
  });

  it('the real test environment is probed without throwing', () => {
    expect(() => missingCapabilities()).not.toThrow();
  });

  it.each(REMOVALS)('names %s, and only it, when it is removed', (name, remove) => {
    const env = fullEnv();
    remove(env);
    expect(missingCapabilities(env)).toEqual([name]);
  });

  it("names DecompressionStream when 'deflate-raw' throws", () => {
    const env = fullEnv();
    env.DecompressionStream = class {
      constructor(format: string) {
        if (format === 'deflate-raw') throw new TypeError('Unsupported compression format');
      }
    };
    expect(missingCapabilities(env)).toEqual(['DecompressionStream deflate-raw']);
  });

  it('without navigator: OPFS, Web Locks and getUserMedia are missing', () => {
    const env = fullEnv();
    delete env.navigator;
    expect(missingCapabilities(env)).toEqual(['OPFS', 'Web Locks', 'getUserMedia']);
  });

  it('an empty environment lacks everything', () => {
    expect(missingCapabilities({})).toEqual([...REQUIRED_CAPABILITIES]);
  });

  it('never throws, even when every property read throws', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
      },
    );
    expect(missingCapabilities(hostile)).toEqual([...REQUIRED_CAPABILITIES]);
  });
});
