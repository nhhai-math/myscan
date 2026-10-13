#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const options = process.argv.slice(2);
if (options.some((option) => option !== '--local-only')) {
  throw new Error('Usage: node scripts/build-ios-pwa.mjs [--local-only]');
}
const localOnly = options.includes('--local-only');
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(repository, 'dist-ios');
const published = path.join(repository, 'docs', 'ios');
process.chdir(repository);
await build({ configFile: path.join(repository, 'vite.ios.config.ts') });
await rename(path.join(output, 'ios.html'), path.join(output, 'index.html'));

async function filesIn(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? filesIn(path.join(directory, entry.name), relative)
      : [relative];
  }));
  return nested.flat().sort();
}

const files = (await filesIn(output)).filter((file) => file !== 'sw.js');
const template = await readFile(path.join(repository, 'public', 'ios-assets', 'sw.js'), 'utf8');
const hash = createHash('sha256');
hash.update(template);
hash.update('\0');
for (const file of files) {
  hash.update(file);
  hash.update('\0');
  hash.update(await readFile(path.join(output, file)));
  hash.update('\0');
}
const version = hash.digest('hex').slice(0, 20);
const serviceWorker = template
  .replace("/*__CACHE_NAME__*/ 'myscan-ios-development'", JSON.stringify(version))
  .replace('/*__PRECACHE__*/ []', JSON.stringify(files.map((file) => `./${file}`)));
if (serviceWorker.includes('/*__CACHE_NAME__*/') || serviceWorker.includes('/*__PRECACHE__*/')) {
  throw new Error('Could not insert the service worker precache configuration.');
}
await writeFile(path.join(output, 'sw.js'), serviceWorker);

console.log(`iPhone PWA: ${files.length} offline assets, ${version}`);
if (localOnly) {
  console.log('Local build prepared at dist-ios/. Published docs/ files were preserved.');
} else {
  // Only the generated iOS site is replaced; Android downloads and guides remain.
  await mkdir(path.dirname(published), { recursive: true });
  await rm(published, { force: true, recursive: true });
  await cp(output, published, { recursive: true });
  await writeFile(path.join(repository, 'docs', '.nojekyll'), '');
  console.log('Static site prepared at docs/ios/. GitHub Pages source: main /docs.');
}
