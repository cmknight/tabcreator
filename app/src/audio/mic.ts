// Microphone access, the input device list and the live input (spine AD-2: the only
// getUserMedia / enumerateDevices / devicechange / AudioContext / AnalyserNode owner).
// Processing is always off, so the engine hears the raw instrument.

import { AppError, type AppErrorCode } from '../model/errors';

/** Analyser window shared by the meter and the tuner. */
export const ANALYSER_FFT_SIZE = 4096;

/** The exact constraints for a mic request; `deviceId` is pinned only when one is given. */
export function micConstraints(deviceId?: string): MediaStreamConstraints {
  return {
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  };
}

/** The `getUserMedia` rejection names with a specific code (AD-10); any other name is `mic-failed`. */
const MIC_ERROR_CODES: Readonly<Record<string, AppErrorCode>> = {
  NotAllowedError: 'mic-denied',
  SecurityError: 'mic-denied',
  NotFoundError: 'mic-no-device',
  OverconstrainedError: 'mic-no-device',
  NotReadableError: 'mic-in-use',
  AbortError: 'mic-in-use',
};

/** The AD-10 code for a `getUserMedia` rejection, by the error's `name`. */
export function micErrorCode(err: unknown): AppErrorCode {
  const name =
    typeof err === 'object' && err !== null && 'name' in err && typeof err.name === 'string'
      ? err.name
      : '';
  const code = Object.hasOwn(MIC_ERROR_CODES, name) ? MIC_ERROR_CODES[name] : undefined;
  return code ?? 'mic-failed';
}

/**
 * Opens the mic. Rejects with `AppError` `mic-denied`, `mic-no-device`, `mic-in-use` or
 * `mic-failed`, mapped from the rejection's name by `micErrorCode`.
 */
export async function requestMic(deviceId?: string): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(micConstraints(deviceId));
  } catch (err) {
    throw new AppError(micErrorCode(err), 'getUserMedia rejected', { cause: err });
  }
}

/** One selectable audio input. */
export interface MicDevice {
  readonly deviceId: string;
  readonly label: string;
  /** Shared by the inputs of one physical device; resolves Chrome's `default` to a real id. */
  readonly groupId: string;
}

/** Chrome's pseudo-entries that alias a real device; they are never listed. */
const PSEUDO_DEVICE_IDS: ReadonlySet<string> = new Set(['default', 'communications']);

/** The audio inputs with a real id, in browser order. Never rejects: empty when unavailable. */
export async function listMics(): Promise<MicDevice[]> {
  let infos: MediaDeviceInfo[];
  try {
    infos = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return [];
  }
  return infos
    .filter(
      (d) => d.kind === 'audioinput' && d.deviceId !== '' && !PSEUDO_DEVICE_IDS.has(d.deviceId),
    )
    .map((d) => ({ deviceId: d.deviceId, label: d.label, groupId: d.groupId }));
}

/** Calls `listener` on each `devicechange`. Returns the unsubscribe function. */
export function onDeviceChange(listener: () => void): () => void {
  const mediaDevices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
  if (!mediaDevices?.addEventListener) return () => {};
  mediaDevices.addEventListener('devicechange', listener);
  return () => mediaDevices.removeEventListener('devicechange', listener);
}

/**
 * The listed device a live input runs on: its track's `deviceId`, or for an id that is not
 * listed (Chrome reports `default` for a default request) the listed device with its `groupId`.
 * Null when neither matches.
 */
export function activeDevice(
  input: { deviceId: string | null; groupId: string | null },
  devices: readonly MicDevice[],
): MicDevice | null {
  return (
    devices.find((d) => d.deviceId === input.deviceId) ??
    (input.groupId ? devices.find((d) => d.groupId === input.groupId) : undefined) ??
    null
  );
}

export type MicPermission = 'granted' | 'prompt' | 'denied' | 'unknown';

/**
 * The browser's microphone permission state, without prompting. `unknown` when the
 * Permissions API is missing, rejects or reports a state it does not define.
 */
export async function micPermission(): Promise<MicPermission> {
  try {
    const { state } = await navigator.permissions.query({ name: 'microphone' });
    return state === 'granted' || state === 'prompt' || state === 'denied' ? state : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** One open mic stream with its single shared analyser. */
export interface MicInput {
  readonly analyser: AnalyserNode;
  /** The device the live track reports (`getSettings().deviceId`); null when it reports none. */
  readonly deviceId: string | null;
  /** The track's `groupId` setting; null when it reports none. */
  readonly groupId: string | null;
  /** The track's label ("" when the browser gives none). */
  readonly label: string;
  /** The track's `sampleRate` setting in Hz; null when it reports none. */
  readonly sampleRate: number | null;
  /**
   * The analyser's current float time-domain frame (`ANALYSER_FFT_SIZE` samples). The array is
   * reused: it is overwritten by the next `readFrame` call.
   */
  readFrame(): Float32Array;
  /** Stops the stream's tracks and closes the AudioContext. */
  close(): void;
}

/** The first audio track's device settings, sample rate and label. */
function trackDevice(
  stream: MediaStream,
): Pick<MicInput, 'deviceId' | 'groupId' | 'label' | 'sampleRate'> {
  const track = stream.getTracks()[0];
  const settings = track?.getSettings?.() ?? {};
  return {
    deviceId: settings.deviceId || null,
    groupId: settings.groupId || null,
    label: track?.label ?? '',
    sampleRate:
      typeof settings.sampleRate === 'number' && settings.sampleRate > 0
        ? settings.sampleRate
        : null,
  };
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/**
 * Wraps `stream` in an AudioContext with one analyser. Throws `AppError` `mic-failed`.
 * `onEnded` is called once, with `AppError` `mic-lost`, when a track of the stream ends on its
 * own (access revoked, device gone); never after `close()`.
 */
export function openInput(stream: MediaStream, onEnded?: (error: AppError) => void): MicInput {
  let ctx: AudioContext | undefined;
  const tracks = stream.getTracks();
  let closed = false;
  const handleEnded = () => {
    if (closed) return;
    closed = true;
    for (const track of tracks) track.removeEventListener('ended', handleEnded);
    onEnded?.(new AppError('mic-lost', 'The microphone track ended'));
  };
  const detach = () => {
    closed = true;
    for (const track of tracks) track.removeEventListener('ended', handleEnded);
  };
  try {
    ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = ANALYSER_FFT_SIZE;
    ctx.createMediaStreamSource(stream).connect(analyser);
    // Opened from the Allow click, so the context may start; resuming is best-effort.
    void ctx.resume().catch(() => {});
    const frame = new Float32Array(analyser.fftSize);
    const context = ctx;
    for (const track of tracks) track.addEventListener('ended', handleEnded);
    // A track that ended before the listener was attached fires no event.
    if (tracks.some((track) => track.readyState === 'ended')) queueMicrotask(handleEnded);
    return {
      analyser,
      ...trackDevice(stream),
      readFrame() {
        analyser.getFloatTimeDomainData(frame);
        return frame;
      },
      close() {
        detach();
        stopTracks(stream);
        void context.close().catch(() => {});
      },
    };
  } catch (err) {
    detach();
    stopTracks(stream);
    void ctx?.close().catch(() => {});
    throw new AppError('mic-failed', 'Opening the audio input failed', { cause: err });
  }
}
