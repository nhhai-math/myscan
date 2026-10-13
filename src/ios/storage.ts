import { validateCorners } from '../lib/image';
import type { EditSettings } from '../lib/image';
import type { IOSDocument, IOSPage } from './types';

export const IOS_DATABASE_NAME = 'myscan-ios-offline';
const DATABASE_VERSION = 1;
const MAX_PAGES = 200;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

type ImageKind = 'original' | 'edited';
type ImageRecord = {
  key: string;
  documentId: string;
  pageId: string;
  kind: ImageKind;
  blob: Blob;
};

export class OfflineStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfflineStorageError';
  }
}

function storageError(error: unknown): OfflineStorageError {
  if (error instanceof OfflineStorageError) return error;
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
  if (name === 'QuotaExceededError') {
    return new OfflineStorageError('Bộ nhớ trên iPhone đã đầy. Xuất PDF trước khi xóa tài liệu để giải phóng dung lượng.');
  }
  if (name === 'SecurityError' || name === 'NotAllowedError') {
    return new OfflineStorageError('Safari đang chặn lưu dữ liệu. Hãy mở myscan ngoài chế độ duyệt riêng tư và cho phép lưu trữ.');
  }
  if (name === 'VersionError' || name === 'NotFoundError') {
    return new OfflineStorageError('Không đọc được cấu trúc thư viện. Dữ liệu hiện có được giữ nguyên; hãy mở lại phiên bản myscan mới nhất.');
  }
  return new OfflineStorageError('Không lưu hoặc đọc được thư viện trên thiết bị. Dữ liệu trước đó được giữ nguyên; hãy thử lại.');
}

function corrupt(): never {
  throw new OfflineStorageError('Dữ liệu tài liệu không hợp lệ. myscan giữ nguyên thư viện để tránh làm mất ảnh.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value);
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    && value <= 8_640_000_000_000_000;
}

function validDimensions(width: unknown, height: unknown): boolean {
  return typeof width === 'number' && Number.isSafeInteger(width) && width >= 1 && width <= 16000
    && typeof height === 'number' && Number.isSafeInteger(height) && height >= 1 && height <= 16000
    && width * height <= 100_000_000;
}

function validEdit(value: unknown): value is EditSettings {
  if (!isRecord(value)) return false;
  return typeof value.rotation === 'number' && [0, 90, 180, 270].includes(value.rotation)
    && validateCorners(value.corners as EditSettings['corners'])
    && typeof value.mode === 'string' && ['color', 'grayscale', 'binary'].includes(value.mode)
    && typeof value.brightness === 'number' && Number.isFinite(value.brightness)
    && value.brightness >= -60 && value.brightness <= 60
    && typeof value.contrast === 'number' && Number.isFinite(value.contrast)
    && value.contrast >= -60 && value.contrast <= 60;
}

function validateDocument(value: unknown): IOSDocument {
  if (!isRecord(value) || !validId(value.id) || typeof value.title !== 'string'
    || !value.title.trim() || value.title.length > 160
    || !validTime(value.createdAt) || !validTime(value.updatedAt)
    || value.updatedAt < value.createdAt || !Array.isArray(value.pages) || value.pages.length > MAX_PAGES) corrupt();
  const ids = new Set<string>();
  for (const page of value.pages) {
    if (!isRecord(page) || !validId(page.id) || ids.has(page.id)
      || !validDimensions(page.width, page.height) || !validDimensions(page.originalWidth, page.originalHeight)
      || !validTime(page.createdAt) || !validTime(page.updatedAt) || page.updatedAt < page.createdAt
      || page.createdAt < value.createdAt || page.updatedAt > value.updatedAt
      || (page.edit !== null && !validEdit(page.edit))) corrupt();
    ids.add(page.id);
  }
  return value as IOSDocument;
}

function title(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 160) {
    throw new OfflineStorageError('Tên tài liệu cần từ 1 đến 160 ký tự.');
  }
  return value.trim();
}

function imageInput(blob: Blob, width: number, height: number): void {
  if (!(blob instanceof Blob) || !blob.size || blob.size > MAX_IMAGE_BYTES || !IMAGE_TYPES.has(blob.type)) {
    throw new OfflineStorageError('Ảnh phải là JPEG, PNG hoặc WebP và không vượt quá 32 MB.');
  }
  if (!validDimensions(width, height)) throw new OfflineStorageError('Kích thước ảnh không hợp lệ hoặc quá lớn.');
}

function imageKey(documentId: string, pageId: string, kind: ImageKind): string {
  return `${documentId}/${pageId}/${kind}`;
}

function imageRecord(documentId: string, pageId: string, kind: ImageKind, blob: Blob): ImageRecord {
  return { key: imageKey(documentId, pageId, kind), documentId, pageId, kind, blob };
}

function readImage(value: unknown, documentId: string, pageId: string, kind: ImageKind): Blob {
  if (!isRecord(value) || value.key !== imageKey(documentId, pageId, kind)
    || value.documentId !== documentId || value.pageId !== pageId || value.kind !== kind
    || !(value.blob instanceof Blob) || !value.blob.size || value.blob.size > MAX_IMAGE_BYTES
    || !IMAGE_TYPES.has(value.blob.type)) {
    throw new OfflineStorageError('Không đọc được ảnh đã lưu của trang này. Dữ liệu hiện có được giữ nguyên.');
  }
  return value.blob;
}

type TransactionContext<T> = {
  tx: IDBTransaction;
  finish: (value: T) => void;
  read: <V>(request: IDBRequest<V>, callback: (value: V) => void) => void;
};

/** Every mutation commits metadata and image Blobs together, including quota failures. */
export class OfflineLibrary {
  constructor(private readonly db: IDBDatabase) {}

  close(): void { this.db.close(); }

  private run<T>(stores: string[], mode: IDBTransactionMode, work: (context: TransactionContext<T>) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let result: T;
      let hasResult = false;
      let failed: OfflineStorageError | undefined;
      let tx: IDBTransaction;
      try {
        tx = this.db.transaction(stores, mode);
      } catch (error) {
        reject(storageError(error));
        return;
      }
      const fail = (error: unknown) => {
        failed ??= storageError(error);
        try { tx.abort(); } catch { reject(failed); }
      };
      tx.oncomplete = () => {
        if (failed) reject(failed);
        else if (hasResult) resolve(result);
        else reject(storageError(undefined));
      };
      tx.onabort = () => reject(failed ?? storageError(tx.error));
      // Request errors normally abort automatically; retaining the actual error
      // ensures Safari quota failures get useful feedback instead of a generic abort.
      tx.onerror = (event) => {
        const request = event.target as IDBRequest<unknown>;
        failed ??= storageError(request.error ?? tx.error);
      };
      try {
        work({
          tx,
          finish: (value) => { result = value; hasResult = true; },
          read: (request, callback) => {
            request.onsuccess = () => {
              try { callback(request.result); } catch (error) { fail(error); }
            };
          },
        });
      } catch (error) { fail(error); }
    });
  }

  private document<T>(context: TransactionContext<T>, id: string, callback: (document: IOSDocument) => void): void {
    if (!validId(id)) throw new OfflineStorageError('Không tìm thấy tài liệu.');
    context.read(context.tx.objectStore('documents').get(id), (value: unknown) => {
      if (value === undefined) throw new OfflineStorageError('Tài liệu đã bị xóa hoặc không còn trên thiết bị.');
      callback(validateDocument(value));
    });
  }

  async listDocuments(): Promise<IOSDocument[]> {
    return this.run(['documents'], 'readonly', (context) => {
      context.read(context.tx.objectStore('documents').getAll(), (values: unknown[]) => {
        context.finish(values.map(validateDocument).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)));
      });
    });
  }

  async getDocument(id: string): Promise<IOSDocument> {
    return this.run(['documents'], 'readonly', (context) => this.document(context, id, context.finish));
  }

  async createDocument(documentTitle: string): Promise<IOSDocument> {
    const now = Date.now();
    const document: IOSDocument = {
      id: crypto.randomUUID(), title: title(documentTitle), createdAt: now, updatedAt: now, pages: [],
    };
    return this.run(['documents'], 'readwrite', ({ tx, finish }) => {
      tx.objectStore('documents').add(document);
      finish(document);
    });
  }

  async renameDocument(id: string, documentTitle: string): Promise<IOSDocument> {
    const nextTitle = title(documentTitle);
    return this.run(['documents'], 'readwrite', (context) => {
      this.document(context, id, (document) => {
        document.title = nextTitle;
        document.updatedAt = Math.max(Date.now(), document.updatedAt);
        context.tx.objectStore('documents').put(document);
        context.finish(document);
      });
    });
  }

  async deleteDocument(id: string): Promise<void> {
    return this.run(['documents', 'images'], 'readwrite', (context) => {
      this.document(context, id, (document) => {
        const images = context.tx.objectStore('images');
        for (const page of document.pages) {
          images.delete(imageKey(id, page.id, 'original'));
          images.delete(imageKey(id, page.id, 'edited'));
        }
        context.tx.objectStore('documents').delete(id);
        context.finish(undefined);
      });
    });
  }

  async addPage(documentId: string, original: Blob, width: number, height: number): Promise<IOSDocument> {
    imageInput(original, width, height);
    return this.run(['documents', 'images'], 'readwrite', (context) => {
      this.document(context, documentId, (document) => {
        if (document.pages.length >= MAX_PAGES) throw new OfflineStorageError('Mỗi tài liệu chứa tối đa 200 trang. Hãy tạo tài liệu mới.');
        const now = Math.max(Date.now(), document.updatedAt);
        const page: IOSPage = {
          id: crypto.randomUUID(), width, height, originalWidth: width, originalHeight: height,
          createdAt: now, updatedAt: now, edit: null,
        };
        document.pages.push(page);
        document.updatedAt = now;
        context.tx.objectStore('images').add(imageRecord(documentId, page.id, 'original', original));
        context.tx.objectStore('documents').put(document);
        context.finish(document);
      });
    });
  }

  async getPageImage(documentId: string, pageId: string, original = false): Promise<Blob> {
    return this.run(['documents', 'images'], 'readonly', (context) => {
      this.document(context, documentId, (document) => {
        const page = document.pages.find((entry) => entry.id === pageId);
        if (!page) throw new OfflineStorageError('Trang không còn trong tài liệu.');
        const kind: ImageKind = original || !page.edit ? 'original' : 'edited';
        context.read(context.tx.objectStore('images').get(imageKey(documentId, pageId, kind)), (value: unknown) => {
          context.finish(readImage(value, documentId, pageId, kind));
        });
      });
    });
  }

  async saveEditedPage(documentId: string, pageId: string, edited: Blob, width: number, height: number, settings: EditSettings): Promise<IOSDocument> {
    imageInput(edited, width, height);
    if (!validEdit(settings)) throw new OfflineStorageError('Thiết lập chỉnh ảnh không hợp lệ.');
    // Snapshot before IndexedDB callbacks so callers cannot mutate settings during a save.
    const savedSettings: EditSettings = {
      ...settings, corners: settings.corners.map((point) => ({ ...point })) as EditSettings['corners'],
    };
    return this.run(['documents', 'images'], 'readwrite', (context) => {
      this.document(context, documentId, (document) => {
        const page = document.pages.find((entry) => entry.id === pageId);
        if (!page) throw new OfflineStorageError('Trang không còn trong tài liệu.');
        // A damaged/missing original must never be replaced with the edited image.
        context.read(context.tx.objectStore('images').get(imageKey(documentId, pageId, 'original')), (value: unknown) => {
          readImage(value, documentId, pageId, 'original');
          const now = Math.max(Date.now(), document.updatedAt);
          Object.assign(page, { width, height, edit: savedSettings, updatedAt: now });
          document.updatedAt = now;
          context.tx.objectStore('images').put(imageRecord(documentId, pageId, 'edited', edited));
          context.tx.objectStore('documents').put(document);
          context.finish(document);
        });
      });
    });
  }

  async movePage(documentId: string, pageId: string, delta: -1 | 1): Promise<IOSDocument> {
    if (delta !== -1 && delta !== 1) throw new OfflineStorageError('Thứ tự trang không hợp lệ.');
    return this.run(['documents'], 'readwrite', (context) => {
      this.document(context, documentId, (document) => {
        const index = document.pages.findIndex((entry) => entry.id === pageId);
        if (index < 0) throw new OfflineStorageError('Trang không còn trong tài liệu.');
        const destination = index + delta;
        if (destination >= 0 && destination < document.pages.length) {
          [document.pages[index], document.pages[destination]] = [document.pages[destination], document.pages[index]];
          document.updatedAt = Math.max(Date.now(), document.updatedAt);
          context.tx.objectStore('documents').put(document);
        }
        context.finish(document);
      });
    });
  }

  async deletePage(documentId: string, pageId: string): Promise<IOSDocument> {
    return this.run(['documents', 'images'], 'readwrite', (context) => {
      this.document(context, documentId, (document) => {
        const index = document.pages.findIndex((entry) => entry.id === pageId);
        if (index < 0) throw new OfflineStorageError('Trang không còn trong tài liệu.');
        document.pages.splice(index, 1);
        document.updatedAt = Math.max(Date.now(), document.updatedAt);
        const images = context.tx.objectStore('images');
        images.delete(imageKey(documentId, pageId, 'original'));
        images.delete(imageKey(documentId, pageId, 'edited'));
        context.tx.objectStore('documents').put(document);
        context.finish(document);
      });
    });
  }
}

export function openLibrary(): Promise<OfflineLibrary> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new OfflineStorageError('Trình duyệt này không hỗ trợ lưu thư viện offline. Hãy mở bằng Safari trên iPhone.'));
      return;
    }
    let request: IDBOpenDBRequest;
    let rejected = false;
    const fail = (error: unknown) => { rejected = true; reject(storageError(error)); };
    try { request = indexedDB.open(IOS_DATABASE_NAME, DATABASE_VERSION); }
    catch (error) { fail(error); return; }
    request.onupgradeneeded = () => {
      try {
        const db = request.result;
        if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'key' });
      } catch (error) {
        request.transaction?.abort();
        fail(error);
      }
    };
    request.onerror = () => fail(request.error);
    request.onblocked = () => fail(new OfflineStorageError('Hãy đóng các tab myscan khác rồi mở lại để cập nhật thư viện.'));
    request.onsuccess = () => {
      const db = request.result;
      if (rejected) { db.close(); return; }
      if (!db.objectStoreNames.contains('documents') || !db.objectStoreNames.contains('images')) {
        db.close();
        fail(new OfflineStorageError('Cấu trúc thư viện không hợp lệ. Dữ liệu hiện có được giữ nguyên.'));
        return;
      }
      db.onversionchange = () => db.close();
      resolve(new OfflineLibrary(db));
    };
  });
}
