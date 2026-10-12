import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { createApp } from '../server/app.js';

async function serve(dataDir, options = {}) {
  const app = await createApp({ dataDir, ...options });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authStatus = await fetch(`${baseUrl}/api/auth`).then((response) => response.json());
  const authResponse = await fetch(`${baseUrl}/api/auth/${authStatus.configured ? 'login' : 'setup'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-password-123' }),
  });
  assert.ok(authResponse.ok, `Owner authentication failed with ${authResponse.status}`);
  const cookie = authResponse.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'Owner authentication must issue a session cookie');
  await authResponse.arrayBuffer();
  let closed = false;
  return {
    baseUrl,
    cookie,
    async close() {
      if (closed) return;
      closed = true;
      const finished = new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      server.closeAllConnections();
      await finished;
    },
  };
}

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'myscan-api-'));
  const service = await serve(dataDir, options);
  t.after(async () => {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { ...service, dataDir };
}

async function jsonRequest(service, path, method = 'GET', body) {
  const response = await fetch(`${service.baseUrl}${path}`, {
    method,
    headers: { Cookie: service.cookie, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? {
      body: JSON.stringify(body),
    } : {}),
  });
  return { response, body: response.status === 204 ? null : await response.json() };
}

async function createDocument(service, title = 'Tài liệu thử nghiệm') {
  const result = await jsonRequest(service, '/api/documents', 'POST', { title });
  assert.equal(result.response.status, 201);
  assert.equal(result.body.title, title);
  assert.ok(result.body.id);
  assert.deepEqual(result.body.pages, []);
  return result.body;
}

async function jpeg(width = 120, height = 80, color = '#3166cc', orientation) {
  let pipeline = sharp({ create: { width, height, channels: 3, background: color } });
  if (orientation) pipeline = pipeline.withMetadata({ orientation });
  return pipeline.jpeg().toBuffer();
}

async function upload(service, path, files, field = 'images', method = 'POST', fields = {}) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  for (const file of files) {
    form.append(field, new Blob([file.bytes], { type: file.type ?? 'image/jpeg' }), file.name ?? 'scan.jpg');
  }
  const response = await fetch(`${service.baseUrl}${path}`, { method, body: form, headers: { Cookie: service.cookie } });
  return { response, body: await response.json() };
}

async function imageBytes(service, path) {
  const response = await fetch(`${service.baseUrl}${path}`, { headers: { Cookie: service.cookie } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^image\//);
  return Buffer.from(await response.arrayBuffer());
}

function assertError(result, status) {
  assert.equal(result.response.status, status);
  assert.equal(typeof result.body.error, 'string');
  assert.ok(result.body.error.length > 0);
}

test('documents can be created, renamed, persisted across restart, and deleted', async (t) => {
  const first = await fixture(t);
  assert.deepEqual((await jsonRequest(first, '/api/documents')).body, { documents: [] });
  const document = await createDocument(first);
  const uploaded = await upload(first, `/api/documents/${document.id}/pages`, [{ bytes: await jpeg() }]);
  assert.equal(uploaded.response.status, 201);
  assert.equal(uploaded.body.pages.length, 1);
  const renamed = await jsonRequest(first, `/api/documents/${document.id}`, 'PATCH', { title: 'Hồ sơ tháng 10' });
  assert.equal(renamed.response.status, 200);
  assert.equal(renamed.body.title, 'Hồ sơ tháng 10');
  const originalImage = await imageBytes(first, renamed.body.pages[0].imageUrl);

  await first.close();
  const restarted = await serve(first.dataDir);
  t.after(() => restarted.close());
  const loaded = await jsonRequest(restarted, `/api/documents/${document.id}`);
  assert.equal(loaded.response.status, 200);
  assert.deepEqual(loaded.body, renamed.body);
  assert.deepEqual(await imageBytes(restarted, loaded.body.pages[0].imageUrl), originalImage);
  const listed = await jsonRequest(restarted, '/api/documents');
  assert.equal(listed.body.documents.length, 1);
  assert.equal(listed.body.documents[0].id, document.id);
  assert.equal((await jsonRequest(restarted, `/api/documents/${document.id}`, 'DELETE')).response.status, 204);
  assert.deepEqual((await jsonRequest(restarted, '/api/documents')).body.documents, []);
  assertError(await jsonRequest(restarted, `/api/documents/${document.id}`), 404);
});

test('uploads normalize camera orientation and editing keeps the original image', async (t) => {
  const service = await fixture(t);
  const document = await createDocument(service);
  const uploaded = await upload(service, `/api/documents/${document.id}/pages`, [{ bytes: await jpeg(120, 80, '#fff', 6) }]);
  assert.equal(uploaded.response.status, 201);
  const page = uploaded.body.pages[0];
  assert.equal(page.width, 80);
  assert.equal(page.height, 120);
  assert.equal(page.originalWidth, 80);
  assert.equal(page.originalHeight, 120);
  const before = await imageBytes(service, page.imageUrl);
  const original = await imageBytes(service, page.originalUrl);
  const metadata = await sharp(before).metadata();
  assert.equal(metadata.width, 80);
  assert.equal(metadata.height, 120);
  assert.ok(metadata.orientation === undefined || metadata.orientation === 1);

  const edited = await upload(service, `/api/documents/${document.id}/pages/${page.id}/image`, [{ bytes: await jpeg(40, 30, '#111') }], 'image', 'PUT');
  assert.equal(edited.response.status, 200);
  assert.equal(edited.body.pages[0].width, 40);
  assert.equal(edited.body.pages[0].height, 30);
  assert.equal(edited.body.pages[0].originalWidth, 80);
  assert.equal(edited.body.pages[0].originalHeight, 120);
  assert.deepEqual(await imageBytes(service, page.originalUrl), original);
  assert.notDeepEqual(await imageBytes(service, page.imageUrl), before);
});

test('page order is a complete permutation and PDF follows that order', async (t) => {
  const service = await fixture(t);
  const document = await createDocument(service, 'Bộ tài liệu');
  const uploaded = await upload(service, `/api/documents/${document.id}/pages`, [
    { bytes: await jpeg(120, 80, '#c33'), name: 'first.jpg' },
    { bytes: await jpeg(80, 120, '#3c3'), name: 'second.jpg' },
    { bytes: await jpeg(120, 80, '#33c'), name: 'third.jpg' },
  ]);
  assert.equal(uploaded.response.status, 201);
  const ids = uploaded.body.pages.map((page) => page.id);
  assert.equal(new Set(ids).size, 3);
  assertError(await jsonRequest(service, `/api/documents/${document.id}`, 'PATCH', { pageOrder: [ids[0], ids[0], ids[2]] }), 400);
  assertError(await jsonRequest(service, `/api/documents/${document.id}`, 'PATCH', { pageOrder: ids.slice(1) }), 400);
  const reordered = await jsonRequest(service, `/api/documents/${document.id}`, 'PATCH', { pageOrder: [ids[1], ids[2], ids[0]] });
  assert.equal(reordered.response.status, 200);
  assert.deepEqual(reordered.body.pages.map((page) => page.id), [ids[1], ids[2], ids[0]]);
  const response = await fetch(`${service.baseUrl}/api/documents/${document.id}/pdf`, { headers: { Cookie: service.cookie } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/pdf/);
  const pdf = await PDFDocument.load(await response.arrayBuffer());
  assert.equal(pdf.getPageCount(), 3);
  const pages = pdf.getPages();
  assert.ok(pages[0].getWidth() < pages[0].getHeight());
  assert.ok(pages[1].getWidth() > pages[1].getHeight());
  const deleted = await jsonRequest(service, `/api/documents/${document.id}/pages/${ids[2]}`, 'DELETE');
  assert.equal(deleted.response.status, 200);
  assert.deepEqual(deleted.body.pages.map((page) => page.id), [ids[1], ids[0]]);
  assertError(await jsonRequest(service, `/api/documents/${document.id}/pages/${ids[2]}/image`), 404);
});

test('phone pairing records connection and uploads only to its selected document', async (t) => {
  const service = await fixture(t);
  const selected = await createDocument(service, 'Từ điện thoại');
  const other = await createDocument(service, 'Tài liệu khác');
  const paired = await jsonRequest(service, `/api/documents/${selected.id}/pair`, 'POST');
  assert.equal(paired.response.status, 201);
  assert.ok(paired.body.token);
  assert.ok(paired.body.path.endsWith(`/capture/${paired.body.token}`));
  assert.equal(paired.body.openedAt, null);
  assert.equal(paired.body.lastUploadAt, null);
  assert.equal(paired.body.uploadedCount, 0);
  const capture = await jsonRequest(service, `/api/capture/${paired.body.token}`);
  assert.equal(capture.response.status, 200);
  assert.deepEqual(capture.body.document, { id: selected.id, title: selected.title, pageCount: 0 });
  const uploaded = await upload(service, `/api/capture/${paired.body.token}/pages`, [{ bytes: await jpeg() }]);
  assert.equal(uploaded.response.status, 201);
  assert.deepEqual(uploaded.body.document, { id: selected.id, title: selected.title, pageCount: 1 });
  assert.equal(uploaded.body.addedCount, 1);
  assert.equal(uploaded.body.pages, undefined);
  const status = await jsonRequest(service, `/api/documents/${selected.id}/pair/${paired.body.token}`);
  assert.equal(status.response.status, 200);
  assert.ok(status.body.openedAt);
  assert.ok(status.body.lastUploadAt);
  assert.equal(status.body.uploadedCount, 1);
  assertError(await jsonRequest(service, `/api/documents/${other.id}/pair/${paired.body.token}`), 404);
  assert.equal((await jsonRequest(service, `/api/documents/${other.id}`)).body.pages.length, 0);
});

test('expired, revoked, and invalid pairing tokens cannot upload images', async (t) => {
  let now = Date.now();
  const service = await fixture(t, { now: () => now, pairTtlMs: 1000 });
  const document = await createDocument(service);
  const paired = await jsonRequest(service, `/api/documents/${document.id}/pair`, 'POST');
  now += 1001;
  assertError(await jsonRequest(service, `/api/capture/${paired.body.token}`), 410);
  assertError(await upload(service, `/api/capture/${paired.body.token}/pages`, [{ bytes: await jpeg() }]), 410);
  assertError(await jsonRequest(service, '/api/capture/not-a-valid-token'), 404);
  const active = await jsonRequest(service, `/api/documents/${document.id}/pair`, 'POST');
  const revoked = await jsonRequest(service, `/api/documents/${document.id}/pair/${active.body.token}`, 'DELETE');
  assert.equal(revoked.response.status, 204);
  assertError(await jsonRequest(service, `/api/capture/${active.body.token}`), 404);
  assertError(await upload(service, `/api/capture/${active.body.token}/pages`, [{ bytes: await jpeg() }]), 404);
  assert.equal((await jsonRequest(service, `/api/documents/${document.id}`)).body.pages.length, 0);
});

test('corrupt and unsupported images fail without adding document pages', async (t) => {
  const service = await fixture(t);
  const document = await createDocument(service);
  assertError(await upload(service, `/api/documents/${document.id}/pages`, [{ bytes: Buffer.from('not a valid jpeg') }]), 400);
  assertError(await upload(service, `/api/documents/${document.id}/pages`, [{
    bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'),
    type: 'image/svg+xml', name: 'unsupported.svg',
  }]), 400);
  assertError(await upload(service, `/api/documents/${document.id}/pages`, []), 400);
  assert.equal((await jsonRequest(service, `/api/documents/${document.id}`)).body.pages.length, 0);
});

test('oversize image uploads return an actionable JSON error', async (t) => {
  const service = await fixture(t, { maxFileBytes: 256 });
  const document = await createDocument(service);
  const bytes = await jpeg();
  assert.ok(bytes.length > 256);
  assertError(await upload(service, `/api/documents/${document.id}/pages`, [{ bytes }]), 413);
  assert.equal((await jsonRequest(service, `/api/documents/${document.id}`)).body.pages.length, 0);
});

test('unknown document and image paths return JSON errors', async (t) => {
  const service = await fixture(t);
  const document = await createDocument(service);
  assertError(await jsonRequest(service, '/api/documents/not-a-document'), 404);
  assertError(await upload(service, '/api/documents/not-a-document/pages', [{ bytes: await jpeg() }]), 404);
  assertError(await jsonRequest(service, `/api/documents/${document.id}/pages/not-a-page/image`), 404);
  assertError(await upload(service, `/api/documents/${document.id}/pages/not-a-page/image`, [{ bytes: await jpeg() }], 'image', 'PUT'), 404);
  assertError(await jsonRequest(service, `/api/documents/${document.id}/pdf`), 400);
});

test('owner authentication protects documents without blocking paired phone access', async (t) => {
  const service = await fixture(t);
  const document = await createDocument(service);
  const unauthenticated = { ...service, cookie: '' };
  assertError(await jsonRequest(unauthenticated, '/api/documents'), 401);
  assertError(await jsonRequest(unauthenticated, `/api/documents/${document.id}`), 401);
  assertError(await jsonRequest(unauthenticated, '/api/auth/login', 'POST', { password: 'incorrect-password' }), 401);
  assertError(await jsonRequest(unauthenticated, '/api/auth/setup', 'POST', { password: 'another-password' }), 409);
  const paired = await jsonRequest(service, `/api/documents/${document.id}/pair`, 'POST');
  assert.equal((await jsonRequest(unauthenticated, `/api/capture/${paired.body.token}`)).response.status, 200);
  const uploaded = await upload(unauthenticated, `/api/capture/${paired.body.token}/pages`, [{ bytes: await jpeg() }]);
  assert.equal(uploaded.response.status, 201);
  assert.equal(uploaded.body.document.pageCount, 1);
  assert.equal(uploaded.body.addedCount, 1);
  const updated = await jsonRequest(service, `/api/documents/${document.id}`);
  const page = updated.body.pages[0];
  assertError(await jsonRequest(unauthenticated, page.imageUrl), 401);
  assertError(await jsonRequest(unauthenticated, page.originalUrl), 401);
  assertError(await jsonRequest(unauthenticated, `/api/documents/${document.id}/pdf`), 401);
});

test('owner mutations reject a foreign browser origin even with a valid session', async (t) => {
  const service = await fixture(t);
  const document = await createDocument(service);
  const response = await fetch(`${service.baseUrl}/api/documents/${document.id}`, {
    method: 'PATCH',
    headers: {
      Cookie: service.cookie,
      'Content-Type': 'application/json',
      Origin: 'https://foreign.example',
    },
    body: JSON.stringify({ title: 'Tên bị thay đổi' }),
  });
  assertError({ response, body: await response.json() }, 403);
  assert.equal((await jsonRequest(service, `/api/documents/${document.id}`)).body.title, document.title);
  const sameOrigin = await fetch(`${service.baseUrl}/api/documents/${document.id}`, {
    method: 'PATCH',
    headers: { Cookie: service.cookie, 'Content-Type': 'application/json', Origin: service.baseUrl },
    body: JSON.stringify({ title: 'Tên cập nhật hợp lệ' }),
  });
  assert.equal(sameOrigin.status, 200);
  assert.equal((await sameOrigin.json()).title, 'Tên cập nhật hợp lệ');
});

test('an owner event stream closes after logout before delivering phone upload events', async (t) => {
  const service = await fixture(t);
  const document = await createDocument(service);
  const paired = await jsonRequest(service, `/api/documents/${document.id}/pair`, 'POST');
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${service.baseUrl}/api/events`, {
    headers: { Cookie: service.cookie },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const reader = response.body.getReader();
  const initial = await reader.read();
  assert.equal(initial.done, false);
  assert.match(new TextDecoder().decode(initial.value), /: connected/);
  assert.equal((await jsonRequest(service, '/api/auth/logout', 'POST')).response.status, 204);
  const uploaded = await upload({ ...service, cookie: '' }, `/api/capture/${paired.body.token}/pages`, [{ bytes: await jpeg() }]);
  assert.equal(uploaded.response.status, 201);
  let timeout;
  try {
    const next = await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Logged-out owner event stream did not close')), 1500);
      }),
    ]);
    assert.equal(next.done, true, `Logged-out owner received an event: ${new TextDecoder().decode(next.value)}`);
  } finally {
    clearTimeout(timeout);
  }
});

test('owner cookie security follows the validated browser origin for HTTP and HTTPS access', async (t) => {
  const service = await fixture(t, { publicUrl: 'https://scan.example.test' });
  for (const [origin, shouldBeSecure] of [
    [service.baseUrl.replace('http:', 'https:'), true],
    [service.baseUrl, false],
  ]) {
    const response = await fetch(`${service.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ password: 'test-password-123' }),
    });
    assert.equal(response.status, 200);
    // Inspect attributes without exposing the session value in assertion output.
    const attributes = response.headers.get('set-cookie')?.split(';').slice(1)
      .map((attribute) => attribute.trim().toLowerCase());
    assert.ok(attributes);
    assert.equal(attributes.includes('secure'), shouldBeSecure);
    assert.ok(attributes.includes('httponly'));
    assert.ok(attributes.includes('samesite=strict'));
    await response.arrayBuffer();
  }
});

const VALID_EDIT = {
  rotation: 90,
  corners: [{ x: 0.05, y: 0.1 }, { x: 0.95, y: 0.05 }, { x: 0.9, y: 0.95 }, { x: 0.1, y: 0.9 }],
  mode: 'grayscale',
  brightness: 12,
  contrast: -18,
};

test('edited image settings survive restart and invalid settings leave saved image and settings intact', async (t) => {
  const initial = await fixture(t);
  const document = await createDocument(initial);
  const uploaded = await upload(initial, `/api/documents/${document.id}/pages`, [{ bytes: await jpeg() }]);
  const page = uploaded.body.pages[0];
  assert.equal(page.edit, null);
  const path = `/api/documents/${document.id}/pages/${page.id}/image`;
  const updated = await upload(initial, path, [{ bytes: await jpeg(60, 90, '#222') }], 'image', 'PUT', {
    edit: JSON.stringify(VALID_EDIT),
  });
  assert.equal(updated.response.status, 200);
  assert.deepEqual(updated.body.pages[0].edit, VALID_EDIT);
  const editedBytes = await imageBytes(initial, page.imageUrl);

  await initial.close();
  const restarted = await serve(initial.dataDir);
  t.after(() => restarted.close());
  assert.deepEqual((await jsonRequest(restarted, `/api/documents/${document.id}`)).body.pages[0].edit, VALID_EDIT);
  assert.deepEqual(await imageBytes(restarted, page.imageUrl), editedBytes);
  const invalidEdits = [
    ['unsupported rotation', JSON.stringify({ ...VALID_EDIT, rotation: 45 })],
    ['corner outside image', JSON.stringify({ ...VALID_EDIT, corners: [{ x: -0.1, y: 0 }, ...VALID_EDIT.corners.slice(1)] })],
    ['concave corners', JSON.stringify({ ...VALID_EDIT, corners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.2, y: 0.2 }, { x: 0, y: 1 }] })],
    ['reversed corner order', JSON.stringify({ ...VALID_EDIT, corners: [...VALID_EDIT.corners].reverse() })],
    ['invalid JSON number', JSON.stringify(VALID_EDIT).replace('"brightness":12', '"brightness":NaN')],
    ['unknown color mode', JSON.stringify({ ...VALID_EDIT, mode: 'sepia' })],
    ['brightness outside range', JSON.stringify({ ...VALID_EDIT, brightness: 61 })],
    ['contrast outside range', JSON.stringify({ ...VALID_EDIT, contrast: -61 })],
  ];
  const replacement = await jpeg(30, 40, '#f00');
  for (const [name, edit] of invalidEdits) {
    const rejected = await upload(restarted, path, [{ bytes: replacement }], 'image', 'PUT', { edit });
    assertError(rejected, 400);
    const current = await jsonRequest(restarted, `/api/documents/${document.id}`);
    assert.deepEqual(current.body.pages[0].edit, VALID_EDIT, name);
    assert.deepEqual(await imageBytes(restarted, page.imageUrl), editedBytes, name);
  }
  const omitted = await upload(restarted, path, [{ bytes: replacement }], 'image', 'PUT');
  assert.equal(omitted.response.status, 200);
  assert.equal(omitted.body.pages[0].edit, null);
  assert.equal((await jsonRequest(restarted, `/api/documents/${document.id}`)).body.pages[0].edit, null);
});

test('corrupt metadata is rejected without rewriting metadata or existing image files', async (t) => {
  const source = await fixture(t);
  const document = await createDocument(source);
  const uploaded = await upload(source, `/api/documents/${document.id}/pages`, [{ bytes: await jpeg() }]);
  const page = uploaded.body.pages[0];
  const paired = await jsonRequest(source, `/api/documents/${document.id}/pair`, 'POST');
  await source.close();
  const saved = JSON.parse(await readFile(join(source.dataDir, 'metadata.json'), 'utf8'));
  const cases = [
    ['documents must be an object', (state) => { state.documents = []; }],
    ['pairings must be an object', (state) => { state.pairings = []; }],
    ['image filename cannot traverse directories', (state) => { state.documents[document.id].pages[0].imageFile = '../outside.jpg'; }],
    ['document id must match its key', (state) => { state.documents[document.id].id = '00000000-0000-0000-0000-000000000000'; }],
    ['page dimensions are required', (state) => { delete state.documents[document.id].pages[0].width; }],
    ['page dimensions must be positive', (state) => { state.documents[document.id].pages[0].height = 0; }],
    ['original dimensions are required', (state) => { delete state.documents[document.id].pages[0].originalHeight; }],
    ['document dates must be valid', (state) => { state.documents[document.id].updatedAt = 'invalid-date'; }],
    ['page dates must be valid', (state) => { state.documents[document.id].pages[0].createdAt = 'invalid-date'; }],
    ['document titles must be nonempty', (state) => { state.documents[document.id].title = '   '; }],
    ['saved editing settings must be valid', (state) => { state.documents[document.id].pages[0].edit = { ...VALID_EDIT, rotation: 45 }; }],
    ['pairing must refer to an existing document', (state) => { state.pairings[paired.body.token].documentId = '00000000-0000-0000-0000-000000000000'; }],
    ['pairing dates must be valid', (state) => { state.pairings[paired.body.token].expiresAt = 'invalid-date'; }],
  ];
  for (const [name, corrupt] of cases) {
    await t.test(name, async (subtest) => {
      const dataDir = await mkdtemp(join(tmpdir(), 'myscan-corrupt-'));
      subtest.after(() => rm(dataDir, { recursive: true, force: true }));
      await cp(source.dataDir, dataDir, { recursive: true });
      const metadata = structuredClone(saved);
      corrupt(metadata);
      const metadataBytes = Buffer.from(JSON.stringify(metadata, null, 2));
      const metadataPath = join(dataDir, 'metadata.json');
      const originalPath = join(dataDir, 'documents', document.id, `${page.id}.original.jpg`);
      const imagePath = join(dataDir, 'documents', document.id, `${page.id}.image.jpg`);
      const originalMarker = Buffer.from('Existing original image marker');
      const editedMarker = Buffer.from('Existing edited image marker');
      await writeFile(metadataPath, metadataBytes);
      await writeFile(originalPath, originalMarker);
      await writeFile(imagePath, editedMarker);
      await assert.rejects(() => createApp({ dataDir }));
      assert.deepEqual(await readFile(metadataPath), metadataBytes);
      assert.deepEqual(await readFile(originalPath), originalMarker);
      assert.deepEqual(await readFile(imagePath), editedMarker);
    });
  }
});
