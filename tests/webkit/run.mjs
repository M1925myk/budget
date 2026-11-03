// Проверка в настоящем движке WebKit через системную библиотеку macOS. Настройки Safari не меняются.
// Запуск: npm run webkit. Снимок экрана: WEBKIT_SHOT=<файл> npm run webkit
// Это WebKit для macOS, а не iOS: движок тот же, но вид поля даты и клавиатура здесь другие.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../tools/serve.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const workDir = mkdtempSync(join(process.env.E2E_TMP ?? tmpdir(), 'webkit-'));
const driver = join(workDir, 'driver');
const shot = process.env.WEBKIT_SHOT ?? join(workDir, 'shot.png');

execFileSync('swiftc', ['-o', driver, join(here, 'driver.swift'), '-framework', 'Cocoa', '-framework', 'WebKit'], { stdio: ['ignore', 'ignore', 'inherit'] });

const server = await startServer(0);
const url = `http://localhost:${server.address().port}/`;
const stdout = await new Promise((resolve, reject) => {
  const proc = spawn(driver, [url, join(here, 'scenario.js'), shot], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  proc.stdout.on('data', (chunk) => {
    out += chunk;
  });
  proc.on('error', reject);
  proc.on('exit', () => resolve(out));
});
server.closeAllConnections();
server.close();

const report = JSON.parse(stdout.trim().split('\n').pop());
if (report.driverError) {
  console.error('Ошибка запуска:', report.driverError);
  process.exit(1);
}

const failed = report.results.filter((r) => !r.ok);
for (const r of report.results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : `: ${r.detail}`}`);
console.log(`\n${report.userAgent}`);
console.log('Возможности движка:', JSON.stringify(report.support));
console.log(`\n${report.results.length - failed.length} из ${report.results.length} проверок прошли в WebKit.`);
rmSync(workDir, { recursive: true, force: true });
process.exit(failed.length === 0 ? 0 : 1);
