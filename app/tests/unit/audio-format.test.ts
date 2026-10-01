import { describe, expect, it } from 'vitest';
import { AUDIO_FORMATS, extensionFor, mimeForExtension } from '../../src/model/audio-format';

describe('audio format table', () => {
  it('maps each supported MIME type to its extension', () => {
    expect(AUDIO_FORMATS.map((f) => [f.mime, f.ext])).toEqual([
      ['audio/webm;codecs=opus', 'webm'],
      ['audio/ogg;codecs=opus', 'ogg'],
      ['audio/mp4', 'm4a'],
    ]);
    for (const f of AUDIO_FORMATS) {
      expect(extensionFor(f.mime)).toBe(f.ext);
      expect(mimeForExtension(f.ext)).toBe(f.mime);
    }
  });

  it('ignores case and whitespace in the MIME type', () => {
    expect(extensionFor('audio/webm; codecs=opus')).toBe('webm');
    expect(extensionFor('Audio/MP4')).toBe('m4a');
  });

  it('throws on an unknown MIME type', () => {
    expect(() => extensionFor('audio/wav')).toThrow(/Unsupported audio MIME type/);
    expect(() => extensionFor('')).toThrow();
    expect(mimeForExtension('wav')).toBeNull();
  });
});
