/**
 * The update e2e test's own static server (story "Update available prompt"), modelled on
 * serve-subpath.ts: it serves the production build `dist/` (build A) at the root of an
 * ephemeral port, until `serveUpdate()` switches it to `dist-update/` (build B, built with
 * `TABCREATOR_E2E_BUILD=B`) — a new version deployed to the same origin. Nothing is cached by
 * HTTP, so the browser's update check and the new worker's precache see the switch at once.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';

const APP = join(import.meta.dirname, '..', '..');
export const BUILD_A = join(APP, 'dist');
export const BUILD_B = join(APP, 'dist-update');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export interface UpdateServer {
  /** The app's URL, with a trailing slash. */
  url: string;
  /** From now on, serves build B. */
  serveUpdate(): void;
  close(): Promise<void>;
}

export async function startUpdateServer(): Promise<UpdateServer> {
  for (const dir of [BUILD_A, BUILD_B]) {
    if (!existsSync(join(dir, 'index.html'))) {
      throw new Error(`update e2e: ${dir} is not built (see playwright.config.ts BUILD)`);
    }
  }
  let root = BUILD_A;
  const server = createServer((req, res) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      // A malformed path (bad percent-encoding) is the client's error, never a server crash.
      res.writeHead(400).end();
      return;
    }
    const rel = path.slice(1) || 'index.html';
    const base = root;
    const file = normalize(join(base, rel));
    if (!file.startsWith(base + sep)) {
      res.writeHead(404).end();
      return;
    }
    readFile(file).then(
      (body) => {
        const type = TYPES[extname(file)] ?? 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(body);
      },
      () => res.writeHead(404).end(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://localhost:${port}/`,
    serveUpdate() {
      root = BUILD_B;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
