import type { EditSettings } from '../lib/image';

/** Images are separate IndexedDB Blobs so listing documents does not load scans. */
export type IOSPage = {
  id: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  createdAt: number;
  updatedAt: number;
  edit: EditSettings | null;
};

export type IOSDocument = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pages: IOSPage[];
};
