import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { PDFDocument, PageSizes } from 'pdf-lib';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { Storage } from './storage.js';
import { createAuth } from './auth.js';
import { ID_PATTERN, TOKEN_PATTERN, validEditSettings } from './validation.js';

const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp', 'heif', 'avif']);
const MAX_INPUT_PIXELS = 48_000_000;
const MAX_DIMENSION = 6000;
const MAX_PAGES = 200;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function titleOf(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 160) {
    throw new HttpError(400, 'Tên tài liệu cần có từ 1 đến 160 ký tự.');
  }
  return value.trim();
}

function publicDocument(document) {
  return {
    id: document.id,
    title: document.title,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    pages: document.pages.map((page) => ({
      id: page.id,
      width: page.width,
      height: page.height,
      originalWidth: page.originalWidth,
      originalHeight: page.originalHeight,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
      edit: page.edit ?? null,
      originalUrl: `/api/documents/${document.id}/pages/${page.id}/original`,
      imageUrl: `/api/documents/${document.id}/pages/${page.id}/image`,
    })),
  };
}

function requireDocument(state, id) {
  if (!ID_PATTERN.test(id)) throw new HttpError(404, 'Không tìm thấy tài liệu.');
  const document = state.documents[id];
  if (!document) throw new HttpError(404, 'Không tìm thấy tài liệu.');
  return document;
}

function requirePage(document, pageId) {
  if (!ID_PATTERN.test(pageId)) throw new HttpError(404, 'Không tìm thấy trang quét.');
  const page = document.pages.find((item) => item.id === pageId);
  if (!page) throw new HttpError(404, 'Không tìm thấy trang quét.');
  return page;
}

function requirePair(state, token, now) {
  if (!TOKEN_PATTERN.test(token)) throw new HttpError(404, 'Liên kết kết nối không hợp lệ.');
  const pairing = state.pairings[token];
  if (!pairing || !state.documents[pairing.documentId]) {
    throw new HttpError(404, 'Liên kết kết nối không còn tồn tại.');
  }
  if (Date.parse(pairing.expiresAt) <= now()) {
    throw new HttpError(410, 'Liên kết đã hết hạn. Hãy tạo mã QR mới trên máy tính.');
  }
  return pairing;
}

function pairStatus(pairing) {
  return {
    token: pairing.token,
    expiresAt: pairing.expiresAt,
    path: `/capture/${pairing.token}`,
    openedAt: pairing.openedAt,
    lastUploadAt: pairing.lastUploadAt,
    uploadedCount: pairing.uploadedCount,
  };
}

function normalizedPublicUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('PUBLIC_URL cần là địa chỉ HTTP hoặc HTTPS.');
  return url.origin;
}

export async function createApp(options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || path.resolve('.data');
  const host = options.host || process.env.HOST || '0.0.0.0';
  const port = Number(options.port ?? process.env.PORT ?? 3000);
  const publicUrl = normalizedPublicUrl(options.publicUrl ?? process.env.PUBLIC_URL);
  const now = options.now || Date.now;
  const pairTtlMs = options.pairTtlMs ?? 2 * 60 * 60 * 1000;
  const maxFileBytes = options.maxFileBytes ?? 20 * 1024 * 1024;
  const store = await new Storage(dataDir).initialize();
  const auth = await createAuth({ dataDir: store.root, now, publicUrl });
  const app = express();
  const clients = new Map();
  app.disable('x-powered-by');
  app.locals.store = store;
  app.use(express.json({ limit: '64kb' }));
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use('/api', auth.protectOrigin);
  auth.mount(app);

  function emit(type, documentId, extra = {}) {
    const data = `data: ${JSON.stringify({ type, documentId, ...extra })}\n\n`;
    for (const [client, request] of clients) {
      if (!auth.authenticated(request)) {
        client.end();
        clients.delete(client);
      } else client.write(data);
    }
  }

  app.get('/api/health', (req, res) => res.json({ ok: true, service: 'myscan' }));
  app.use('/api/documents', auth.requireOwner);
  app.get('/api/connection', auth.requireOwner, (req, res) => {
    const origins = new Set();
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses || []) {
        if (address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.')) {
          origins.add(`http://${address.address}:${port}`);
        }
      }
    }
    if (publicUrl) origins.add(publicUrl);
    res.json({ host, port, origins: [...origins], publicUrl });
  });
  app.get('/api/events', auth.requireOwner, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(': connected\n\n');
    clients.set(res, req);
    const heartbeat = setInterval(() => {
      if (!auth.authenticated(req)) res.end();
      else res.write(': heartbeat\n\n');
    }, 25_000);
    heartbeat.unref();
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
  });

  app.get('/api/documents', (req, res) => {
    const documents = Object.values(store.state.documents)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(publicDocument);
    res.json({ documents });
  });
  app.post('/api/documents', route(async (req, res) => {
    const id = randomUUID();
    const timestamp = new Date(now()).toISOString();
    const title = req.body?.title === undefined ? 'Tài liệu chưa đặt tên' : titleOf(req.body.title);
    const saved = await store.mutate((state) => {
      const document = { id, title, createdAt: timestamp, updatedAt: timestamp, pages: [] };
      state.documents[id] = document;
      return document;
    });
    emit('document-updated', id, { updatedAt: saved.updatedAt });
    res.status(201).json(publicDocument(saved));
  }));
  app.get('/api/documents/:id', route(async (req, res) => {
    res.json(publicDocument(requireDocument(store.state, req.params.id)));
  }));
  app.patch('/api/documents/:id', route(async (req, res) => {
    const body = req.body;
    if (!body || (body.title === undefined && body.pageOrder === undefined)) {
      throw new HttpError(400, 'Hãy nhập tên mới hoặc thứ tự các trang.');
    }
    const newTitle = body.title === undefined ? undefined : titleOf(body.title);
    const saved = await store.mutate((state) => {
      const document = requireDocument(state, req.params.id);
      if (body.pageOrder !== undefined) {
        const order = body.pageOrder;
        const pageIds = new Set(document.pages.map((page) => page.id));
        if (!Array.isArray(order) || order.length !== document.pages.length
          || new Set(order).size !== order.length || order.some((id) => !pageIds.has(id))) {
          throw new HttpError(400, 'Thứ tự trang phải chứa đầy đủ các trang, mỗi trang một lần.');
        }
        const pageMap = new Map(document.pages.map((page) => [page.id, page]));
        document.pages = order.map((id) => pageMap.get(id));
      }
      if (newTitle !== undefined) document.title = newTitle;
      document.updatedAt = new Date(now()).toISOString();
      return document;
    });
    emit('document-updated', saved.id, { updatedAt: saved.updatedAt });
    res.json(publicDocument(saved));
  }));
  app.delete('/api/documents/:id', route(async (req, res) => {
    await store.mutate((state) => {
      requireDocument(state, req.params.id);
      delete state.documents[req.params.id];
      for (const [token, pairing] of Object.entries(state.pairings)) {
        if (pairing.documentId === req.params.id) delete state.pairings[token];
      }
    });
    emit('document-deleted', req.params.id);
    await rm(store.documentPath(req.params.id), { recursive: true, force: true });
    res.status(204).end();
  }));

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, callback) => callback(null, req.setupTemporaryDir),
      filename: (req, file, callback) => callback(null, randomUUID()),
    }),
    limits: { fileSize: maxFileBytes, files: 30, fields: 5, fieldSize: 1024, parts: 35 },
  });

  function uploadedFiles(req) {
    return req.file ? [req.file] : (Array.isArray(req.files) ? req.files : []);
  }

  function receiving(middleware) {
    return route(async (req, res, next) => {
      req.setupTemporaryDir = path.join(store.root, 'tmp', randomUUID());
      await mkdir(req.setupTemporaryDir, { mode: 0o700 });
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        rm(req.setupTemporaryDir, { recursive: true, force: true }).catch(() => {});
      };
      res.once('finish', cleanup);
      res.once('close', () => {
        req.setupAborted = !res.writableFinished;
        cleanup();
      });
      if (req.aborted || res.destroyed) { cleanup(); return; }
      middleware(req, res, next);
    });
  }

  async function normalize(req, files, jpegOnly = false) {
    if (!files.length) throw new HttpError(400, 'Hãy chọn ít nhất một ảnh để thêm vào tài liệu.');
    const prepared = [];
    for (const file of files) {
      if (req.setupAborted) throw new HttpError(400, 'Quá trình tải ảnh đã bị ngắt.');
      const normalizedPath = path.join(req.setupTemporaryDir, `${randomUUID()}.jpg`);
      try {
        const pipeline = sharp(file.path, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' });
        const metadata = await pipeline.metadata();
        if (!ACCEPTED_FORMATS.has(metadata.format) || (jpegOnly && metadata.format !== 'jpeg')) {
          throw new HttpError(400, jpegOnly
            ? 'Ảnh đã chỉnh sửa cần được lưu ở định dạng JPEG.'
            : 'Định dạng ảnh chưa được hỗ trợ. Hãy dùng JPEG, PNG hoặc WebP.');
        }
        const result = await pipeline.rotate()
          .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
          .flatten({ background: '#ffffff' }).jpeg({ quality: 95, mozjpeg: true }).toFile(normalizedPath);
        if (req.setupAborted) throw new HttpError(400, 'Quá trình tải ảnh đã bị ngắt.');
        prepared.push({ path: normalizedPath, width: result.width, height: result.height });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, 'Không đọc được ảnh này. Ảnh có thể bị hỏng, quá lớn hoặc có định dạng chưa hỗ trợ.');
      }
    }
    return prepared;
  }

  async function addPages(req, documentId, pairingToken = null) {
    const prepared = await normalize(req, uploadedFiles(req));
    const writtenPaths = [];
    try {
      const saved = await store.mutate(async (state) => {
        if (req.setupAborted) throw new HttpError(400, 'Quá trình tải ảnh đã bị ngắt.');
        const document = requireDocument(state, documentId);
        if (pairingToken) requirePair(state, pairingToken, now);
        if (document.pages.length + prepared.length > MAX_PAGES) {
          throw new HttpError(400, `Một tài liệu chỉ có thể chứa tối đa ${MAX_PAGES} trang.`);
        }
        await mkdir(store.documentPath(documentId), { recursive: true, mode: 0o700 });
        const timestamp = new Date(now()).toISOString();
        for (const image of prepared) {
          const id = randomUUID();
          const originalPath = store.pagePath(documentId, id, 'original');
          const imagePath = store.pagePath(documentId, id, 'image');
          writtenPaths.push(originalPath, imagePath);
          await rename(image.path, originalPath);
          await copyFile(originalPath, imagePath);
          document.pages.push({
            id, width: image.width, height: image.height,
            originalWidth: image.width, originalHeight: image.height,
            imageFile: `${id}.image.jpg`, createdAt: timestamp, updatedAt: timestamp,
          });
        }
        document.updatedAt = timestamp;
        if (pairingToken) {
          const pairing = state.pairings[pairingToken];
          pairing.lastUploadAt = timestamp;
          pairing.uploadedCount += prepared.length;
        }
        return document;
      });
      emit('document-updated', saved.id, { updatedAt: saved.updatedAt });
      if (pairingToken) emit('pairing-updated', saved.id, { token: pairingToken });
      return saved;
    } catch (error) {
      await Promise.all(writtenPaths.map((filePath) => rm(filePath, { force: true })));
      throw error;
    }
  }

  app.post('/api/documents/:id/pages', (req, res, next) => {
    try { requireDocument(store.state, req.params.id); next(); } catch (error) { next(error); }
  }, receiving(upload.array('images', 30)), route(async (req, res) => {
    res.status(201).json(publicDocument(await addPages(req, req.params.id)));
  }));
  app.put('/api/documents/:id/pages/:pageId/image', (req, res, next) => {
    try { requirePage(requireDocument(store.state, req.params.id), req.params.pageId); next(); } catch (error) { next(error); }
  }, receiving(upload.single('image')), route(async (req, res) => {
    let edit = null;
    if (req.body?.edit !== undefined) {
      try {
        if (typeof req.body.edit !== 'string') throw new Error();
        const parsed = JSON.parse(req.body.edit);
        if (!validEditSettings(parsed)) throw new Error();
        edit = {
          rotation: parsed.rotation,
          corners: parsed.corners.map(({ x, y }) => ({ x, y })),
          mode: parsed.mode,
          brightness: parsed.brightness,
          contrast: parsed.contrast,
        };
      } catch {
        throw new HttpError(400, 'Thông số chỉnh sửa không hợp lệ. Hãy kiểm tra bốn góc, góc xoay và mức sáng/tương phản.');
      }
    }
    const [image] = await normalize(req, uploadedFiles(req), true);
    const imageFile = `${req.params.pageId}.edit-${randomUUID()}.jpg`;
    const newPath = path.join(store.documentPath(req.params.id), imageFile);
    let previousPath;
    let saved;
    try {
      saved = await store.mutate(async (state) => {
        if (req.setupAborted) throw new HttpError(400, 'Quá trình tải ảnh đã bị ngắt.');
        const document = requireDocument(state, req.params.id);
        const page = requirePage(document, req.params.pageId);
        previousPath = path.join(store.documentPath(document.id), page.imageFile);
        await rename(image.path, newPath);
        page.imageFile = imageFile;
        page.width = image.width;
        page.height = image.height;
        page.edit = edit;
        page.updatedAt = new Date(now()).toISOString();
        document.updatedAt = page.updatedAt;
        return document;
      });
    } catch (error) {
      await rm(newPath, { force: true });
      throw error;
    }
    emit('document-updated', saved.id, { updatedAt: saved.updatedAt });
    await rm(previousPath, { force: true });
    res.json(publicDocument(saved));
  }));
  app.delete('/api/documents/:id/pages/:pageId', route(async (req, res) => {
    let deletedPage;
    const saved = await store.mutate((state) => {
      const document = requireDocument(state, req.params.id);
      deletedPage = requirePage(document, req.params.pageId);
      document.pages = document.pages.filter((page) => page.id !== req.params.pageId);
      document.updatedAt = new Date(now()).toISOString();
      return document;
    });
    emit('document-updated', saved.id, { updatedAt: saved.updatedAt });
    await Promise.all([
      rm(store.pagePath(saved.id, deletedPage.id, 'original'), { force: true }),
      rm(path.join(store.documentPath(saved.id), deletedPage.imageFile), { force: true }),
    ]);
    res.json(publicDocument(saved));
  }));
  for (const kind of ['original', 'image']) {
    app.get(`/api/documents/:id/pages/:pageId/${kind}`, route(async (req, res) => {
      const bytes = await store.read(async (state) => {
        const document = requireDocument(state, req.params.id);
        const page = requirePage(document, req.params.pageId);
        const filePath = kind === 'original' ? store.pagePath(document.id, page.id, 'original')
          : path.join(store.documentPath(document.id), page.imageFile);
        return readFile(filePath);
      });
      res.type('jpeg').send(bytes);
    }));
  }
  app.get('/api/documents/:id/pdf', route(async (req, res) => {
    const paper = req.query.paper || 'a4';
    if (!['a4', 'original'].includes(paper)) throw new HttpError(400, 'Khổ giấy PDF chưa được hỗ trợ.');
    const { document, images } = await store.read(async (state) => {
      const document = requireDocument(state, req.params.id);
      if (!document.pages.length) throw new HttpError(400, 'Hãy thêm ít nhất một trang trước khi xuất PDF.');
      const images = [];
      for (const page of document.pages) {
        images.push(await readFile(path.join(store.documentPath(document.id), page.imageFile)));
      }
      return { document: structuredClone(document), images };
    });
    const pdf = await PDFDocument.create();
    pdf.setTitle(document.title);
    pdf.setCreator('myscan');
    for (const bytes of images) {
      const image = await pdf.embedJpg(bytes);
      const landscape = image.width > image.height;
      const [paperWidth, paperHeight] = paper === 'original' ? [image.width, image.height]
        : (landscape ? [PageSizes.A4[1], PageSizes.A4[0]] : PageSizes.A4);
      const page = pdf.addPage([paperWidth, paperHeight]);
      const margin = paper === 'original' ? 0 : 18;
      const scale = Math.min((paperWidth - 2 * margin) / image.width, (paperHeight - 2 * margin) / image.height);
      const width = image.width * scale;
      const height = image.height * scale;
      page.drawImage(image, { x: (paperWidth - width) / 2, y: (paperHeight - height) / 2, width, height });
    }
    const filename = `${document.title.replace(/[\\/\r\n\x00-\x1f]/g, '_')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    const encodedFilename = encodeURIComponent(filename).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    res.setHeader('Content-Disposition', `attachment; filename="myscan.pdf"; filename*=UTF-8''${encodedFilename}`);
    res.send(Buffer.from(await pdf.save()));
  }));

  app.post('/api/documents/:id/pair', route(async (req, res) => {
    const token = randomBytes(24).toString('base64url');
    const saved = await store.mutate((state) => {
      requireDocument(state, req.params.id);
      for (const [oldToken, pairing] of Object.entries(state.pairings)) {
        if (Date.parse(pairing.expiresAt) <= now()) delete state.pairings[oldToken];
      }
      const pairing = {
        token, documentId: req.params.id, expiresAt: new Date(now() + pairTtlMs).toISOString(),
        openedAt: null, lastUploadAt: null, uploadedCount: 0,
      };
      state.pairings[token] = pairing;
      return pairing;
    });
    res.status(201).json(pairStatus(saved));
  }));
  app.get('/api/documents/:id/pair/:token', route(async (req, res) => {
    requireDocument(store.state, req.params.id);
    const pairing = requirePair(store.state, req.params.token, now);
    if (pairing.documentId !== req.params.id) throw new HttpError(404, 'Không tìm thấy liên kết kết nối.');
    res.json(pairStatus(pairing));
  }));
  app.delete('/api/documents/:id/pair/:token', route(async (req, res) => {
    await store.mutate((state) => {
      requireDocument(state, req.params.id);
      const pairing = state.pairings[req.params.token];
      if (!TOKEN_PATTERN.test(req.params.token) || !pairing || pairing.documentId !== req.params.id) {
        throw new HttpError(404, 'Không tìm thấy liên kết kết nối.');
      }
      delete state.pairings[req.params.token];
    });
    emit('pairing-updated', req.params.id, { token: req.params.token });
    res.status(204).end();
  }));
  app.get('/api/capture/:token', route(async (req, res) => {
    const pairing = requirePair(store.state, req.params.token, now);
    if (!pairing.openedAt) {
      await store.mutate((state) => {
        const current = requirePair(state, req.params.token, now);
        if (!current.openedAt) current.openedAt = new Date(now()).toISOString();
      });
      emit('pairing-updated', pairing.documentId, { token: req.params.token });
    }
    const current = requirePair(store.state, req.params.token, now);
    const document = requireDocument(store.state, current.documentId);
    res.json({ document: { id: document.id, title: document.title, pageCount: document.pages.length }, expiresAt: current.expiresAt });
  }));
  app.post('/api/capture/:token/pages', (req, res, next) => {
    try { requirePair(store.state, req.params.token, now); next(); } catch (error) { next(error); }
  }, receiving(upload.array('images', 30)), route(async (req, res) => {
    const pairing = requirePair(store.state, req.params.token, now);
    const document = await addPages(req, pairing.documentId, req.params.token);
    res.status(201).json({ document: { id: document.id, title: document.title, pageCount: document.pages.length }, addedCount: uploadedFiles(req).length });
  }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Không tìm thấy chức năng này.' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === 'LIMIT_FILE_SIZE';
      const message = tooLarge ? `Mỗi ảnh không được vượt quá ${Math.round(maxFileBytes / 1024 / 1024)} MB.`
        : 'Số lượng ảnh hoặc dữ liệu tải lên vượt giới hạn. Hãy gửi tối đa 30 ảnh mỗi lần.';
      return res.status(tooLarge ? 413 : 400).json({ error: message });
    }
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Dữ liệu gửi lên quá lớn.' });
    if (error instanceof SyntaxError && error.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Dữ liệu JSON không hợp lệ.' });
    }
    const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 500;
    if (status === 500) console.error('myscan request failed:', error.message);
    res.status(status).json({ error: status === 500 ? 'Không thể xử lý yêu cầu. Vui lòng thử lại.' : error.message });
  });
  return app;
}
