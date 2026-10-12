export const ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{32}$/;

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function isDimension(value) {
  return Number.isInteger(value) && value > 0 && value <= 6000;
}

export function validEditSettings(edit) {
  if (!isPlainObject(edit) || ![0, 90, 180, 270].includes(edit.rotation)
    || !['color', 'grayscale', 'binary'].includes(edit.mode)
    || !Number.isFinite(edit.brightness) || edit.brightness < -60 || edit.brightness > 60
    || !Number.isFinite(edit.contrast) || edit.contrast < -60 || edit.contrast > 60
    || !Array.isArray(edit.corners) || edit.corners.length !== 4) return false;
  if (!edit.corners.every((point) => isPlainObject(point)
    && Number.isFinite(point.x) && Number.isFinite(point.y)
    && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1)) return false;
  let doubleArea = 0;
  for (let index = 0; index < 4; index += 1) {
    const current = edit.corners[index];
    const next = edit.corners[(index + 1) % 4];
    const after = edit.corners[(index + 2) % 4];
    if (Math.hypot(next.x - current.x, next.y - current.y) < 0.01) return false;
    const cross = (next.x - current.x) * (after.y - next.y)
      - (next.y - current.y) * (after.x - next.x);
    if (cross <= 1e-8) return false;
    doubleArea += current.x * next.y - next.x * current.y;
  }
  // Canvas image coordinates increase downwards, so a positive area is clockwise.
  return doubleArea / 2 >= 0.015;
}

export function validateSavedState(saved) {
  const invalid = () => { throw new Error('Dữ liệu myscan không hợp lệ. Hãy khôi phục bản sao lưu; tệp hiện tại được giữ nguyên.'); };
  if (!isPlainObject(saved) || saved.version !== 1
    || !isPlainObject(saved.documents) || !isPlainObject(saved.pairings)) invalid();
  for (const [id, document] of Object.entries(saved.documents)) {
    if (!ID_PATTERN.test(id) || !isPlainObject(document) || document.id !== id
      || typeof document.title !== 'string' || !document.title.trim()
      || document.title !== document.title.trim() || document.title.length > 160
      || !isDate(document.createdAt) || !isDate(document.updatedAt)
      || !Array.isArray(document.pages) || document.pages.length > 200) invalid();
    const pageIds = new Set();
    for (const page of document.pages) {
      if (!isPlainObject(page) || !ID_PATTERN.test(page.id) || pageIds.has(page.id)
        || !isDimension(page.width) || !isDimension(page.height)
        || !isDimension(page.originalWidth) || !isDimension(page.originalHeight)
        || !isDate(page.createdAt) || !isDate(page.updatedAt)
        || typeof page.imageFile !== 'string'
        || !(page.imageFile === `${page.id}.image.jpg`
          || (page.imageFile.startsWith(`${page.id}.edit-`) && page.imageFile.endsWith('.jpg')
            && ID_PATTERN.test(page.imageFile.slice(page.id.length + 6, -4))))
        || (page.edit !== undefined && page.edit !== null && !validEditSettings(page.edit))) invalid();
      pageIds.add(page.id);
    }
  }
  for (const [token, pairing] of Object.entries(saved.pairings)) {
    if (!TOKEN_PATTERN.test(token) || !isPlainObject(pairing) || pairing.token !== token
      || !ID_PATTERN.test(pairing.documentId) || !Object.hasOwn(saved.documents, pairing.documentId)
      || !isDate(pairing.expiresAt)
      || (pairing.openedAt !== null && !isDate(pairing.openedAt))
      || (pairing.lastUploadAt !== null && !isDate(pairing.lastUploadAt))
      || !Number.isSafeInteger(pairing.uploadedCount) || pairing.uploadedCount < 0) invalid();
  }
  return saved;
}
