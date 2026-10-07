// @vitest-environment node
// Story "Installable offline app" (CAP-20, spine AD-12, AD-19): the manifest's colours are the
// theme tokens, and the generated icons are valid PNGs of the listed sizes, the maskable one's
// glyph inside the safe zone.
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  crc32,
  encodePng,
  ICONS,
  pwaManifest,
  readTokens,
  renderIcons,
} from '../../build/pwa-icons';

/**
 * The light theme's tokens as DESIGN.md fixes them (theme.css `:root`), pinned here rather than
 * parsed, so a parser bug cannot agree with itself. A deliberate token change updates these.
 */
const LIGHT = { background: '#fafaf7', primary: '#1f5fad' } as const;

/** A decoded 8-bit RGBA, non-interlaced PNG, every chunk's CRC checked. */
function decodePng(png: Buffer): { width: number; height: number; rgba: Uint8Array } {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let offset = 8;
  let ihdr: Buffer | null = null;
  const idat: Buffer[] = [];
  let ended = false;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    expect(png.readUInt32BE(offset + 8 + length)).toBe(
      crc32(png.subarray(offset + 4, offset + 8 + length)),
    );
    if (type === 'IHDR') ihdr = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') ended = true;
    offset += 12 + length;
  }
  expect(ended).toBe(true);
  const width = ihdr!.readUInt32BE(0);
  const height = ihdr!.readUInt32BE(4);
  expect([...ihdr!.subarray(8)]).toEqual([8, 6, 0, 0, 0]);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  expect(raw.length).toBe((stride + 1) * height);
  const rgba = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (stride + 1)]).toBe(0); // filter: none
    rgba.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride);
  }
  return { width, height, rgba };
}

const hex = (rgba: Uint8Array, i: number) =>
  `#${[...rgba.subarray(i, i + 3)].map((c) => c.toString(16).padStart(2, '0')).join('')}`;

describe('the web manifest', () => {
  it('takes its colours from the light theme tokens', () => {
    const manifest = pwaManifest();
    expect(manifest.background_color).toBe(LIGHT.background);
    expect(manifest.theme_color).toBe(LIGHT.background);
    expect(readTokens()).toEqual(LIGHT);
  });

  it('is a standalone app, relative to its own URL, with 192, 512 and maskable icons', () => {
    const manifest = pwaManifest();
    expect(manifest).toMatchObject({
      name: 'TabCreator',
      short_name: 'TabCreator',
      display: 'standalone',
      start_url: './',
      scope: './',
      id: './',
    });
    expect(manifest.icons.map((i) => `${i.sizes} ${i.purpose}`)).toEqual([
      '192x192 any',
      '512x512 any',
      '512x512 maskable',
    ]);
  });

  it('follows the tokens it is given', () => {
    const css = ':root {\n  --color-background: #ABC;\n  --color-primary: #123456;\n}\n';
    expect(pwaManifest(readTokens(css)).theme_color).toBe('#aabbcc');
  });

  it('reads only live declarations of the light :root, past comments', () => {
    const css = [
      '/* a note with a } brace */',
      ':root {',
      '  /* --color-background: #000000; } */',
      '  --color-surface-background: #111111;',
      '  --color-background: #fafaf7; /* light } */',
      '  --color-primary: #1f5fad;',
      '}',
      ':root[data-theme="dark"] { --color-background: #141311; --color-primary: #7fb0f0; }',
    ].join('\n');
    expect(readTokens(css)).toEqual(LIGHT);
  });

  it('throws on a missing :root block, a missing token or a non-hex value', () => {
    expect(() => readTokens('body { color: red; }')).toThrow(/no light :root block/);
    expect(() => readTokens(':root {\n  --color-background: #fff;\n}')).toThrow(
      /no --color-primary/,
    );
    expect(() => readTokens(':root { --color-primary: #fff; }')).toThrow(/no --color-background/);
    expect(() =>
      readTokens(':root {\n  --color-background: rgb(0 0 0);\n  --color-primary: #fff;\n}'),
    ).toThrow(/expected a #rgb or #rrggbb colour/);
  });
});

describe('encodePng', () => {
  it('rejects a pixel buffer of the wrong length', () => {
    expect(() => encodePng(2, 2, new Uint8Array(15))).toThrow(/pixel count mismatch/);
  });
});

describe('the icons', () => {
  const icons = renderIcons();
  const background = LIGHT.background;
  const primary = LIGHT.primary;

  it.each(ICONS.map((i) => [i.src, i] as const))(
    '%s decodes at its size, opaque, in the two token colours',
    (src, icon) => {
      const { width, height, rgba } = decodePng(icons.get(src)!);
      expect([width, height]).toEqual([icon.size, icon.size]);
      expect(`${width}x${height}`).toBe(icon.sizes);
      const colours = new Set<string>();
      let translucent = 0;
      for (let i = 0; i < rgba.length; i += 4) {
        if (rgba[i + 3] !== 255) translucent++;
        colours.add(hex(rgba, i));
      }
      expect(translucent).toBe(0);
      expect(colours.has(background)).toBe(true);
      expect(colours.has(primary)).toBe(true);
      // The corner is the background.
      expect(hex(rgba, 0)).toBe(background);
    },
  );

  it('keeps the maskable glyph inside the safe zone (the centre circle of radius 0.4)', () => {
    const icon = ICONS.find((i) => i.purpose === 'maskable')!;
    const { width, rgba } = decodePng(icons.get(icon.src)!);
    const centre = width / 2;
    let glyphPixels = 0;
    let outside = 0;
    for (let y = 0; y < width; y++) {
      for (let x = 0; x < width; x++) {
        const isBackground = hex(rgba, (y * width + x) * 4) === background;
        if (!isBackground) glyphPixels++;
        if (!isBackground && Math.hypot(x + 0.5 - centre, y + 0.5 - centre) > 0.4 * width) {
          outside++;
        }
      }
    }
    expect(outside).toBe(0);
    expect(glyphPixels).toBeGreaterThan(0);
  });
});
