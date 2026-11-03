// Проверки исходников: приватность, безопасность и то, что приложение можно обновить и запустить офлайн.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DOCS_DIR, SW_PATH, computeVersion, fileHashes, listAppFiles, renderFilesBlock } from '../tools/version.mjs';

const read = (name) => readFileSync(join(DOCS_DIR, name), 'utf8');
const textFiles = ['index.html', 'styles.css', 'app.js', 'core.js', 'boot.js', 'sw.js', 'manifest.webmanifest'];

describe('приватность', () => {
  test('в приложении нет внешних адресов', () => {
    for (const name of textFiles) {
      const urls = read(name).match(/\b(?:https?|wss?|ftp):\/\/[^\s"'`)]+/g) ?? [];
      // Единственное исключение — идентификатор пространства имён SVG, это не сетевой запрос.
      const external = urls.filter((url) => url !== 'http://www.w3.org/2000/svg');
      assert.deepEqual(external, [], name);
      assert.doesNotMatch(read(name), /(^|["'(\s])\/\/[a-z0-9-]+\.[a-z]{2,}/im, `${name}: адрес без протокола`);
    }
  });

  test('в коде интерфейса нет способов отправить данные по сети', () => {
    for (const name of ['app.js', 'core.js', 'boot.js']) {
      const source = read(name);
      for (const api of [/\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /\bWebSocket\b/, /EventSource/, /RTCPeerConnection/, /\bnew\s+Worker\b/, /\bimportScripts\b/, /\bimport\s*\(/]) {
        assert.doesNotMatch(source, api, `${name}: ${api}`);
      }
    }
  });

  test('service worker обращается к сети только за файлами своего адреса', () => {
    const source = read('sw.js');
    assert.deepEqual(source.match(/\bfetch\([^)]*\)/g), ["fetch(path, { cache: 'reload' })", 'fetch(request)'], 'только свои файлы и запросы страницы');
    assert.match(source, /request\.method !== 'GET' \|\| url\.origin !== self\.location\.origin\) return/);
    assert.doesNotMatch(source, /localStorage|indexedDB|postMessage/);
  });

  test('нет сторонних шрифтов и импортов стилей', () => {
    assert.doesNotMatch(read('styles.css'), /@import|url\(/);
    assert.doesNotMatch(read('styles.css'), /@font-face/);
  });

  test('только локальные файлы в HTML', () => {
    const html = read('index.html');
    for (const [, url] of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
      assert.match(url, /^[a-z0-9_./-]+$/i, url);
      assert.doesNotMatch(url, /^\/|:/, url);
    }
  });
});

describe('безопасность', () => {
  const html = read('index.html');
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
  const directive = (name) => csp.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name} `));

  test('политика безопасности запрещает внешнее и встроенный код', () => {
    assert.equal(directive('default-src'), "default-src 'none'");
    assert.equal(directive('script-src'), "script-src 'self'");
    assert.equal(directive('style-src'), "style-src 'self'");
    assert.equal(directive('connect-src'), "connect-src 'none'");
    assert.equal(directive('img-src'), "img-src 'self'");
    assert.equal(directive('base-uri'), "base-uri 'none'");
    assert.equal(directive('form-action'), "form-action 'none'");
    assert.doesNotMatch(csp, /unsafe|\*|data:|blob:|https?:/);
  });

  test('политика идёт раньше всех подключаемых файлов', () => {
    assert.ok(html.indexOf('Content-Security-Policy') < html.search(/<(?:link|script)\b/));
  });

  test('нет опасных способов вставить разметку и выполнить строку как код', () => {
    for (const name of ['app.js', 'core.js', 'boot.js', 'sw.js']) {
      const source = read(name);
      for (const api of [/\.innerHTML/, /\.outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function/, /setTimeout\(\s*['"`]/, /srcdoc/]) {
        assert.doesNotMatch(source, api, `${name}: ${api}`);
      }
    }
  });

  test('в HTML нет встроенных скриптов, стилей и обработчиков', () => {
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/);
    assert.doesNotMatch(html, /<style/);
    assert.doesNotMatch(html, /\sstyle="/);
    assert.doesNotMatch(html, /\son[a-z]+="/);
  });
});

describe('офлайн и обновления', () => {
  const sw = read('sw.js');
  const filesBlock = /const FILES = \{[\s\S]*?\};/.exec(sw)[0];
  const precached = [...filesBlock.matchAll(/'\.\/([^']+)':/g)].map((match) => match[1]);

  test('все файлы приложения сохраняются для работы без интернета', () => {
    const appFiles = listAppFiles().map((path) => relative(DOCS_DIR, path)).filter((name) => name !== 'sw.js');
    assert.deepEqual([...precached].sort(), appFiles.sort());
  });

  test('контрольные суммы файлов в sw.js актуальны: иначе обновление не установится', () => {
    assert.equal(filesBlock, renderFilesBlock(fileHashes()), 'запусти npm run stamp');
  });

  test('установка сверяет каждый файл и не хранит ответы с редиректом', () => {
    assert.match(sw, /sha256\(body\)\) !== expectedHash/);
    assert.match(sw, /new Response\(body/);
  });

  test('запасной экран подключён раньше приложения', () => {
    const html = read('index.html');
    assert.ok(html.indexOf('src="boot.js"') > 0);
    assert.ok(html.indexOf('src="boot.js"') < html.indexOf('src="app.js"'));
    assert.doesNotMatch(/<script src="boot\.js"[^>]*>/.exec(html)[0], /defer|async|module/);
  });

  test('версия в sw.js совпадает с содержимым: иначе телефон не получит обновление', () => {
    const version = /const VERSION = '([^']+)';/.exec(readFileSync(SW_PATH, 'utf8'))[1];
    assert.equal(version, computeVersion(), 'запусти npm run stamp');
  });

  test('при обновлении удаляются только свои кэши', () => {
    assert.match(sw, /name\.startsWith\(CACHE_PREFIX\)/);
  });

  test('пути относительные: приложение работает из подпапки хостинга', () => {
    const manifest = JSON.parse(read('manifest.webmanifest'));
    assert.equal(manifest.start_url, './');
    assert.equal(manifest.scope, './');
    assert.equal(manifest.display, 'standalone');
    for (const icon of manifest.icons) assert.doesNotMatch(icon.src, /^\//);
    assert.match(read('app.js'), /register\('sw\.js'\)/);
  });
});

describe('значки', () => {
  const pngInfo = (name) => {
    const buffer = readFileSync(join(DOCS_DIR, 'icons', name));
    assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG', name);
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), colorType: buffer[25] };
  };

  for (const [name, size] of [['icon-180.png', 180], ['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable-512.png', 512]]) {
    test(`${name}: ${size}×${size}, без прозрачности`, () => {
      assert.deepEqual(pngInfo(name), { width: size, height: size, colorType: 2 });
    });
  }

  test('заставка под iPhone 15 Pro Max', () => {
    const { width, height } = pngInfo('splash-1290x2796.png');
    assert.deepEqual([width, height], [1290, 2796]);
    assert.match(read('index.html'), /device-width: 430px\) and \(device-height: 932px\)/);
  });
});

describe('удобство на iPhone', () => {
  const css = read('styles.css');
  const html = read('index.html');

  test('поля ввода не меньше 16px: иначе iPhone увеличивает страницу', () => {
    assert.match(css, /font-size: max\(16px, 1rem\)/);
  });

  test('учтены вырез экрана и полоска «Домой»', () => {
    assert.match(html, /viewport-fit=cover/);
    assert.match(css, /safe-area-inset-top/);
    assert.match(css, /safe-area-inset-bottom/);
  });

  test('масштабирование не запрещено', () => {
    assert.doesNotMatch(html, /user-scalable|maximum-scale/);
  });

  test('учитывается настройка «уменьшить движение»', () => {
    assert.match(css, /prefers-reduced-motion: reduce/);
  });

  test('контрастность основных цветов не ниже 4,5:1', () => {
    const token = (name) => new RegExp(`--${name}: (#[0-9a-f]{6})`).exec(css)[1];
    const luminance = (hex) => {
      const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a, b) => {
      const [hi, lo] = [luminance(token(a)), luminance(token(b))].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const [fg, bg] of [
      ['text', 'bg'], ['text', 'surface'], ['text', 'surface-raised'],
      ['muted', 'bg'], ['muted', 'surface'], ['muted', 'surface-raised'],
      ['accent', 'bg'], ['accent', 'surface'], ['on-accent', 'accent'],
      ['danger', 'bg'], ['danger', 'surface'], ['danger', 'surface-raised'], ['danger', 'danger-surface'],
    ]) {
      assert.ok(contrast(fg, bg) >= 4.5, `${fg} на ${bg}: ${contrast(fg, bg).toFixed(2)}`);
    }
    // Граница поля ввода: норма для элементов интерфейса 3:1.
    for (const bg of ['bg', 'surface', 'surface-raised']) {
      assert.ok(contrast('control-line', bg) >= 3, `граница поля на ${bg}: ${contrast('control-line', bg).toFixed(2)}`);
    }
  });
});
