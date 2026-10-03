// The MIME ↔ file-extension table for compressed audio (spine AD-11). OPFS audio filenames
// (`audio/{takeId}.{ext}`) derive their extension only from here.

export const AUDIO_FORMATS = [
  { mime: 'audio/webm;codecs=opus', ext: 'webm' },
  { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
  { mime: 'audio/mp4', ext: 'm4a' },
  // Recovery's fallback when re-encoding a raw file fails (story 3.11): 16-bit PCM WAV.
  { mime: 'audio/wav', ext: 'wav' },
] as const;

export type AudioFormat = (typeof AUDIO_FORMATS)[number];
export type AudioMime = AudioFormat['mime'];
export type AudioExtension = AudioFormat['ext'];

/** Lower-cases and drops whitespace, so `audio/webm; codecs=opus` matches the table. */
function normalizeMime(mime: string): string {
  return mime.toLowerCase().replace(/\s+/g, '');
}

/** The file extension for a MIME type. Throws on a type not in `AUDIO_FORMATS`. */
export function extensionFor(mime: string): AudioExtension {
  const wanted = normalizeMime(mime);
  const format = AUDIO_FORMATS.find((f) => f.mime === wanted);
  if (!format) throw new Error(`Unsupported audio MIME type: ${mime}`);
  return format.ext;
}

/** The MIME type for a file extension, or `null` when the extension is not in the table. */
export function mimeForExtension(ext: string): AudioMime | null {
  return AUDIO_FORMATS.find((f) => f.ext === ext)?.mime ?? null;
}
