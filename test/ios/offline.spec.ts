import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';

// These checks run the generated static site with real IndexedDB and service
// workers. An iPhone-sized viewport is emulation, not a physical Safari device.
async function photo(name: string, color: string, width = 180, height = 260) {
  return { name, mimeType: 'image/jpeg', buffer: await sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer() };
}

async function create(page: Page, title: string) {
  await page.goto('./');
  await page.getByRole('button', { name: 'Tài liệu mới', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Tên tài liệu' });
  await input.pressSequentially(title);
  await expect(input).toHaveValue(title);
  await expect(input).toBeFocused();
  await page.getByRole('button', { name: 'Tạo tài liệu', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByTestId('gallery-input')).toBeEnabled();
}

async function importPhotos(page: Page, files: Awaited<ReturnType<typeof photo>>[]) {
  await expect(page.getByTestId('gallery-input')).toBeEnabled();
  await page.getByTestId('gallery-input').setInputFiles(files);
  await expect(page.getByText(`Đã lưu ${files.length} trang trên thiết bị này.`, { exact: true })).toBeVisible();
  await expect(page.getByTestId('gallery-input')).toBeEnabled();
}

async function library(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('myscan-ios-offline');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(['documents', 'images'], 'readonly');
    const documentsRequest = tx.objectStore('documents').getAll();
    const imagesRequest = tx.objectStore('images').getAll();
    const records = await Promise.all([documentsRequest, imagesRequest].map((request) => new Promise<any[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    })));
    db.close();
    const images = await Promise.all(records[1].map(async (record) => {
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await record.blob.arrayBuffer())))
        .map((byte) => byte.toString(16).padStart(2, '0')).join('');
      return { key: record.key as string, pageId: record.pageId as string, kind: record.kind as string, hash, size: record.blob.size as number };
    }));
    return { documents: records[0], images };
  });
}

async function exportPdf(page: Page, paper = 'image') {
  await page.getByRole('button', { name: 'Xuất PDF', exact: true }).click();
  await page.getByLabel('Khổ trang').selectOption(paper);
  await page.getByRole('button', { name: 'Chuẩn bị PDF', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'PDF đã sẵn sàng' })).toBeVisible();
  const pending = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Tải PDF', exact: true }).click();
  const download = await pending;
  expect(await download.failure()).toBeNull();
  const filename = await download.path();
  expect(filename).not.toBeNull();
  return PDFDocument.load(await readFile(filename!));
}

function embeddedHashes(pdf: PDFDocument) {
  return pdf.getPages().map((page) => {
    const resources = page.node.Resources()!;
    const objects = resources.lookup(PDFName.of('XObject'), PDFDict);
    expect(objects.keys()).toHaveLength(1);
    const stream = objects.lookup(objects.keys()[0], PDFRawStream);
    return createHash('sha256').update(stream.getContents()).digest('hex');
  });
}

test('typing, editing and reordering persist, originals stay intact, PDF contains actual pages in order', async ({ page }) => {
  const failures: string[] = []; page.on('pageerror', (error) => failures.push(error.message));
  await create(page, 'Hồ sơ iPhone');
  await importPhotos(page, [await photo('red.jpg', '#e32340'), await photo('blue.jpg', '#174de5', 220, 150)]);
  const before = await library(page);
  const originalHashes = before.images.filter((image) => image.kind === 'original').map((image) => [image.key, image.hash]);
  await page.getByRole('button', { name: 'Mở trang 1', exact: true }).click();
  await page.getByRole('button', { name: 'Chỉnh sửa', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Chỉnh ảnh quét' });
  await editor.getByRole('button', { name: 'Xoay 90°', exact: true }).click();
  await editor.getByRole('button', { name: 'Thang xám', exact: true }).click();
  const corner = editor.getByRole('button', { name: 'Góc trên trái', exact: true });
  const handle = await corner.boundingBox(); const image = await editor.locator('.ios-editor-image').boundingBox();
  expect(handle).not.toBeNull(); expect(image).not.toBeNull();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(image!.x + image!.width * 0.08, image!.y + image!.height * 0.08, { steps: 5 });
  await page.mouse.up();
  await editor.getByRole('button', { name: 'Lưu trang', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(page.getByText('Đã lưu bản scan. Ảnh gốc vẫn được giữ riêng.', { exact: true })).toBeVisible();
  const edited = await library(page);
  expect(edited.documents[0].pages[0].edit.rotation).toBe(90);
  expect(edited.documents[0].pages[0].edit.mode).toBe('grayscale');
  expect(edited.documents[0].pages[0].edit.corners[0].x).toBeGreaterThan(0.04);
  expect(edited.images.filter((entry) => entry.kind === 'original').map((entry) => [entry.key, entry.hash])).toEqual(originalHashes);
  const grayscale = await page.getByTestId('page-preview').locator('img').evaluate(async (img: HTMLImageElement) => {
    await img.decode(); const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(img, 0, 0); const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let maxDifference = 0; for (let i = 0; i < pixels.length; i += 4) maxDifference = Math.max(maxDifference, Math.abs(pixels[i] - pixels[i + 1]), Math.abs(pixels[i] - pixels[i + 2]));
    return maxDifference;
  });
  expect(grayscale).toBeLessThanOrEqual(2);
  await page.getByRole('button', { name: 'Chuyển trang xuống', exact: true }).click();
  await expect(page.getByTestId('gallery-input')).toBeEnabled();
  await page.reload();
  await page.getByRole('button', { name: /Hồ sơ iPhone/ }).click();
  const reloaded = await library(page);
  expect(reloaded.documents[0].pages.map((entry: any) => entry.id)).toEqual([before.documents[0].pages[1].id, before.documents[0].pages[0].id]);
  expect(reloaded.documents[0].pages[1].edit).toEqual(edited.documents[0].pages[0].edit);
  const pdf = await exportPdf(page);
  expect(pdf.getPageCount()).toBe(2);
  expect(pdf.getTitle()).toBe('Hồ sơ iPhone');
  const expected = reloaded.documents[0].pages.map((entry: any) => reloaded.images.find((image) => image.pageId === entry.id && image.kind === (entry.edit ? 'edited' : 'original'))!.hash);
  expect(embeddedHashes(pdf)).toEqual(expected);
  expect(failures).toEqual([]);
});

test('first session is usable offline before PDF chunk loads, and a cold offline tab can edit and export', async ({ page, context }) => {
  await create(page, 'Quét khi mất mạng');
  await importPhotos(page, [await photo('offline.jpg', '#39896f')]);
  await expect(page.getByText('Sẵn sàng offline', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await context.setOffline(true);
  // No previous PDF operation: its dynamic module must come from SW precache.
  const firstPdf = await exportPdf(page, 'a4');
  expect(firstPdf.getPageCount()).toBe(1);
  const cold = await context.newPage();
  await cold.goto('./');
  await cold.getByRole('button', { name: /Quét khi mất mạng/ }).click();
  await cold.getByRole('button', { name: 'Chỉnh sửa', exact: true }).click();
  const editor = cold.getByRole('dialog', { name: 'Chỉnh ảnh quét' });
  await editor.getByRole('button', { name: 'Đen trắng', exact: true }).click();
  await editor.getByRole('button', { name: 'Lưu trang', exact: true }).click();
  await expect(editor).not.toBeVisible();
  const coldPdf = await exportPdf(cold);
  expect(coldPdf.getPageCount()).toBe(1);
  expect(await cold.evaluate(() => navigator.onLine)).toBe(false);
  await context.setOffline(false);
});

test('a mixed image batch preserves valid pages and reports unreadable files without breaking the library', async ({ page }) => {
  await create(page, 'Ảnh cần kiểm tra');
  await page.getByTestId('gallery-input').setInputFiles([
    { name: 'damaged.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not an image') },
    await photo('valid.jpg', '#cfe367'),
  ]);
  await expect(page.getByRole('alert')).toContainText('damaged.jpg');
  await expect(page.getByText('Đã lưu 1 trang trên thiết bị này.', { exact: true })).toBeVisible();
  expect((await library(page)).documents[0].pages).toHaveLength(1);
  await page.getByRole('button', { name: 'Đóng thông báo', exact: true }).click();
  await importPhotos(page, [await photo('next.jpg', '#6ba7df')]);
  await page.reload();
  await page.getByRole('button', { name: /Ảnh cần kiểm tra/ }).click();
  expect((await library(page)).documents[0].pages).toHaveLength(2);
});

test('corrupt metadata fails closed while original image bytes remain in IndexedDB', async ({ page }) => {
  await create(page, 'Hồ sơ giữ nguyên');
  await importPhotos(page, [await photo('preserved.jpg', '#df9363')]);
  const before = await library(page);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('myscan-ios-offline'); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('documents', 'readwrite'); const store = tx.objectStore('documents'); const request = store.getAll();
      request.onsuccess = () => { const doc = request.result[0]; doc.pages[0].width = -1; store.put(doc); };
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Chưa mở được thư viện', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Dữ liệu tài liệu không hợp lệ');
  const after = await library(page);
  expect(after.images).toEqual(before.images);
  expect(after.documents).toHaveLength(1);
  expect(after.documents[0].pages[0].width).toBe(-1);
});
