// Хранит файлы приложения на телефоне, чтобы оно открывалось без интернета.
// Никаких данных не читает и не отправляет. VERSION и FILES обновляет tools/stamp-version.mjs.
const VERSION = 'bdb10b40b227';
const FILES = {
  './app.js': '8b16f6efd3411f0e7a318d60a0c03b67687248ef621b38d9068b988002f0adc7',
  './boot.js': '289fa20900f6319677092e70ae29ef3e0ad2cf67230d847d1c2daafc876585e5',
  './core.js': '057f66b03d39733d4869d0934fe1368fdb67babb47a0812eaa67ac26de70e972',
  './icons/icon-180.png': '2cd2d9c670776f39a2f43185368cc26b031f09aeb8478d5a6f5be8a330f4d350',
  './icons/icon-192.png': '931cb82c7949a0ef45ccc2a9ff51ef8b6ebc31bf59b6eb25f9038bf1c5998c3c',
  './icons/icon-512.png': '87814d75c82dd810a9a6f4123d75920b70ee85e46e6699df80aae966ea5ba0b5',
  './icons/icon-maskable-512.png': '5031b6e0505e175db0159ba26c747a7cdf008c6d8311b6616470fdea17fc5cca',
  './icons/splash-1290x2796.png': '10dfbd0c19e072d91bdfdcf0c2b83336ff55dc9a0f14591bb00643700b139bb4',
  './index.html': 'e4cda06c3236cb6ce41224763e758fe1a46bf977597347282858a1e31f189d52',
  './manifest.webmanifest': '166672c8f64b546c3928775fedc3fbb8eeda2222b0bf21ef40ccfc6827d898a5',
  './styles.css': '921ad3e654bc3df7929a1c205f7a9392e079129384c9f5f8f442565df9f68006',
};

// Версия ставится только целиком: каждый файл сверяется с контрольной суммой. Если хостинг отдал
// старый файл или страницу ошибки, установка не удаётся, а телефон остаётся на прошлой версии.
const SCOPE_PATH = new URL(self.registration.scope).pathname;
const CACHE_PREFIX = `daily-budget-${encodeURIComponent(SCOPE_PATH)}-`;
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;

async function sha256(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function downloadFile(path, expectedHash) {
  // cache: 'reload' — мимо кэша браузера.
  const response = await fetch(path, { cache: 'reload' });
  if (!response.ok) throw new Error(`${path}: ответ ${response.status}`);
  const body = await response.arrayBuffer();
  if ((await sha256(body)) !== expectedHash) throw new Error(`${path}: файл не совпадает с версией ${VERSION}`);
  return { path, body, type: response.headers.get('content-type') ?? 'application/octet-stream' };
}

async function saveAllFiles() {
  const files = await Promise.all(Object.entries(FILES).map(([path, hash]) => downloadFile(path, hash)));
  const cache = await caches.open(CACHE_NAME);
  // Новый ответ вместо полученного: страницу, пришедшую через редирект, браузер не примет от service worker.
  await Promise.all(files.map(({ path, body, type }) => cache.put(path, new Response(body, { headers: { 'content-type': type } }))));
}

self.addEventListener('install', (event) => {
  event.waitUntil(saveAllFiles().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      // Удаляем только свои старые версии: у соседних проектов на том же домене свои кэши.
      await Promise.all(
        names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

async function repairIfIncomplete() {
  const cache = await caches.open(CACHE_NAME);
  if ((await cache.keys()).length < Object.keys(FILES).length) await saveAllFiles();
}

async function findCached(request, isAppPage) {
  try {
    const cache = await caches.open(CACHE_NAME);
    return await (isAppPage ? cache.match('./index.html') : cache.match(request, { ignoreSearch: true }));
  } catch (error) {
    console.error('Кэш недоступен, загружаю из сети:', error);
    return undefined;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.searchParams.has('probe')) return; // Проверка связи из boot.js должна идти в сеть, а не в кэш.

  // Страницы приложения — только его адрес. Другие страницы того же домена не наши.
  const isAppPage = request.mode === 'navigate' && (url.pathname === SCOPE_PATH || url.pathname === `${SCOPE_PATH}index.html`);
  if (request.mode === 'navigate' && !isAppPage) return;

  // Система могла очистить кэш целиком или частично. Заодно восстанавливаем работу без интернета.
  if (isAppPage) event.waitUntil(repairIfIncomplete().catch((error) => console.error('Не удалось восстановить кэш:', error)));

  event.respondWith(
    (async () => (await findCached(request, isAppPage)) ?? fetch(request))(),
  );
});
