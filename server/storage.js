import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { validateSavedState } from './validation.js';

export class Storage {
  constructor(dataDir) {
    this.root = path.resolve(dataDir);
    this.metadataPath = path.join(this.root, 'metadata.json');
    this.state = { version: 1, documents: {}, pairings: {} };
    this.pending = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.root, 'tmp'), { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(this.metadataPath, 'utf8'));
      this.state = validateSavedState(saved);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this;
  }

  snapshot() {
    return structuredClone(this.state);
  }

  mutate(action) {
    const operation = this.pending.then(async () => {
      const next = this.snapshot();
      const result = await action(next);
      const temporaryPath = `${this.metadataPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, JSON.stringify(next, null, 2), { mode: 0o600 });
        await rename(temporaryPath, this.metadataPath);
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
      this.state = next;
      return structuredClone(result);
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  read(action) {
    const operation = this.pending.then(() => action(this.state));
    this.pending = operation.catch(() => {});
    return operation;
  }

  documentPath(documentId) {
    return path.join(this.root, 'documents', documentId);
  }

  pagePath(documentId, pageId, kind) {
    return path.join(this.documentPath(documentId), `${pageId}.${kind}.jpg`);
  }
}
