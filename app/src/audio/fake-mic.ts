// Dev/test-only fake microphone (stories US-0.4). `main.tsx` loads this module only inside an
// `import.meta.env.DEV` branch when the URL has `?fakeMic=<fixture>`, so production builds never
// contain it. It serves a fixture from testdata/synth/ as the getUserMedia stream.

/** Fixture WAV URLs, keyed by fixture name. Lazy: nothing is fetched until it is needed. */
const FIXTURES: Record<string, () => Promise<string>> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>('../../../testdata/synth/*.wav', { query: '?url', import: 'default' }),
  ).map(([path, load]) => [path.replace(/^.*\/|\.wav$/g, ''), load]),
);

const SAMPLE_RATE = 48_000;
/** How long to wait for the AudioContext to start before giving up (no user gesture yet). */
export const RESUME_TIMEOUT_MS = 2000;

/**
 * Replaces `navigator.mediaDevices.getUserMedia` and `enumerateDevices` with a single fake
 * input device, "Fake mic: <fixture>". The first `getUserMedia` call starts the decoded fixture
 * playing once; every stream carries it, then silence. An unknown fixture lists no device and
 * `getUserMedia` rejects with `NotFoundError`. Without a user gesture (or Chromium's
 * `--autoplay-policy=no-user-gesture-required`) the audio cannot start, and `getUserMedia`
 * rejects with `NotAllowedError`; a later call retries.
 */
export function installFakeMic(fixture: string): void {
  const mediaDevices = navigator.mediaDevices;
  const loadUrl = Object.hasOwn(FIXTURES, fixture) ? FIXTURES[fixture] : undefined;
  const deviceId = `fake-mic-${fixture}`;
  let destination: Promise<MediaStreamAudioDestinationNode> | null = null;

  async function start(load: () => Promise<string>): Promise<MediaStreamAudioDestinationNode> {
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    try {
      const response = await fetch(await load());
      if (!response.ok) {
        throw new Error(`fake mic: fetching ${fixture} failed (${response.status})`);
      }
      const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
      const dest = ctx.createMediaStreamDestination();
      dest.channelCount = 1;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(dest);
      // resume() can stay pending forever without user activation, so do not wait on it alone.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        ctx.resume(),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, RESUME_TIMEOUT_MS))),
      ]);
      clearTimeout(timer);
      if (ctx.state !== 'running') {
        throw new DOMException('Fake mic needs a user gesture to start audio', 'NotAllowedError');
      }
      source.start();
      return dest;
    } catch (err) {
      void ctx.close();
      throw err;
    }
  }

  const getUserMedia = async (constraints?: MediaStreamConstraints): Promise<MediaStream> => {
    if (!loadUrl || !constraints?.audio || constraints.video) {
      throw new DOMException(`Fake mic: no device for ${fixture}`, 'NotFoundError');
    }
    destination ??= start(loadUrl).catch((err: unknown) => {
      destination = null; // let the next call retry
      throw err;
    });
    const dest = await destination;
    // Each caller gets its own track, so stopping one stream leaves the others running.
    return new MediaStream(dest.stream.getAudioTracks().map((track) => track.clone()));
  };

  const enumerateDevices = async (): Promise<MediaDeviceInfo[]> => {
    if (!loadUrl) return [];
    const info = {
      deviceId,
      groupId: 'fake-mic',
      kind: 'audioinput' as const,
      label: `Fake mic: ${fixture}`,
    };
    return [{ ...info, toJSON: () => info }];
  };

  Object.defineProperty(mediaDevices, 'getUserMedia', { value: getUserMedia, configurable: true });
  Object.defineProperty(mediaDevices, 'enumerateDevices', {
    value: enumerateDevices,
    configurable: true,
  });
}
