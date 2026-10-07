// The names of the capabilities the unsupported-browser check requires (`capabilities.ts`), in
// the order it reports them. Kept free of imports so the e2e tests can load it too.

export const REQUIRED_CAPABILITIES = [
  'AudioWorklet',
  'OPFS',
  'WebAssembly',
  'Web Locks',
  'BroadcastChannel',
  'MediaRecorder',
  'getUserMedia',
  'crypto.randomUUID',
  'IndexedDB',
  'Worker',
  'DecompressionStream deflate-raw',
  'Blob.stream',
] as const;

export type CapabilityName = (typeof REQUIRED_CAPABILITIES)[number];
