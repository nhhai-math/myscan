import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createHttpServer } from 'node:http';
import { createApp } from './app.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT cần là số nguyên từ 1 đến 65535.');
}

const app = await createApp({ port, host });
const server = createHttpServer(app);
let vite;
if (production) {
  const distDir = path.join(rootDir, 'dist');
  app.use(express.static(distDir, { index: false }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || path.extname(req.path)) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
} else {
  const { createServer } = await import('vite');
  vite = await createServer({
    root: rootDir,
    server: { middlewareMode: true, ws: { server } },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

server.listen(port, host, () => {
  console.log(`myscan đang chạy tại cổng ${port} (${production ? 'production' : 'development'}).`);
});
server.on('error', (error) => {
  console.error(`Không thể khởi động myscan: ${error.message}`);
  process.exitCode = 1;
  void vite?.close();
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(0), 5000);
  timeout.unref();
  await vite?.close();
  server.close(() => process.exit(0));
  server.closeAllConnections();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
