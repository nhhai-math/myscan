import { PDFDocument, PageSizes } from 'pdf-lib';

export type PdfScanPage = { blob: Blob; width: number; height: number };

/** Embed the stored pages in their selected order; no server or remote font is used. */
export async function createDocumentPdf(
  title: string,
  pages: PdfScanPage[],
  paper: 'a4' | 'image',
): Promise<Blob> {
  if (!pages.length) throw new Error('Thêm ít nhất một trang trước khi xuất PDF.');
  if (pages.length > 200) throw new Error('Một PDF có thể chứa tối đa 200 trang.');
  if (!['a4', 'image'].includes(paper)) throw new Error('Khổ giấy không hợp lệ.');
  const pdf = await PDFDocument.create();
  pdf.setTitle(title.trim() || 'Tài liệu myscan');
  pdf.setCreator('myscan');
  pdf.setProducer('myscan — PDF trên thiết bị');
  for (let index = 0; index < pages.length; index += 1) {
    const scanned = pages[index];
    if (!(scanned.blob instanceof Blob) || !scanned.blob.size
      || !Number.isFinite(scanned.width) || scanned.width < 1
      || !Number.isFinite(scanned.height) || scanned.height < 1) {
      throw new Error(`Trang ${index + 1} không có ảnh hợp lệ.`);
    }
    const bytes = new Uint8Array(await scanned.blob.arrayBuffer());
    let image;
    try {
      if (bytes[0] === 0xff && bytes[1] === 0xd8) image = await pdf.embedJpg(bytes);
      else if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) image = await pdf.embedPng(bytes);
      else throw new Error('unsupported image');
    } catch {
      throw new Error(`Không đọc được ảnh trang ${index + 1}. Hãy chỉnh và lưu lại trang này.`);
    }
    // Trust dimensions from the actual image, rather than potentially stale metadata.
    const landscape = image.width > image.height;
    const size: [number, number] = paper === 'image'
      ? [image.width * 72 / 150, image.height * 72 / 150]
      : landscape ? [PageSizes.A4[1], PageSizes.A4[0]] : [PageSizes.A4[0], PageSizes.A4[1]];
    const page = pdf.addPage(size);
    const margin = paper === 'a4' ? 18 : 0;
    const scale = Math.min((size[0] - 2 * margin) / image.width, (size[1] - 2 * margin) / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    page.drawImage(image, { x: (size[0] - width) / 2, y: (size[1] - height) / 2, width, height });
    // Let Safari paint progress indicators while assembling a multi-page document.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const data = await pdf.save();
  return new Blob([new Uint8Array(data).buffer], { type: 'application/pdf' });
}
