/** Points and page corners use image-relative coordinates, from 0 to 1. */
export type Point = { x: number; y: number };
export type Quad = [Point, Point, Point, Point];
export type ColorMode = 'color' | 'grayscale' | 'binary';
export type EditSettings = {
  rotation: number;
  /** Normalized corners in the original image after applying rotation. */
  corners: Quad;
  mode: ColorMode;
  brightness: number;
  contrast: number;
};

/** Clockwise in image coordinates: top-left, top-right, bottom-right, bottom-left. */
export const DEFAULT_CORNERS: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

const MIN_AREA = 0.015;
const MIN_EDGE = 0.01;

export function validateCorners(corners: Quad): boolean {
  if (!Array.isArray(corners) || corners.length !== 4) return false;
  if (!corners.every((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y)
    && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1)) return false;

  let doubleArea = 0;
  for (let index = 0; index < 4; index += 1) {
    const current = corners[index];
    const next = corners[(index + 1) % 4];
    const after = corners[(index + 2) % 4];
    if (Math.hypot(next.x - current.x, next.y - current.y) < MIN_EDGE) return false;
    // Positive turns are clockwise because image Y increases downwards.
    const cross = (next.x - current.x) * (after.y - next.y)
      - (next.y - current.y) * (after.x - next.x);
    if (cross <= 1e-8) return false;
    doubleArea += current.x * next.y - next.x * current.y;
  }
  return doubleArea / 2 >= MIN_AREA;
}

/**
 * Returns a row-major 3×3 matrix projecting each source point to its destination.
 * Coordinates may be normalized or in pixels, but each quad must use one system.
 */
export function solveHomography(source: Quad, destination: Quad): number[] {
  if (source.length !== 4 || destination.length !== 4
    || [...source, ...destination].some((point) => !point
      || !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    throw new Error('Các điểm căn chỉnh không hợp lệ.');
  }

  const equations: number[][] = [];
  for (let index = 0; index < 4; index += 1) {
    const { x, y } = source[index];
    const { x: u, y: v } = destination[index];
    equations.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    equations.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }

  // Gaussian elimination with partial pivoting avoids unstable diagonal pivots.
  for (let column = 0; column < 8; column += 1) {
    let pivotRow = column;
    for (let row = column + 1; row < 8; row += 1) {
      if (Math.abs(equations[row][column]) > Math.abs(equations[pivotRow][column])) pivotRow = row;
    }
    if (Math.abs(equations[pivotRow][column]) < 1e-12) {
      throw new Error('Không thể căn chỉnh các điểm trùng hoặc thẳng hàng.');
    }
    [equations[column], equations[pivotRow]] = [equations[pivotRow], equations[column]];
    const pivot = equations[column][column];
    for (let entry = column; entry <= 8; entry += 1) equations[column][entry] /= pivot;
    for (let row = 0; row < 8; row += 1) {
      if (row === column) continue;
      const factor = equations[row][column];
      for (let entry = column; entry <= 8; entry += 1) {
        equations[row][entry] -= factor * equations[column][entry];
      }
    }
  }
  const matrix = equations.map((row) => row[8]).concat(1);
  if (matrix.some((value) => !Number.isFinite(value))) throw new Error('Không thể tính phép căn chỉnh ảnh.');
  return matrix;
}

export function applyHomography(matrix: number[], point: Point): Point {
  if (matrix.length !== 9 || matrix.some((value) => !Number.isFinite(value))
    || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error('Phép căn chỉnh không hợp lệ.');
  }
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  if (Math.abs(denominator) < 1e-12) throw new Error('Điểm nằm ngoài vùng căn chỉnh.');
  return {
    x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator,
    y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator,
  };
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (!url.trim()) {
      reject(new Error('Không có đường dẫn ảnh.'));
      return;
    }
    const image = new Image();
    image.crossOrigin = 'anonymous';
    const cleanup = () => {
      clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
    };
    const timeout = setTimeout(() => {
      cleanup();
      image.src = '';
      reject(new Error('Tải ảnh quá lâu. Vui lòng thử lại.'));
    }, 30_000);
    image.onload = () => {
      cleanup();
      if (image.naturalWidth > 0 && image.naturalHeight > 0) resolve(image);
      else reject(new Error('Ảnh không có kích thước hợp lệ.'));
    };
    image.onerror = () => {
      cleanup();
      reject(new Error('Không đọc được ảnh. Hãy thử tệp JPEG, PNG hoặc WebP.'));
    };
    image.src = url;
  });
}

function createCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Trình duyệt không hỗ trợ xử lý ảnh.');
  return [canvas, context];
}

export function rotateImage(image: HTMLImageElement, rotation: number, maxEdge?: number): HTMLCanvasElement {
  if (!Number.isFinite(rotation) || rotation % 90 !== 0) {
    throw new Error('Chỉ có thể xoay ảnh theo góc 90 độ.');
  }
  if (maxEdge !== undefined && (!Number.isFinite(maxEdge) || maxEdge < 1)) {
    throw new Error('Kích thước ảnh không hợp lệ.');
  }
  const originalWidth = image.naturalWidth;
  const originalHeight = image.naturalHeight;
  if (originalWidth < 1 || originalHeight < 1) throw new Error('Ảnh chưa được tải xong.');
  const scale = Math.min(1, (maxEdge ?? Math.max(originalWidth, originalHeight)) / Math.max(originalWidth, originalHeight));
  const width = Math.max(1, Math.floor(originalWidth * scale));
  const height = Math.max(1, Math.floor(originalHeight * scale));
  const angle = ((rotation % 360) + 360) % 360;
  const sideways = angle === 90 || angle === 270;
  const [canvas, context] = createCanvas(sideways ? height : width, sideways ? width : height);
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(angle * Math.PI / 180);
  context.drawImage(image, -width / 2, -height / 2, width, height);
  return canvas;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/** Otsu's threshold separates paper from ink without a fixed exposure setting. */
function binaryThreshold(histogram: Uint32Array, count: number): number {
  let total = 0;
  let occupied = 0;
  for (let tone = 0; tone < 256; tone += 1) {
    total += tone * histogram[tone];
    if (histogram[tone]) occupied += 1;
  }
  if (occupied < 2) return 128;
  let backgroundCount = 0;
  let backgroundSum = 0;
  let bestVariance = -1;
  let threshold = 128;
  for (let tone = 0; tone < 255; tone += 1) {
    backgroundCount += histogram[tone];
    backgroundSum += tone * histogram[tone];
    const foregroundCount = count - backgroundCount;
    if (!backgroundCount || !foregroundCount) continue;
    const difference = backgroundSum / backgroundCount - (total - backgroundSum) / foregroundCount;
    const variance = backgroundCount * foregroundCount * difference * difference;
    if (variance > bestVariance) {
      bestVariance = variance;
      threshold = tone;
    }
  }
  // Keep nearly white paper white and very dark ink black even with sparse text.
  return clamp(threshold, 48, 220);
}

export function renderScan(
  source: HTMLCanvasElement,
  corners: Quad,
  options: { mode: ColorMode; brightness: number; contrast: number; maxEdge: number },
): HTMLCanvasElement {
  if (!validateCorners(corners)) throw new Error('Kéo bốn góc theo thứ tự quanh trang; vùng cắt cần đủ lớn và không giao nhau.');
  if (!source.width || !source.height || !Number.isFinite(options.maxEdge) || options.maxEdge < 1) {
    throw new Error('Kích thước ảnh không hợp lệ.');
  }
  if (!['color', 'grayscale', 'binary'].includes(options.mode)
    || !Number.isFinite(options.brightness) || !Number.isFinite(options.contrast)) {
    throw new Error('Thiết lập màu ảnh không hợp lệ.');
  }
  const sourceContext = source.getContext('2d', { willReadFrequently: true });
  if (!sourceContext) throw new Error('Không đọc được ảnh gốc.');
  let pixels: Uint8ClampedArray;
  try {
    pixels = sourceContext.getImageData(0, 0, source.width, source.height).data;
  } catch {
    throw new Error('Không thể chỉnh sửa ảnh này. Hãy tải ảnh trực tiếp từ thiết bị.');
  }

  const pixelCorners = corners.map((point) => ({ x: point.x * (source.width - 1), y: point.y * (source.height - 1) }));
  const distance = (first: number, second: number) => Math.hypot(
    pixelCorners[first].x - pixelCorners[second].x,
    pixelCorners[first].y - pixelCorners[second].y,
  );
  // Average opposing sides estimates the actual cropped resolution, without upscaling.
  const cropWidth = (distance(0, 1) + distance(3, 2)) / 2 + 1;
  const cropHeight = (distance(0, 3) + distance(1, 2)) / 2 + 1;
  const scale = Math.min(1, options.maxEdge / Math.max(cropWidth, cropHeight));
  const width = Math.max(1, Math.floor(cropWidth * scale));
  const height = Math.max(1, Math.floor(cropHeight * scale));
  const [canvas, context] = createCanvas(width, height);
  const output = context.createImageData(width, height);
  const destinationPixels = output.data;
  // Inverse mapping visits every destination pixel, avoiding gaps after correction.
  const matrix = solveHomography(DEFAULT_CORNERS, corners);
  const xStep = width > 1 ? 1 / (width - 1) : 0;
  const xStart = width > 1 ? 0 : 0.5;
  const brightness = clamp(options.brightness, -60, 60) * 2.55;
  const contrast = clamp(options.contrast, -60, 60);
  const gain = (259 * (contrast + 255)) / (255 * (259 - contrast));
  const histogram = new Uint32Array(256);

  for (let y = 0; y < height; y += 1) {
    const normalizedY = height > 1 ? y / (height - 1) : 0.5;
    let numeratorX = matrix[0] * xStart + matrix[1] * normalizedY + matrix[2];
    let numeratorY = matrix[3] * xStart + matrix[4] * normalizedY + matrix[5];
    let denominator = matrix[6] * xStart + matrix[7] * normalizedY + matrix[8];
    for (let x = 0; x < width; x += 1) {
      const sampleX = clamp(numeratorX / denominator * (source.width - 1), 0, source.width - 1);
      const sampleY = clamp(numeratorY / denominator * (source.height - 1), 0, source.height - 1);
      const left = Math.floor(sampleX);
      const top = Math.floor(sampleY);
      const right = Math.min(source.width - 1, left + 1);
      const bottom = Math.min(source.height - 1, top + 1);
      const fractionX = sampleX - left;
      const fractionY = sampleY - top;
      const topLeft = (top * source.width + left) * 4;
      const topRight = (top * source.width + right) * 4;
      const bottomLeft = (bottom * source.width + left) * 4;
      const bottomRight = (bottom * source.width + right) * 4;
      const outputIndex = (y * width + x) * 4;
      const interpolate = (channel: number) => (
        (pixels[topLeft + channel] * (1 - fractionX) + pixels[topRight + channel] * fractionX) * (1 - fractionY)
        + (pixels[bottomLeft + channel] * (1 - fractionX) + pixels[bottomRight + channel] * fractionX) * fractionY
      );
      const alpha = interpolate(3) / 255;
      const tone = (channel: number) => clamp(
        gain * (interpolate(channel) * alpha + 255 * (1 - alpha) - 128) + 128 + brightness,
        0,
        255,
      );
      const red = tone(0);
      const green = tone(1);
      const blue = tone(2);
      if (options.mode === 'color') {
        destinationPixels[outputIndex] = red;
        destinationPixels[outputIndex + 1] = green;
        destinationPixels[outputIndex + 2] = blue;
      } else {
        const gray = Math.round(0.2126 * red + 0.7152 * green + 0.0722 * blue);
        destinationPixels[outputIndex] = gray;
        destinationPixels[outputIndex + 1] = gray;
        destinationPixels[outputIndex + 2] = gray;
        if (options.mode === 'binary') histogram[gray] += 1;
      }
      destinationPixels[outputIndex + 3] = 255;
      numeratorX += matrix[0] * xStep;
      numeratorY += matrix[3] * xStep;
      denominator += matrix[6] * xStep;
    }
  }
  if (options.mode === 'binary') {
    const threshold = binaryThreshold(histogram, width * height);
    for (let index = 0; index < destinationPixels.length; index += 4) {
      const tone = destinationPixels[index] <= threshold ? 0 : 255;
      destinationPixels[index] = tone;
      destinationPixels[index + 1] = tone;
      destinationPixels[index + 2] = tone;
    }
  }
  context.putImageData(output, 0, 0);
  return canvas;
}

export function canvasToBlob(canvas: HTMLCanvasElement, mime = 'image/jpeg', quality = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (!canvas.width || !canvas.height) {
      reject(new Error('Không có ảnh để lưu.'));
      return;
    }
    try {
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error('Không thể lưu ảnh đã chỉnh sửa.')),
        mime,
        Number.isFinite(quality) ? clamp(quality, 0, 1) : 0.92,
      );
    } catch {
      reject(new Error('Không thể xuất ảnh này. Hãy tải ảnh trực tiếp từ thiết bị.'));
    }
  });
}
