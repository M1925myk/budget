// Ставит в sw.js контрольные суммы файлов и версию (хеш всего приложения).
// Без смены версии установленное приложение не узнает об обновлении.
// Запуск: npm run stamp (тесты падают, если забыть).
import { readFileSync, writeFileSync } from 'node:fs';
import { SW_PATH, computeVersion, fileHashes, renderFilesBlock } from './version.mjs';

const FILES_RE = /const FILES = \{[\s\S]*?\};/;
const VERSION_RE = /const VERSION = '[^']*';/;

const source = readFileSync(SW_PATH, 'utf8');
if (!FILES_RE.test(source) || !VERSION_RE.test(source)) throw new Error('В sw.js не найдены FILES или VERSION');

writeFileSync(SW_PATH, source.replace(FILES_RE, renderFilesBlock(fileHashes())));
const version = computeVersion();
writeFileSync(SW_PATH, readFileSync(SW_PATH, 'utf8').replace(VERSION_RE, `const VERSION = '${version}';`));
console.log(`Версия: ${version}`);
