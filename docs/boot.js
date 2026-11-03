// Запускается раньше приложения и отдельно от него. Если файлы приложения не загрузились или
// упали при запуске, вместо чёрного экрана показывает, что случилось, и даёт перезагрузить файлы.
// Данные при этом не трогает: траты лежат в localStorage, а удаляются только файлы приложения.
(() => {
  const START_TIMEOUT_MS = 8000;
  const PROBE_TIMEOUT_MS = 10000;
  const UNREGISTER_TIMEOUT_MS = 3000;
  const APP_DIR = new URL('./', location.href).pathname;
  const CACHE_PREFIX = `daily-budget-${encodeURIComponent(APP_DIR)}-`;
  let started = false;

  const byId = (id) => document.getElementById(id);

  function whenReady(action) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', action, { once: true });
    else action();
  }

  function showFatal(message) {
    whenReady(() => {
      // Открытый лист перекрыл бы сообщение.
      const sheet = byId('sheet');
      if (sheet.open) sheet.close();
      const box = byId('fatal');
      box.textContent = `Сбой приложения: ${message}. Закрой и открой приложение заново.`;
      box.hidden = false;
    });
  }

  function showStartFailure(detail) {
    whenReady(() => {
      if (started) return;
      byId('start-failure-detail').textContent = detail;
      byId('start-failure').hidden = false;
    });
  }

  const report = (message) => (started ? showFatal(message) : showStartFailure(message));

  window.addEventListener('error', (event) => {
    if (event.target instanceof HTMLScriptElement) report(`не загрузился файл ${event.target.src}`);
    else if (event.target === window) report(event.message);
  }, true);
  window.addEventListener('unhandledrejection', (event) => {
    report(event.reason?.message ?? String(event.reason));
  });
  setTimeout(() => {
    if (!started) showStartFailure('приложение не ответило вовремя');
  }, START_TIMEOUT_MS);

  async function findRegistrations() {
    if (!('serviceWorker' in navigator)) return [];
    const scope = new URL('./', location.href).href;
    return (await navigator.serviceWorker.getRegistrations()).filter((r) => r.scope === scope);
  }

  /**
   * navigator.onLine бывает true и без настоящей связи, а fetch страница не может использовать
   * по своей же политике безопасности. Поэтому связь проверяем загрузкой значка мимо кэша:
   * service worker не перехватывает адреса с параметром probe.
   */
  function isHostingReachable() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
      const finish = (result) => {
        clearTimeout(timer);
        resolve(result);
      };
      const probe = new Image();
      probe.onload = () => finish(true);
      probe.onerror = () => finish(false);
      probe.src = `icons/icon-180.png?probe=${Date.now()}`;
    });
  }

  /**
   * Кэш очищается первым: после этого даже старый service worker берёт файлы из сети.
   * Удаление регистрации ждёт очереди и может зависнуть, если висит загрузка обновления, поэтому оно ограничено по времени.
   */
  async function removeAppFiles(registrations) {
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX)).map((name) => caches.delete(name)));
    }
    await Promise.race([
      Promise.all(registrations.map((r) => r.unregister())),
      new Promise((resolve) => setTimeout(resolve, UNREGISTER_TIMEOUT_MS)),
    ]);
  }

  whenReady(() => {
    byId('start-reload').addEventListener('click', async (event) => {
      if (!navigator.onLine) {
        byId('start-failure-note').textContent = 'Сейчас нет интернета. Подключись к сети и нажми ещё раз.';
        return;
      }
      const button = event.currentTarget;
      const note = byId('start-failure-note');
      button.disabled = true;
      note.textContent = 'Проверяю связь с сервером приложения…';
      if (!(await isHostingReachable())) {
        note.textContent = 'Не удалось связаться с сервером приложения. Проверь интернет и нажми ещё раз.';
        button.disabled = false;
        return;
      }
      try {
        await removeAppFiles(await findRegistrations());
      } catch (error) {
        console.error('Не удалось очистить файлы приложения:', error);
      }
      location.reload();
    });
  });

  window.budgetBoot = {
    started() {
      started = true;
      whenReady(() => {
        byId('start-failure').hidden = true;
      });
    },
  };
})();
