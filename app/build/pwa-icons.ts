/**
 * Build-time PWA assets (story "Installable offline app", CAP-20, AD-19): the web manifest's
 * colours, read from the theme tokens (spine AD-12: generated, never hand-copied), and the app
 * icons, drawn here and written as PNGs with `node:zlib` and a CRC32, with no native dependency.
 * Nothing is committed under `public/`, so the icons cannot drift from the tokens.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { Plugin } from 'vite';

/** The theme file, the only source of colours. */
export const THEME_CSS = resolve(import.meta.dirname, '..', 'src', 'ui', 'theme.css');

/** The light-theme tokens the manifest and icons use. */
export interface PwaTokens {
  /** `--color-background`, as `#rrggbb`. */
  background: string;
  /** `--color-primary`, as `#rrggbb`. */
  primary: string;
}

/** `#rgb` or `#rrggbb` (any case) as lower-case `#rrggbb`. */
function normaliseHex(value: string): string {
  const hex = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(hex)) return hex;
  if (/^#[0-9a-f]{3}$/.test(hex)) return `#${[...hex.slice(1)].map((c) => c + c).join('')}`;
  throw new Error(`theme.css: expected a #rgb or #rrggbb colour, got "${value}"`);
}

/**
 * The light tokens from `theme.css`: the first `:root { … }` block (the light theme; the dark
 * values sit under later, qualified `:root` selectors). Comments are stripped first, so a `}` or
 * a commented-out token inside one cannot end the block early or be read as a value.
 */
export function readTokens(css: string = readFileSync(THEME_CSS, 'utf8')): PwaTokens {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const block = /(^|\n)\s*:root\s*\{([^}]*)\}/.exec(code)?.[2];
  if (block === undefined) throw new Error('theme.css: no light :root block');
  const token = (name: string) => {
    // Anchored at a declaration start: the block's start or after a `;`.
    const value = new RegExp(`(?:^|;)\\s*--color-${name}\\s*:\\s*([^;]+);`).exec(block)?.[1];
    if (value === undefined) throw new Error(`theme.css: no --color-${name} in :root`);
    return normaliseHex(value);
  };
  return { background: token('background'), primary: token('primary') };
}

/** One icon: its file (relative to the manifest), size and purpose. */
export interface PwaIcon {
  src: string;
  sizes: string;
  type: 'image/png';
  purpose: 'any' | 'maskable';
}

/** The icons, as the manifest lists them. */
export const ICONS: readonly (PwaIcon & { size: number })[] = [
  { src: 'icons/icon-192.png', size: 192, sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: 'icons/icon-512.png', size: 512, sizes: '512x512', type: 'image/png', purpose: 'any' },
  {
    src: 'icons/icon-maskable-512.png',
    size: 512,
    sizes: '512x512',
    type: 'image/png',
    purpose: 'maskable',
  },
];

/** The web manifest (vite-plugin-pwa's `manifest` option), its colours from the tokens. */
export function pwaManifest(tokens: PwaTokens = readTokens()) {
  return {
    name: 'TabCreator',
    short_name: 'TabCreator',
    description: 'Record a guitar phrase and get its tab',
    lang: 'en',
    display: 'standalone' as const,
    // Relative to the manifest's own URL, so they work at the root and under any sub-path.
    start_url: './',
    scope: './',
    id: './',
    background_color: tokens.background,
    theme_color: tokens.background,
    icons: ICONS.map(({ src, sizes, type, purpose }) => ({ src, sizes, type, purpose })),
  };
}

// --- The glyph ---------------------------------------------------------------------------------

/**
 * The fraction of the icon the glyph's square spans: generous for `any`, and for `maskable`
 * small enough that its corners stay inside the 80 % safe-zone circle (half-diagonal
 * 0.5 × 0.52 × √2 ≈ 0.37 < 0.4 of the size).
 */
const GLYPH_SPAN = { any: 0.72, maskable: 0.52 } as const;

/**
 * Whether the glyph covers point (x, y) in glyph units (0..1 across its square): a six-line tab
 * staff with a round note head on the third line and a stem, in the primary colour.
 */
function glyphCovers(x: number, y: number): boolean {
  if (x < 0 || x > 1 || y < 0 || y > 1) return false;
  // Six strings, evenly spaced from 0.1 to 0.9, each 0.04 thick.
  for (let i = 0; i < 6; i++) {
    const lineY = 0.1 + (0.8 * i) / 5;
    if (Math.abs(y - lineY) <= 0.022 && x >= 0.04 && x <= 0.96) return true;
  }
  // The note head: a disc on the third string.
  const cx = 0.58;
  const cy = 0.1 + (0.8 * 2) / 5;
  if ((x - cx) ** 2 + (y - cy) ** 2 <= 0.13 ** 2) return true;
  // Its stem, up from the right of the head to the top string.
  return x >= cx + 0.1 && x <= cx + 0.13 && y >= 0.06 && y <= cy;
}

/** `#rrggbb` as [r, g, b]. */
function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Supersamples per pixel side, for anti-aliased edges. */
const SS = 4;

/**
 * The icon's RGBA pixels: the background colour everywhere (opaque, as a maskable icon must be),
 * the glyph centred in the primary colour.
 */
export function drawIcon(
  size: number,
  purpose: PwaIcon['purpose'],
  tokens: PwaTokens,
): Uint8Array<ArrayBuffer> {
  const bg = rgb(tokens.background);
  const fg = rgb(tokens.primary);
  const span = size * GLYPH_SPAN[purpose];
  const origin = (size - span) / 2;
  const pixels = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS - origin) / span;
          const y = (py + (sy + 0.5) / SS - origin) / span;
          if (glyphCovers(x, y)) hits++;
        }
      }
      const a = hits / (SS * SS);
      const o = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) pixels[o + c] = Math.round(bg[c]! + (fg[c]! - bg[c]!) * a);
      pixels[o + 3] = 255;
    }
  }
  return pixels;
}

// --- PNG ---------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The PNG (ISO 3309) CRC32 of `bytes`. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** RGBA pixels (8 bits per channel, row-major) as a PNG file. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (rgba.length !== width * height * 4) throw new Error('encodePng: pixel count mismatch');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // compression 0, filter 0, interlace 0 (already zero)
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Every icon's PNG file, keyed by its path relative to the output directory. */
export function renderIcons(tokens: PwaTokens = readTokens()): Map<string, Buffer> {
  return new Map(
    ICONS.map(({ src, size, purpose }) => [
      src,
      encodePng(size, size, drawIcon(size, purpose, tokens)),
    ]),
  );
}

/**
 * Emits the icons into the build output (production builds only), before vite-plugin-pwa globs
 * `dist/` for the precache at `closeBundle`.
 */
export function pwaIcons(): Plugin {
  return {
    name: 'tabcreator-pwa-icons',
    apply: 'build',
    generateBundle() {
      this.addWatchFile(THEME_CSS);
      for (const [fileName, source] of renderIcons()) {
        this.emitFile({ type: 'asset', fileName, source });
      }
    },
  };
}
