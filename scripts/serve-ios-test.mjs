#!/usr/bin/env node
// The integration suite uses the exact generated site and GitHub Pages subpath.
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist-ios');
const prefix = '/myscan/ios/';
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
};
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (!['GET', 'HEAD'].includes(request.method) || !pathname.startsWith(prefix)) {
      response.writeHead(404).end(); return;
    }
    const relative = pathname.slice(prefix.length) || 'index.html';
    const resolved = path.resolve(root, relative);
    if (!resolved.startsWith(`${root}${path.sep}`)) { response.writeHead(404).end(); return; }
    const file = await stat(resolved);
    if (!file.isFile()) { response.writeHead(404).end(); return; }
    response.writeHead(200, {
      'Content-Type': mime[path.extname(resolved)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': file.size,
    });
    if (request.method === 'HEAD') { response.end(); return; }
    createReadStream(resolved).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
});
server.listen(Number(process.env.MYSCAN_IOS_TEST_PORT || 3102), '127.0.0.1', () => {
  console.log(`Serving generated iOS site at http://127.0.0.1:${server.address().port}${prefix}`);
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
