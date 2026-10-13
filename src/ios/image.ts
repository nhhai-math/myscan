import { canvasToBlob, loadImage, rotateImage } from '../lib/image';

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_INPUT_PIXELS = 100_000_000;

/** Decode with the browser's EXIF orientation, then keep one upright source JPEG. */
export async function importScanImage(file: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  if (!file.size) throw new Error('Ảnh trống. Hãy chụp hoặc chọn lại ảnh.');
  if (file.size > MAX_FILE_BYTES) throw new Error('Ảnh vượt quá 32 MB. Hãy chọn ảnh có dung lượng nhỏ hơn.');
  const header = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const text = String.fromCharCode(...header);
  const isJpeg = header[0] === 0xff && header[1] === 0xd8;
  const isPng = header[0] === 0x89 && text.slice(1, 4) === 'PNG';
  const isWebp = text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP';
  const isBmp = text.startsWith('BM');
  const isHeif = text.slice(4, 8) === 'ftyp' && /heic|heix|hevc|hevx|mif1|msf1|avif|avis/.test(text.slice(8));
  if (!isJpeg && !isPng && !isWebp && !isBmp && !isHeif) {
    throw new Error('Chọn ảnh JPEG, PNG, WebP hoặc ảnh HEIC từ iPhone.');
  }

  const url = URL.createObjectURL(file);
  let canvas: HTMLCanvasElement | null = null;
  try {
    let image: HTMLImageElement;
    try {
      image = await loadImage(url);
    } catch {
      throw new Error(isHeif
        ? 'Trình duyệt chưa đọc được ảnh HEIC này. Hãy chụp lại trong myscan hoặc chọn ảnh JPEG.'
        : 'Không đọc được ảnh. Hãy chụp lại hoặc chọn ảnh JPEG, PNG, WebP.');
    }
    if (image.naturalWidth * image.naturalHeight > MAX_INPUT_PIXELS) {
      throw new Error('Ảnh vượt quá 100 megapixel. Hãy chọn ảnh có độ phân giải nhỏ hơn.');
    }
    // HTMLImageElement honors EXIF in Safari; writing pixels removes orientation tags.
    canvas = rotateImage(image, 0, 4000);
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.94);
    return { blob, width: canvas.width, height: canvas.height };
  } finally {
    URL.revokeObjectURL(url);
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
