import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
export const SW_PATH = join(DOCS_DIR, 'sw.js');

export function listAppFiles(dir = DOCS_DIR) {
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.'))
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? listAppFiles(path) : [path];
    })
    .sort();
}

const sha256 = (content) => createHash('sha256').update(content).digest('hex');

/** Контрольные суммы всех файлов, кроме самого sw.js: { './index.html': '…' }. */
export function fileHashes() {
  return Object.fromEntries(
    listAppFiles()
      .filter((path) => path !== SW_PATH)
      .map((path) => [`./${relative(DOCS_DIR, path).split(sep).join('/')}`, sha256(readFileSync(path))]),
  );
}

export function renderFilesBlock(hashes) {
  const lines = Object.entries(hashes).map(([path, hash]) => `  '${path}': '${hash}',`);
  return `const FILES = {\n${lines.join('\n')}\n};`;
}

/** Хеш содержимого всех файлов; строка с версией в sw.js в него не входит. */
export function computeVersion() {
  const hash = createHash('sha256');
  for (const path of listAppFiles()) {
    hash.update(relative(DOCS_DIR, path));
    const content = readFileSync(path);
    hash.update(path === SW_PATH ? content.toString('utf8').replace(/const VERSION = '[^']*';/, '') : content);
  }
  return hash.digest('hex').slice(0, 12);
}
