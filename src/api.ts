import type { EditSettings } from './lib/image';

export interface ScanPage {
  id: string;
  width: number;
  height: number;
  createdAt: string;
  updatedAt?: string;
  originalWidth?: number;
  originalHeight?: number;
  edit?: EditSettings | null;
  originalUrl: string;
  imageUrl: string;
}

export interface ScanDocument {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  pages: ScanPage[];
}

export interface PairSession {
  token: string;
  expiresAt: string;
  path: string;
  openedAt?: string | null;
  lastUploadAt?: string | null;
  uploadedCount?: number;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) window.dispatchEvent(new Event('myscan:unauthorized'));
    throw new Error(body.error || 'Không thể kết nối. Vui lòng thử lại.');
  }
  return response.status === 204 ? undefined as T : response.json();
}

export const dateLabel = (date: string) => new Intl.DateTimeFormat('vi-VN', {
  day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh',
}).format(new Date(date));

export function imageUrl(page: ScanPage, document: ScanDocument, original = false) {
  return `${original ? page.originalUrl : page.imageUrl}?v=${encodeURIComponent(page.updatedAt || document.updatedAt)}`;
}
