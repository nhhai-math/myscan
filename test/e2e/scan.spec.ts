import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';

type ScanPage = { id: string; originalUrl: string; imageUrl: string; width: number; height: number };
type ScanDocument = { id: string; title: string; pages: ScanPage[] };

let fixtureDir: string;
let fixtures: string[];

test.beforeAll(async () => {
  fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'myscan-e2e-images-'));
  fixtures = [];
  for (const [index, accent] of ['#0e8877', '#2670ba', '#c27c30'].entries()) {
    const imagePath = path.join(fixtureDir, `scan-page-${index + 1}.jpg`);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="960">
      <rect width="720" height="960" fill="#536758" />
      <path d="M55 45 L668 66 L655 906 L40 890 Z" fill="#fffdf6" />
      <rect x="100" y="110" width="100" height="26" rx="3" fill="${accent}" />
      <text x="100" y="200" font-family="sans-serif" font-size="37" fill="#233b33">SCAN DOCUMENT ${index + 1}</text>
      <text x="100" y="239" font-family="sans-serif" font-size="18" fill="#78867b">A document page for the browser test</text>
      <rect x="100" y="277" width="475" height="3" fill="#bfd1c4" />
      <rect x="100" y="321" width="400" height="12" fill="#526b5c" />
      <rect x="100" y="350" width="465" height="8" fill="#97a69b" />
      <rect x="100" y="380" width="443" height="8" fill="#97a69b" />
      <rect x="100" y="410" width="420" height="8" fill="#97a69b" />
      <rect x="100" y="470" width="475" height="205" rx="6" fill="${accent}" />
      <circle cx="200" cy="540" r="34" fill="#e7c669" />
      <path d="M110 655 L285 510 L410 612 L493 540 L564 655Z" fill="#ffffff66" />
      <rect x="100" y="722" width="457" height="8" fill="#97a69b" />
      <rect x="100" y="752" width="358" height="8" fill="#97a69b" />
      <text x="100" y="847" font-family="sans-serif" font-size="16" fill="#526b5c">PAGE ${index + 1} / 3</text>
    </svg>`;
    await sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toFile(imagePath);
    fixtures.push(imagePath);
  }
});

test.afterAll(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

test('desktop → paired phone → edit → reorder → PDF, with persisted originals and revoked pairing', async ({ page, browser, baseURL }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const documentTitle = 'Hồ sơ học tập · Kiểm tra quy trình';

  await test.step('set up the owner library through the UI', async () => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Bắt đầu với myscan.' })).toBeVisible();
    await page.getByLabel('Mật khẩu quản lý', { exact: true }).fill('myscan-e2e-fixture-password');
    await page.getByLabel('Nhập lại mật khẩu', { exact: true }).fill('myscan-e2e-fixture-password');
    await page.getByRole('button', { name: 'Tạo thư viện của tôi' }).click();
    await expect(page.getByRole('heading', { name: 'Thư viện của bạn.' })).toBeVisible();
  });

  let documentId = '';
  let firstPage: ScanPage;
  let originalBytes: Buffer;
  let pairLink = '';
  let pairToken = '';

  await test.step('create a document and import two real images', async () => {
    await page.getByRole('button', { name: 'Tài liệu mới', exact: true }).click();
    const createDialog = page.getByRole('dialog', { name: 'Một tài liệu mới.' });
    await createDialog.getByLabel('Tên tài liệu').fill(documentTitle);
    const created = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/documents' && response.request().method() === 'POST');
    await createDialog.getByRole('button', { name: 'Tạo tài liệu', exact: true }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    documentId = ((await response.json()) as ScanDocument).id;
    await expect(page.getByRole('heading', { name: documentTitle, exact: true })).toBeVisible();

    await page.getByLabel('Chọn ảnh để thêm vào tài liệu', { exact: true }).setInputFiles(fixtures.slice(0, 2));
    await expect(page.locator('.page-thumbnail')).toHaveCount(2);
    await expect(page.locator('.document-subtitle')).toContainText('Đã lưu · 2 trang');
    const saved = await page.request.get(`/api/documents/${documentId}`);
    expect(saved.status()).toBe(200);
    const document = (await saved.json()) as ScanDocument;
    firstPage = document.pages[0];
    originalBytes = await (await page.request.get(firstPage.originalUrl)).body();
    expect((await sharp(originalBytes).metadata()).width).toBe(720);
  });

  await test.step('create a QR pairing link', async () => {
    await page.getByRole('button', { name: 'Kết nối điện thoại', exact: true }).click();
    const pairing = page.getByRole('dialog', { name: 'Đưa máy quét vào túi bạn.' });
    await expect(pairing.getByRole('img', { name: 'Mã QR kết nối điện thoại với tài liệu' })).toBeVisible();
    const linkInput = pairing.getByLabel('Liên kết quét trên điện thoại');
    await expect(linkInput).toHaveValue(new RegExp(`^${baseURL!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/capture/`));
    pairLink = await linkInput.inputValue();
    pairToken = new URL(pairLink).pathname.split('/').pop()!;
    expect(pairToken).toMatch(/^[a-zA-Z0-9_-]{32}$/);
    expect(await pairing.getByRole('img').getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  });

  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await phoneContext.newPage();
  phone.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await test.step('upload from an unauthenticated phone and receive the page through desktop SSE', async () => {
      await phone.goto(pairLink);
      await expect(phone.getByText('Đã kết nối', { exact: true })).toBeVisible();
      await expect(phone.locator('.capture-document-info')).toContainText(documentTitle);
      await expect(phone.locator('.capture-page-count')).toContainText('2');
      expect((await phoneContext.cookies()).filter((cookie) => cookie.name === 'myscan_owner')).toHaveLength(0);
      expect((await phone.request.get(`/api/documents/${documentId}`)).status()).toBe(401);
      await expect(phone.getByLabel('Chụp bằng camera điện thoại')).toHaveAttribute('capture', 'environment');
      await phone.getByLabel('Chọn ảnh tài liệu', { exact: true }).setInputFiles(fixtures[2]);
      await expect(phone.getByRole('img', { name: 'Xem trước trang 1' })).toBeVisible();
      await expect(phone.getByRole('button', { name: 'Gửi 1 trang vào tài liệu' })).toBeEnabled();
      const phoneUpload = phone.waitForResponse((response) => new URL(response.url()).pathname === `/api/capture/${pairToken}/pages` && response.request().method() === 'POST');
      await phone.getByRole('button', { name: 'Gửi 1 trang vào tài liệu' }).click();
      const uploaded = await phoneUpload;
      expect(uploaded.status()).toBe(201);
      const payload = await uploaded.json();
      expect(payload.document.pageCount).toBe(3);
      expect(payload.document.pages).toBeUndefined();
      await expect(phone.getByText('Đã gửi 1 trang', { exact: true })).toBeVisible();
      await expect(phone.locator('.capture-page-count')).toContainText('3');
      await expect(phone.getByRole('button', { name: 'Quét trang tiếp theo' })).toBeEnabled();
      // The document stays open on desktop: this count can only update via the live event refresh.
      await expect(page.locator('.page-thumbnail')).toHaveCount(3);
      await phone.screenshot({ path: '/tmp/myscan-mobile.png', fullPage: true });
      await page.getByRole('dialog').getByRole('button', { name: 'Tiếp tục chỉnh tài liệu' }).click();
    });

    await test.step('adjust a corner with the keyboard, rotate, filter and save without altering the original', async () => {
      await page.getByRole('button', { name: 'Chọn trang 1', exact: true }).click();
      await page.getByRole('button', { name: 'Chỉnh sửa', exact: true }).click();
      const editor = page.getByRole('dialog', { name: 'Chỉnh sửa ảnh' });
      const corner = editor.getByRole('button', { name: 'Góc trên trái. Dùng phím mũi tên để chỉnh.', exact: true });
      await expect(corner).toBeVisible();
      const cornerBefore = await corner.getAttribute('style');
      await corner.focus();
      await corner.press('Shift+ArrowRight');
      await corner.press('Shift+ArrowDown');
      expect(await corner.getAttribute('style')).not.toBe(cornerBefore);
      await editor.getByRole('button', { name: 'Xoay phải', exact: true }).click();
      await expect(editor.locator('.editor-section-heading').first()).toContainText('90°');
      await editor.getByRole('button', { name: 'Đen trắng', exact: true }).click();
      await expect(editor.getByRole('button', { name: 'Đen trắng', exact: true })).toHaveAttribute('aria-pressed', 'true');
      const savedCorners = await editor.locator('.editor-corner').evaluateAll((elements) => elements.map((element) => element.getAttribute('style')));
      await editor.getByRole('button', { name: 'Kết quả', exact: true }).click();
      await expect(editor.getByLabel('Ảnh sau khi căn chỉnh và áp dụng bộ lọc')).toBeVisible();
      await editor.getByRole('button', { name: 'Lưu trang', exact: true }).click();
      await expect(editor).toBeHidden();

      const unchangedOriginal = await (await page.request.get(firstPage.originalUrl)).body();
      const processed = await (await page.request.get(firstPage.imageUrl)).body();
      expect(unchangedOriginal.equals(originalBytes)).toBe(true);
      expect(processed.equals(originalBytes)).toBe(false);
      const metadata = await sharp(processed).metadata();
      expect(metadata.format).toBe('jpeg');
      expect(metadata.width!).toBeGreaterThan(metadata.height!);
      const { data, info } = await sharp(processed).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      let colorDifference = 0;
      for (let offset = 0; offset < data.length; offset += info.channels) {
        colorDifference += Math.abs(data[offset] - data[offset + 1]) + Math.abs(data[offset + 1] - data[offset + 2]);
      }
      expect(colorDifference / (info.width * info.height)).toBeLessThan(2);
      await page.getByRole('button', { name: 'Ảnh gốc', exact: true }).click();
      await expect(page.locator('.scan-stage img')).toHaveAttribute('src', new RegExp(`/pages/${firstPage.id}/original`));
      await page.getByRole('button', { name: 'Bản scan', exact: true }).click();
      await page.getByRole('button', { name: 'Chỉnh sửa', exact: true }).click();
      const reopened = page.getByRole('dialog', { name: 'Chỉnh sửa ảnh' });
      await expect(reopened.locator('.editor-corner')).toHaveCount(4);
      await expect(reopened.locator('.editor-section-heading').first()).toContainText('90°');
      await expect(reopened.getByRole('button', { name: 'Đen trắng', exact: true })).toHaveAttribute('aria-pressed', 'true');
      expect(await reopened.locator('.editor-corner').evaluateAll((elements) => elements.map((element) => element.getAttribute('style')))).toEqual(savedCorners);
      await reopened.getByRole('button', { name: 'Hủy', exact: true }).click();
    });

    let expectedOrder: string[];
    await test.step('reorder pages and download a PDF with the same order', async () => {
      const before = (await (await page.request.get(`/api/documents/${documentId}`)).json()) as ScanDocument;
      expectedOrder = [before.pages[1].id, before.pages[0].id, before.pages[2].id];
      await page.getByRole('button', { name: 'Đưa trang 2 lên', exact: true }).click();
      await expect.poll(async () => {
        const document = await (await page.request.get(`/api/documents/${documentId}`)).json() as ScanDocument;
        return document.pages.map((item) => item.id);
      }).toEqual(expectedOrder);
      await expect(page.locator('.thumbnail-button img').first()).toHaveAttribute('src', new RegExp(`/pages/${expectedOrder[0]}/image`));
      await page.screenshot({ path: '/tmp/myscan-desktop.png', fullPage: true });

      await page.getByRole('button', { name: 'Xuất PDF', exact: true }).click();
      const exportDialog = page.getByRole('dialog', { name: 'Hoàn thiện tài liệu.' });
      await expect(exportDialog).toContainText('Ghép 3 trang');
      const downloaded = page.waitForEvent('download');
      await exportDialog.getByRole('button', { name: 'Tải PDF', exact: true }).click();
      const download = await downloaded;
      expect(download.suggestedFilename()).toBe(`${documentTitle}.pdf`);
      const downloadedPath = await download.path();
      expect(downloadedPath).not.toBeNull();
      const pdf = await PDFDocument.load(await readFile(downloadedPath!));
      expect(pdf.getPageCount()).toBe(3);
      expect(pdf.getPage(0).getWidth()).toBeCloseTo(595.28, 1);
      const imageObjects = pdf.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
      expect(imageObjects?.keys()).toHaveLength(1);
      const embeddedImage = pdf.context.lookup(imageObjects!.values()[0], PDFRawStream);
      const expectedFirstImage = await (await page.request.get(before.pages[1].imageUrl)).body();
      expect(Buffer.from(embeddedImage.getContents()).equals(expectedFirstImage)).toBe(true);
    });

    await test.step('reload the browser and retain the edited document and page order', async () => {
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Thư viện của bạn.' })).toBeVisible();
      await page.getByRole('button', { name: documentTitle, exact: true }).click();
      await expect(page.locator('.page-thumbnail')).toHaveCount(3);
      const document = await (await page.request.get(`/api/documents/${documentId}`)).json() as ScanDocument;
      expect(document.pages.map((item) => item.id)).toEqual(expectedOrder!);
      const persistedOriginal = await (await page.request.get(firstPage.originalUrl)).body();
      expect(persistedOriginal.equals(originalBytes)).toBe(true);
      const editedPage = document.pages.find((item) => item.id === firstPage.id)!;
      expect(editedPage.width).toBeGreaterThan(editedPage.height);
    });

    await test.step('revoke the QR token and reject further phone reads and uploads', async () => {
      const revoked = await page.request.delete(`/api/documents/${documentId}/pair/${pairToken}`);
      expect(revoked.status()).toBe(204);
      expect((await phone.request.get(`/api/capture/${pairToken}`)).status()).toBe(404);
      const rejectedUpload = await phone.request.post(`/api/capture/${pairToken}/pages`, {
        multipart: { images: { name: 'scan.jpg', mimeType: 'image/jpeg', buffer: await readFile(fixtures[2]) } },
      });
      expect(rejectedUpload.status()).toBe(404);
      await phone.reload();
      await expect(phone.getByRole('heading', { name: 'Liên kết quét đã hết hiệu lực' })).toBeVisible();
      const finalDocument = await (await page.request.get(`/api/documents/${documentId}`)).json() as ScanDocument;
      expect(finalDocument.pages).toHaveLength(3);
    });
    expect(pageErrors).toEqual([]);
  } finally {
    await phoneContext.close();
  }
});
