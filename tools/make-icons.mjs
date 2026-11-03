// Рисует значки приложения без внешних библиотек и файлов.
// Запуск: npm run icons
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'icons');
mkdirSync(outDir, { recursive: true });

const BG = [0x0b, 0x0d, 0x0c];
const ACCENT = [0xc8, 0xf0, 0x4d];
const ACCENT_DARK = [0x7f, 0x9c, 0x2c];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

function encodePng(width, height, rgbRows) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 8 бит на канал
  header[9] = 2; // RGB без прозрачности: iPhone не принимает значки с прозрачностью
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rgbRows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Расстояние до скруглённого прямоугольника: отрицательное — внутри.
function roundedRect(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const qx = Math.abs(px - cx) - ((x1 - x0) / 2 - r);
  const qy = Math.abs(py - cy) - ((y1 - y0) / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

const mix = (a, b, t) => a.map((value, i) => value + (b[i] - value) * t);

/** Значок-кошелёк в единичном квадрате: scale < 1 оставляет поля для адаптивных значков. */
function shade(u, v, scale) {
  const x = (u - 0.5) / scale + 0.5;
  const y = (v - 0.5) / scale + 0.5;
  const aa = 0.004 / scale;
  const coverage = (distance) => Math.max(0, Math.min(1, 0.5 - distance / (2 * aa)));

  let color = BG;
  // Верхний клапан
  color = mix(color, ACCENT_DARK, coverage(roundedRect(x, y, 0.2, 0.25, 0.72, 0.5, 0.06)));
  // Корпус
  color = mix(color, ACCENT, coverage(roundedRect(x, y, 0.16, 0.34, 0.84, 0.77, 0.08)));
  // Вырез застёжки
  color = mix(color, BG, coverage(roundedRect(x, y, 0.6, 0.48, 0.9, 0.63, 0.075)));
  // Кнопка застёжки
  color = mix(color, ACCENT, coverage(Math.hypot(x - 0.685, y - 0.555) - 0.032));
  return color;
}

function renderIcon(size, scale) {
  const rows = Buffer.alloc((size * 3 + 1) * size);
  let offset = 0;
  for (let py = 0; py < size; py += 1) {
    rows[offset] = 0;
    offset += 1;
    for (let px = 0; px < size; px += 1) {
      const color = shade((px + 0.5) / size, (py + 0.5) / size, scale);
      rows[offset] = Math.round(color[0]);
      rows[offset + 1] = Math.round(color[1]);
      rows[offset + 2] = Math.round(color[2]);
      offset += 3;
    }
  }
  return encodePng(size, size, rows);
}

function renderSolid(width, height, color) {
  const row = Buffer.alloc(width * 3 + 1);
  for (let px = 0; px < width; px += 1) {
    row[1 + px * 3] = color[0];
    row[2 + px * 3] = color[1];
    row[3 + px * 3] = color[2];
  }
  return encodePng(width, height, Buffer.concat(Array.from({ length: height }, () => row)));
}

const write = (name, buffer) => {
  writeFileSync(join(outDir, name), buffer);
  console.log(`${name}: ${(buffer.length / 1024).toFixed(1)} КБ`);
};

write('icon-180.png', renderIcon(180, 1));
write('icon-192.png', renderIcon(192, 1));
write('icon-512.png', renderIcon(512, 1));
write('icon-maskable-512.png', renderIcon(512, 0.78));
// Заставка iPhone 15 Pro Max при запуске: тёмная, чтобы экран не вспыхивал белым.
write('splash-1290x2796.png', renderSolid(1290, 2796, BG));
