/**
 * Serves `dist/` under `/tabcreator/` only, as GitHub Pages does for a project site, so the
 * sub-path e2e test proves the build has no root-absolute URLs. Everything outside the
 * sub-path is a 404. Run with `node tests/e2e/serve-subpath.ts <port>` (Node strips the types).
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const BASE = '/tabcreator/';
const ROOT = join(import.meta.dirname, '..', '..', 'dist');
const PORT = Number(process.argv[2] ?? 4174);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  if (path === BASE.slice(0, -1)) {
    res.writeHead(301, { Location: BASE }).end();
    return;
  }
  if (!path.startsWith(BASE)) {
    res.writeHead(404).end();
    return;
  }
  const rel = path.slice(BASE.length) || 'index.html';
  const file = normalize(join(ROOT, rel));
  if (!file.startsWith(ROOT + sep)) {
    res.writeHead(404).end();
    return;
  }
  readFile(file).then(
    (body) => {
      const type = TYPES[extname(file)] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type }).end(body);
    },
    () => res.writeHead(404).end(),
  );
}).listen(PORT, 'localhost');
