import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { transformWithOxc } from 'vite';

// Import the production helper into a real browser without exposing source files
// from the production server used by the shared Playwright configuration.
const source = await readFile(new URL('../../src/lib/image.ts', import.meta.url), 'utf8');
const transformed = await transformWithOxc(source, 'image.ts');
const moduleUrl = `data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}`;

test('full crops preserve pixels, crop sizes stay bounded and transparency becomes white', async ({ page }) => {
  const result = await page.evaluate(async (url) => {
    const { DEFAULT_CORNERS, renderScan } = await import(url);
    const source = document.createElement('canvas');
    source.width = 121;
    source.height = 81;
    const context = source.getContext('2d')!;
    const original = context.createImageData(source.width, source.height);
    for (let index = 0; index < original.data.length; index += 4) {
      original.data[index] = (index / 4) % 256;
      original.data[index + 1] = (index / 8) % 256;
      original.data[index + 2] = 193;
      original.data[index + 3] = 255;
    }
    context.putImageData(original, 0, 0);
    const options = { mode: 'color', brightness: 0, contrast: 0, maxEdge: 2600 };
    const full = renderScan(source, DEFAULT_CORNERS, options);
    const pixels = full.getContext('2d')!.getImageData(0, 0, full.width, full.height).data;
    const maxDifference = pixels.reduce((difference: number, value: number, index: number) => Math.max(difference, Math.abs(value - original.data[index])), 0);
    const crop = [
      { x: 0.25, y: 0.25 }, { x: 0.75, y: 0.25 },
      { x: 0.75, y: 0.75 }, { x: 0.25, y: 0.75 },
    ];
    const cropped = renderScan(source, crop, options);
    const capped = renderScan(source, crop, { ...options, maxEdge: 30 });
    const transparent = document.createElement('canvas');
    transparent.width = 20;
    transparent.height = 20;
    const transparentContext = transparent.getContext('2d')!;
    transparentContext.fillStyle = 'rgba(255, 0, 0, 0.5)';
    transparentContext.fillRect(0, 0, 10, 20);
    const opaque = renderScan(transparent, DEFAULT_CORNERS, options);
    const opaqueContext = opaque.getContext('2d')!;
    return {
      dimensions: [full.width, full.height], maxDifference,
      crop: [cropped.width, cropped.height], cap: [capped.width, capped.height],
      red: Array.from(opaqueContext.getImageData(2, 2, 1, 1).data),
      clear: Array.from(opaqueContext.getImageData(17, 2, 1, 1).data),
    };
  }, moduleUrl);
  expect(result.dimensions).toEqual([121, 81]);
  expect(result.maxDifference).toBe(0);
  expect(result.crop).toEqual([61, 41]);
  expect(result.cap).toEqual([30, 20]);
  expect(result.red).toEqual([255, 127, 127, 255]);
  expect(result.clear).toEqual([255, 255, 255, 255]);
});

test('perspective correction maps four colored corners and interpolates the page interior', async ({ page }) => {
  const result = await page.evaluate(async (url) => {
    const { DEFAULT_CORNERS, renderScan, solveHomography, applyHomography } = await import(url);
    const source = document.createElement('canvas');
    source.width = 201;
    source.height = 161;
    const context = source.getContext('2d')!;
    const colors = ['#e52020', '#20cf40', '#204be5', '#e5ce20'];
    [[0, 0], [101, 0], [101, 81], [0, 81]].forEach(([x, y], index) => {
      context.fillStyle = colors[index];
      context.fillRect(x, y, 101, 81);
    });
    const corners = [
      { x: 0.12, y: 0.1 }, { x: 0.9, y: 0.22 },
      { x: 0.82, y: 0.9 }, { x: 0.07, y: 0.78 },
    ];
    const options = { mode: 'color', brightness: 0, contrast: 0, maxEdge: 2600 };
    const corrected = renderScan(source, corners, options);
    const correctedContext = corrected.getContext('2d')!;
    const cornerPixels = [[0, 0], [corrected.width - 1, 0], [corrected.width - 1, corrected.height - 1], [0, corrected.height - 1]]
      .map(([x, y]) => Array.from(correctedContext.getImageData(x, y, 1, 1).data));
    const gradient = context.createImageData(source.width, source.height);
    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        const index = (y * source.width + x) * 4;
        gradient.data[index] = Math.round(x / (source.width - 1) * 255);
        gradient.data[index + 1] = Math.round(y / (source.height - 1) * 255);
        gradient.data[index + 2] = 128;
        gradient.data[index + 3] = 255;
      }
    }
    context.putImageData(gradient, 0, 0);
    const correctedGradient = renderScan(source, corners, options);
    const gradientContext = correctedGradient.getContext('2d')!;
    const matrix = solveHomography(DEFAULT_CORNERS, corners);
    const sampledErrors = [[0.2, 0.7], [0.5, 0.5], [0.83, 0.28]].map(([x, y]) => {
      const pixelX = Math.round(x * (correctedGradient.width - 1));
      const pixelY = Math.round(y * (correctedGradient.height - 1));
      const mapped = applyHomography(matrix, { x: pixelX / (correctedGradient.width - 1), y: pixelY / (correctedGradient.height - 1) });
      const actual = gradientContext.getImageData(pixelX, pixelY, 1, 1).data;
      return Math.max(Math.abs(actual[0] - mapped.x * 255), Math.abs(actual[1] - mapped.y * 255));
    });
    return { cornerPixels, sampledErrors, dimensions: [corrected.width, corrected.height] };
  }, moduleUrl);
  expect(result.cornerPixels).toEqual([
    [229, 32, 32, 255], [32, 207, 64, 255], [32, 75, 229, 255], [229, 206, 32, 255],
  ]);
  expect(result.dimensions[0]).toBeLessThan(201);
  expect(result.dimensions[1]).toBeLessThan(161);
  result.sampledErrors.forEach((difference) => expect(difference).toBeLessThan(1.1));
});

test('rotations, grayscale, black-white, tone controls and JPEG export work on real Canvas', async ({ page }) => {
  const result = await page.evaluate(async (url) => {
    const { DEFAULT_CORNERS, loadImage, rotateImage, renderScan, canvasToBlob } = await import(url);
    const source = document.createElement('canvas');
    source.width = 91;
    source.height = 67;
    const context = source.getContext('2d')!;
    const input = context.createImageData(source.width, source.height);
    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        const index = (y * source.width + x) * 4;
        input.data[index] = Math.round(x / (source.width - 1) * 255);
        input.data[index + 1] = Math.round(y / (source.height - 1) * 255);
        input.data[index + 2] = 113;
        input.data[index + 3] = 255;
      }
    }
    context.putImageData(input, 0, 0);
    const image = await loadImage(source.toDataURL('image/png'));
    const rotations = [0, 90, 180, 270, 360].map((angle) => rotateImage(image, angle));
    const rotatedPixels = rotations.map((canvas) => {
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      return { size: [canvas.width, canvas.height], first: Array.from(pixels.slice(0, 4)), pixels: Array.from(pixels) };
    });
    const options = { mode: 'color', brightness: 0, contrast: 0, maxEdge: 2600 };
    const gray = renderScan(source, DEFAULT_CORNERS, { ...options, mode: 'grayscale' });
    const grayPixels = gray.getContext('2d')!.getImageData(0, 0, gray.width, gray.height).data;
    const binary = renderScan(source, DEFAULT_CORNERS, { ...options, mode: 'binary' });
    const binaryPixels = binary.getContext('2d')!.getImageData(0, 0, binary.width, binary.height).data;
    let grayChannelsEqual = true;
    let binaryChannelsEqual = true;
    let allOpaque = true;
    const tones = new Set<number>();
    for (let index = 0; index < grayPixels.length; index += 4) {
      grayChannelsEqual &&= grayPixels[index] === grayPixels[index + 1] && grayPixels[index] === grayPixels[index + 2];
      binaryChannelsEqual &&= binaryPixels[index] === binaryPixels[index + 1] && binaryPixels[index] === binaryPixels[index + 2];
      allOpaque &&= grayPixels[index + 3] === 255 && binaryPixels[index + 3] === 255;
      tones.add(binaryPixels[index]);
    }
    const bright = renderScan(source, DEFAULT_CORNERS, { ...options, brightness: 20 });
    const contrasted = renderScan(source, DEFAULT_CORNERS, { ...options, contrast: 30 });
    const sample = (canvas: HTMLCanvasElement, x: number, y: number) => Array.from(canvas.getContext('2d')!.getImageData(x, y, 1, 1).data);
    const blob = await canvasToBlob(gray, 'image/jpeg', 0.94);
    const blobUrl = URL.createObjectURL(blob);
    const decoded = await loadImage(blobUrl);
    URL.revokeObjectURL(blobUrl);
    return {
      rotationSizes: rotatedPixels.map((rotation) => rotation.size),
      rotationFirstPixels: rotatedPixels.map((rotation) => rotation.first),
      fullRotationUnchanged: rotatedPixels[0].pixels.every((value, index) => value === rotatedPixels[4].pixels[index]),
      grayChannelsEqual, binaryChannelsEqual, allOpaque, binaryTones: Array.from(tones).sort((a, b) => a - b),
      originalCenter: sample(source, 45, 33), brightCenter: sample(bright, 45, 33),
      originalDark: sample(source, 10, 8), contrastDark: sample(contrasted, 10, 8),
      blobType: blob.type, blobSize: blob.size, decodedSize: [decoded.naturalWidth, decoded.naturalHeight],
    };
  }, moduleUrl);
  expect(result.rotationSizes).toEqual([[91, 67], [67, 91], [91, 67], [67, 91], [91, 67]]);
  expect(result.rotationFirstPixels).toEqual([
    [0, 0, 113, 255], [0, 255, 113, 255], [255, 255, 113, 255], [255, 0, 113, 255], [0, 0, 113, 255],
  ]);
  expect(result.fullRotationUnchanged).toBe(true);
  expect(result.grayChannelsEqual).toBe(true);
  expect(result.binaryChannelsEqual).toBe(true);
  expect(result.allOpaque).toBe(true);
  expect(result.binaryTones).toEqual([0, 255]);
  expect(result.brightCenter[0]).toBeGreaterThan(result.originalCenter[0] + 40);
  expect(result.contrastDark[0]).toBeLessThan(result.originalDark[0]);
  expect(result.blobType).toBe('image/jpeg');
  expect(result.blobSize).toBeGreaterThan(0);
  expect(result.decodedSize).toEqual([91, 67]);
});
