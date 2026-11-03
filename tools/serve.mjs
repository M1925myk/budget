// Локальный сервер только для разработки и тестов. Телефону он не нужен.
// Запуск: npm run serve → http://localhost:4173
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { DOCS_DIR } from './version.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

export function startServer(port = 0, onRequest = () => {}, prefix = '', root = DOCS_DIR) {
  const server = createServer((request, response) => {
    // Тесты могут сами ответить на запрос, чтобы изобразить поведение настоящего хостинга.
    onRequest(request, response);
    if (response.headersSent) return;
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (prefix && !pathname.startsWith(`${prefix}/`)) {
      response.writeHead(404).end();
      return;
    }
    const relativePath = normalize(pathname.slice(prefix.length)).replace(/^[/\\]+/, '') || 'index.html';
    const filePath = join(root, relativePath.endsWith(sep) ? `${relativePath}index.html` : relativePath);
    if (!filePath.startsWith(root + sep) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'content-type': TYPES[extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(filePath).pipe(response);
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

if (process.argv[1] && process.argv[1].endsWith('serve.mjs')) {
  const port = Number(process.argv[2] ?? 4173);
  await startServer(port);
  console.log(`http://localhost:${port}/`);
}
