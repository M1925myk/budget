// Сквозные проверки в настоящем браузере с экраном iPhone 15 Pro Max (430×932).
// Запуск: npm run e2e. Снимки экрана: E2E_SHOTS=<папка> npm run e2e
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOCS_DIR, fileHashes } from '../../tools/version.mjs';
import { startServer } from '../../tools/serve.mjs';
import { launchChrome } from './browser.mjs';

const SHOTS = process.env.E2E_SHOTS ?? null;
const ONLY = process.env.E2E_ONLY ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

// Подменяет часы на странице. Хранит время в отдельном ключе, чтобы пережить перезагрузку.
const FAKE_CLOCK = `(() => {
  const RealDate = Date;
  let fixed = null;
  try { const v = localStorage.getItem('__fakeNow'); if (v) fixed = Number(v); } catch {}
  const current = () => (fixed === null ? RealDate.now() : fixed);
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(current()); else super(...args); }
    static now() { return current(); }
  }
  window.Date = FakeDate;
  window.__setNow = (ms) => { fixed = ms; localStorage.setItem('__fakeNow', String(ms)); };
})();`;

// Приложение установлено на главный экран. Без этого эмуляция сенсорного экрана считается iPhone в Safari.
// 17 px — стандартный размер текста на iPhone: на компьютере системный шрифт iOS недоступен.
const INSTALLED = `
  Object.defineProperty(navigator, 'standalone', { value: true });
  document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = '17px'; });
`;

// Вырез экрана iPhone 15 Pro Max сверху.
const SAFE_TOP = 59;
// Клавиатура с панелью «Готово» оставляет сверху примерно столько экрана.
const VISIBLE_WITH_KEYBOARD = 563;

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const STORAGE_KEY = 'daily-budget.state.v1';
const NBSP = ' ';
const money = (text) => text.replaceAll(NBSP, ' ');
const noon = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0).getTime();
};

const requestsSeen = [];
let server = await startServer(0, (request) => requestsSeen.push({ method: request.method, url: request.url, length: Number(request.headers['content-length'] ?? 0) }));
const port = server.address().port;
const ORIGIN = `http://localhost:${port}`;
const URL_APP = `${ORIGIN}/`;

const browser = await launchChrome();
const results = [];

async function setClock(page, iso) {
  await page.evaluate(`window.__setNow(${noon(iso)})`);
}

/** Новый чистый профиль с заданной датой. */
async function freshPage(iso = '2026-11-02', { viewport } = {}) {
  const page = await browser.newPage({ init: `${FAKE_CLOCK}\n${INSTALLED}` });
  await page.viewport(viewport);
  await page.safeArea();
  await page.navigate(URL_APP);
  await setClock(page, iso);
  await page.navigate(URL_APP);
  return page;
}

async function start(page, budget = '660') {
  await page.type('#onb-amount', budget);
  await page.click('#onb-submit');
  await page.waitFor(`Boolean(document.querySelector('#hero-amount'))`);
}

async function addSpend(page, amount, { note, category, date } = {}) {
  await page.type('#add-amount', amount);
  if (category) await page.click(`.chip[data-id="${category}"]`);
  if (note) await page.type('#add-note', note);
  if (date) await page.setValue('#add-date', date);
  await page.click('#add-submit');
}

const importFile = (target, text) => target.evaluate(`(() => {
  const input = document.getElementById('import-file');
  const dt = new DataTransfer();
  dt.items.add(new File([${JSON.stringify(text)}], 'copy.json', { type: 'application/json' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
})()`);

const hero = async (page) => money(await page.text('#hero-amount'));
const wallet = async (page) => money(await page.text('#wallet-amount'));
const stored = (page) => page.evaluate(`JSON.parse(localStorage.getItem('${STORAGE_KEY}'))`);

async function shot(page, name) {
  if (!SHOTS) return;
  await page.evaluate('new Promise((r) => setTimeout(r, 280))'); // дождаться конца анимаций
  writeFileSync(join(SHOTS, `${name}.png`), await page.screenshot());
}

async function noErrors(page) {
  assert.deepEqual(page.exceptions, [], 'необработанные исключения');
  assert.equal(await page.visible('#fatal'), false, 'баннер сбоя');
}

async function scenario(name, run) {
  if (ONLY && !name.includes(ONLY)) return;
  const startedAt = Date.now();
  try {
    await run();
    results.push({ name, ok: true });
    console.log(`  ok   ${name} (${Date.now() - startedAt} мс)`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  FAIL ${name}\n       ${String(error.stack ?? error).split('\n').slice(0, 8).join('\n       ')}`);
  }
}

// ---------- Сценарии ----------

await scenario('первый запуск: сумма, расчёт, сохранение', async () => {
  const page = await freshPage('2026-11-02');
  assert.ok(await page.visible('#onb-amount'));
  assert.equal(await page.evaluate(`document.getElementById('tabs').hidden`), true);
  await shot(page, '01-onboarding');

  await page.click('#onb-submit');
  assert.match(await page.text('.field-error'), /Введи сумму/);

  await page.type('#onb-amount', 'abc');
  await page.click('#onb-submit');
  assert.match(await page.text('.field-error'), /неверно/);

  await page.type('#onb-amount', '660');
  assert.match(money(await page.text('#onb-preview')), /22,00 € в день/);
  assert.match(money(await page.text('#onb-preview')), /44,00 €/, 'второй день месяца: считаем с первого');
  await shot(page, '02-onboarding-filled');
  await page.click('#onb-submit');
  await page.waitFor(`Boolean(document.querySelector('#hero-amount'))`);

  assert.equal(await hero(page), '44,00 €');
  assert.equal(await wallet(page), '660,00 €');
  assert.equal(await page.text('#topbar-day'), '2 ноября');
  await shot(page, '03-today-empty');

  await page.navigate(URL_APP);
  assert.equal(await hero(page), '44,00 €', 'после перезапуска данные на месте');
  await noErrors(page);
});

await scenario('главный пример: 22 → −10 → 34 €', async () => {
  const page = await freshPage('2026-11-01');
  await start(page);
  assert.equal(await hero(page), '22,00 €');

  await addSpend(page, '10', { category: 'c-food', note: 'Продукты' });
  assert.equal(await hero(page), '12,00 €');
  assert.equal(await wallet(page), '650,00 €');
  assert.match(money(await page.text('#hero-caption')), /Потрачено 10,00 € из 22,00 €/);
  assert.match(await page.text('#today-list'), /Еда/);
  assert.match(await page.text('#today-list'), /Продукты/);
  assert.equal(await page.evaluate(`document.getElementById('add-amount').value`), '', 'форма очищена');
  assert.match(money(await page.text('#toast')), /Записано: 10,00 €/);
  await shot(page, '04-today-spend');

  await setClock(page, '2026-11-02');
  await page.navigate(URL_APP);
  assert.equal(await hero(page), '34,00 €');
  assert.match(await page.text('#today-list'), /Пока ничего/);
  await noErrors(page);
});

await scenario('быстрый ввод: без категории и заметки, с запятой и точкой', async () => {
  const page = await freshPage('2026-11-01');
  await start(page);
  await addSpend(page, '1,5');
  assert.equal(await hero(page), '20,50 €');
  await addSpend(page, '0.50');
  assert.equal(await hero(page), '20,00 €');
  const { transactions } = await stored(page);
  assert.deepEqual(transactions.map((t) => [t.amount, t.categoryId, t.note]), [[150, null, ''], [50, null, '']]);
  assert.match(await page.text('#today-list'), /Без категории/);
});

await scenario('ошибки ввода траты не сохраняются', async () => {
  const page = await freshPage('2026-11-05');
  await start(page);
  for (const bad of ['0', 'abc', '1,234', '-5', '1e3']) {
    await page.type('#add-amount', bad);
    await page.click('#add-submit');
    assert.ok(await page.visible('.field-error'), `ошибка для «${bad}»`);
    assert.equal((await stored(page)).transactions.length, 0, bad);
  }
  await page.type('#add-amount', '5');
  await page.setValue('#add-date', '2026-11-06');
  await page.click('#add-submit');
  assert.match(await page.text('#add-form'), /будущем/);
  await page.setValue('#add-date', '2026-10-31');
  await page.click('#add-submit');
  assert.match(await page.text('#add-form'), /Более ранние/);
  await page.setValue('#add-date', '');
  await page.click('#add-submit');
  assert.match(await page.text('#add-form'), /Выбери дату/);
  assert.equal((await stored(page)).transactions.length, 0);
  await noErrors(page);
});

await scenario('двойное нажатие «Записать» создаёт одну трату', async () => {
  const page = await freshPage('2026-11-01');
  await start(page);
  await page.type('#add-amount', '5');
  await page.click('#add-submit');
  await page.click('#add-submit');
  assert.equal((await stored(page)).transactions.length, 1);
  assert.equal(await page.visible('#add-form .field-error'), false, 'без ложной ошибки');
});

await scenario('перерасход: красный минус и дата возврата в плюс', async () => {
  const page = await freshPage('2026-11-01');
  await start(page);
  await addSpend(page, '100');
  assert.equal(await hero(page), '−78,00 €');
  assert.equal(await page.evaluate(`document.getElementById('hero').classList.contains('is-negative')`), true);
  assert.match(await page.text('#hero-caption'), /Перерасход/);
  assert.match(await page.text('#hero-caption'), /5 ноября/);
  await shot(page, '05-overspend');
  for (const [date, expected] of [['2026-11-02', '−56,00 €'], ['2026-11-03', '−34,00 €'], ['2026-11-04', '−12,00 €'], ['2026-11-05', '10,00 €']]) {
    await setClock(page, date);
    await page.navigate(URL_APP);
    assert.equal(await hero(page), expected, date);
  }
  await noErrors(page);
});

await scenario('смена месяца: остаток и долг переходят на первый день', async () => {
  const page = await freshPage('2027-03-31');
  await start(page);
  await addSpend(page, '610');
  assert.equal(await wallet(page), '50,00 €');
  await setClock(page, '2027-04-01');
  await page.navigate(URL_APP);
  assert.equal(await hero(page), '72,00 €');
  assert.equal(await wallet(page), '710,00 €');

  const debt = await freshPage('2027-03-31');
  await start(debt);
  await addSpend(debt, '690');
  await setClock(debt, '2027-04-01');
  await debt.navigate(URL_APP);
  assert.equal(await hero(debt), '−8,00 €');
  assert.equal(await wallet(debt), '630,00 €');
});

await scenario('старт с середины месяца', async () => {
  const page = await freshPage('2026-11-15');
  await start(page);
  assert.equal(await hero(page), '330,00 €');
  assert.equal(await wallet(page), '660,00 €');
});

await scenario('день меняется, пока приложение открыто', async () => {
  const page = await freshPage('2026-11-01');
  await start(page);
  await page.type('#add-amount', '7');
  await page.evaluate(`window.__setNow(${noon('2026-11-02')}); document.dispatchEvent(new Event('visibilitychange'))`);
  assert.equal(await hero(page), '44,00 €');
  assert.equal(await page.text('#topbar-day'), '2 ноября');
  assert.equal(await page.evaluate(`document.getElementById('add-date').value`), '2026-11-02');
  assert.equal(await page.evaluate(`document.getElementById('add-amount').value`), '7', 'ввод не потерян');
});

await scenario('кошелёк показывает оба баланса и меняет бюджет', async () => {
  const page = await freshPage('2026-11-20');
  await start(page);
  assert.equal(await hero(page), '440,00 €');
  await page.click('#wallet');
  assert.equal(money(await page.text('#wallet-sheet-today')), '440,00 €');
  assert.equal(money(await page.text('#wallet-sheet-month')), '660,00 €');
  await shot(page, '06-wallet');
  await page.click('#wallet-budget');
  await page.type('#budget-amount', '800');
  assert.match(money(await page.text('#budget-helper')), /вырастет на 93,33 €/);
  await shot(page, '07-budget');
  await page.click('#budget-save');
  assert.equal(await page.evaluate(`document.getElementById('sheet').open`), false);
  assert.equal(await hero(page), '533,33 €');
  assert.equal(await wallet(page), '800,00 €');
  await page.click('#wallet');
  await page.click('#sheet-close');
  assert.equal(await page.evaluate(`document.getElementById('sheet').open`), false);
  await noErrors(page);
});

await scenario('новый месяц берёт прошлую сумму, прошлый месяц можно поправить', async () => {
  const page = await freshPage('2026-11-15');
  await start(page);
  await setClock(page, '2027-01-10');
  await page.navigate(URL_APP);
  await page.click('#tab-month');
  assert.equal(await page.text('#month-title'), 'январь 2027');
  assert.match(money(await page.text('#month-summary')), /660,00 €/);
  assert.match(money(await page.text('#month-summary')), /\+1 320,00 €/);
  await shot(page, '08-month-carry');

  await page.click('#month-prev');
  await page.click('#month-prev');
  assert.equal(await page.text('#month-title'), 'ноябрь 2026');
  assert.equal(await page.evaluate(`document.getElementById('month-prev').disabled`), true);
  await page.click('#month-budget');
  await page.type('#budget-amount', '0');
  await page.click('#budget-save');
  await page.click('#month-next');
  assert.match(money(await page.text('#month-summary')), /660,00 €/, 'декабрь не изменился');
  assert.deepEqual((await stored(page)).budgets, { '2026-11': 0, '2026-12': 66000 });
  await noErrors(page);
});

await scenario('редактирование и удаление траты, отмена удаления', async () => {
  const page = await freshPage('2026-11-03');
  await start(page);
  await addSpend(page, '10', { note: 'Кофе', category: 'c-food' });
  assert.equal(await hero(page), '56,00 €');
  await page.click('#today-list .tx-row');
  await shot(page, '09-edit');
  assert.equal(await page.evaluate(`document.getElementById('edit-amount').value`), '10');
  assert.equal(await page.evaluate(`document.getElementById('edit-category').value`), 'c-food');

  await page.type('#edit-amount', '0');
  await page.click('#edit-save');
  assert.match(await page.text('#sheet'), /больше нуля/);
  await page.type('#edit-amount', '12,50');
  await page.type('#edit-note', 'Кофе и булочка');
  await page.setValue('#edit-category', '');
  await page.click('#edit-save');
  assert.equal(await hero(page), '53,50 €');
  assert.match(await page.text('#today-list'), /Кофе и булочка/);
  assert.match(await page.text('#today-list'), /Без категории/);

  await page.click('#today-list .tx-row');
  await page.setValue('#edit-date', '2026-11-01');
  await page.click('#edit-save');
  assert.match(await page.text('#today-list'), /Пока ничего/);
  assert.equal(await hero(page), '53,50 €', 'лимит учитывает трату прошлых дней');

  await page.click('#tab-month');
  await page.click('#month-history .tx-row');
  await page.click('#edit-delete');
  assert.match(await page.text('#month-history'), /трат нет/);
  assert.match(money(await page.text('#month-summary')), /Осталось.*660,00 €/);
  await page.click('#toast-action');
  assert.equal((await stored(page)).transactions.length, 1, 'удаление отменено');
  assert.match(await page.text('#month-history'), /Кофе и булочка/);
  await noErrors(page);
});

await scenario('запись прошедшего дня и отмена записи', async () => {
  const page = await freshPage('2026-11-03');
  await start(page);
  await addSpend(page, '6', { date: '2026-11-01' });
  assert.equal(await hero(page), '60,00 €');
  assert.match(await page.text('#toast'), /за 1 ноября/);
  assert.equal(await page.evaluate(`document.getElementById('add-date').value`), '2026-11-03', 'дата вернулась на сегодня');
  await page.click('#toast-action');
  assert.equal(await hero(page), '66,00 €');
  assert.equal((await stored(page)).transactions.length, 0);
});

await scenario('категории: своя, переименование, удаление', async () => {
  const page = await freshPage('2026-11-03');
  await start(page);

  await page.click('#chip-add');
  await page.type('#cat-name', 'Кафе');
  await shot(page, '10-category');
  await page.click('#cat-save');
  const created = await page.evaluate(`document.querySelector('.chip[aria-pressed="true"]').dataset.id`);
  assert.equal(await page.text(`.chip[data-id="${created}"]`), 'Кафе', 'новая категория сразу выбрана');
  await page.type('#add-amount', '15');
  await page.click('#add-submit');
  assert.match(await page.text('#today-list'), /Кафе/);

  await page.click('#chip-add');
  await page.type('#cat-name', 'кафе');
  await page.click('#cat-save');
  assert.match(await page.text('#sheet'), /уже есть/);
  await page.click('#sheet-close');

  await page.click('#tab-month');
  assert.match(money(await page.text('#month-categories')), /Кафе.*15,00 €.*100 %/);
  await shot(page, '11-month');

  await page.click('#tab-settings');
  await shot(page, '12-settings');
  await page.click(`.category-row[data-id="${created}"]`);
  await page.type('#cat-name', 'Рестораны');
  await page.click('#cat-save');
  assert.match(await page.text('#category-list'), /Рестораны/);

  await page.click(`.category-row[data-id="${created}"]`);
  await page.click('#cat-delete');
  assert.match(await page.text('#sheet'), /1 трата перейдёт/);
  await page.click('#confirm-yes');
  assert.doesNotMatch(await page.text('#category-list'), /Рестораны/);
  const data = await stored(page);
  assert.equal(data.transactions.length, 1);
  assert.equal(data.transactions[0].categoryId, null);
  await page.click('#tab-today');
  assert.equal(await hero(page), '51,00 €', 'сумма не изменилась');
  await noErrors(page);
});

await scenario('работа без интернета: запуск и запись трат', async () => {
  const page = await freshPage('2026-11-01');
  await start(page);
  await page.waitFor(`navigator.serviceWorker.ready.then(() => Boolean(navigator.serviceWorker.controller))`);
  await page.navigate(URL_APP);

  await new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
  try {
    await page.navigate(URL_APP);
    assert.equal(await hero(page), '22,00 €', 'запуск без сервера');
    await addSpend(page, '2');
    assert.equal(await hero(page), '20,00 €');
    await page.navigate(URL_APP);
    assert.equal(await hero(page), '20,00 €', 'запись пережила перезапуск без сети');
    assert.equal(await page.evaluate(`(async () => (await caches.keys()).filter((n) => n.startsWith('daily-budget-')).length)()`), 1);
    await page.click('#tab-settings');
    await page.waitFor(`document.getElementById('about-status').textContent.includes('готова')`);
    assert.match(await page.text('#about-status'), /Версия: [0-9a-f]{12}/);
    await noErrors(page);
  } finally {
    server = await startServer(port, (request) => requestsSeen.push({ method: request.method, url: request.url, length: Number(request.headers['content-length'] ?? 0) }));
  }
});

await scenario('приватность: наружу не уходит ни один запрос', async () => {
  const before = requestsSeen.length;
  const page = await freshPage('2026-11-01');
  await start(page);
  const secret = 'SECRET-NOTE-12345';
  await addSpend(page, '12,34', { note: secret, category: 'c-food' });
  await page.click('#tab-month');
  await page.click('#tab-settings');
  await page.click('#tab-today');
  await page.navigate(URL_APP);
  await page.evaluate('new Promise((r) => setTimeout(r, 300))');

  // data: — встроенный значок календаря самого Chrome в поле даты, в сеть он не уходит.
  const external = page.requests.filter((r) => !r.url.startsWith(ORIGIN) && !/^(blob:|data:)/.test(r.url) && r.url !== 'about:blank');
  assert.deepEqual(external, [], 'запросы на чужие адреса');
  assert.deepEqual(page.requests.filter((r) => r.method !== 'GET'), [], 'только GET');
  assert.deepEqual(page.requests.filter((r) => r.hasBody), [], 'без тела запроса');
  assert.deepEqual(page.requests.filter((r) => r.url.includes(secret)), [], 'заметка не попала в адрес');

  const atServer = requestsSeen.slice(before);
  assert.ok(atServer.length > 0, 'сервер видел загрузку');
  for (const request of atServer) {
    assert.equal(request.method, 'GET', request.url);
    assert.equal(request.length, 0, request.url);
    assert.doesNotMatch(request.url, /\?|SECRET|12,34|1234/, request.url);
  }
  const allowed = /^\/($|index\.html|styles\.css|boot\.js|app\.js|core\.js|sw\.js|manifest\.webmanifest|icons\/[a-z0-9-]+\.png)$/;
  for (const request of atServer) assert.match(request.url, allowed);
});

await scenario('политика безопасности блокирует внешние запросы в браузере', async () => {
  const page = await freshPage('2026-11-01');
  const blocked = await page.evaluate(`(async () => {
    const outcome = {};
    const violations = [];
    document.addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective));
    outcome.fetch = await fetch('https://example.com/?leak=1').then(() => 'allowed', () => 'blocked');
    outcome.xhr = await new Promise((resolve) => {
      try {
        const x = new XMLHttpRequest();
        x.open('POST', 'https://example.com/');
        x.onload = () => resolve('allowed');
        x.onerror = () => resolve('blocked');
        x.send('leak');
      } catch { resolve('blocked'); }
    });
    outcome.beacon = navigator.sendBeacon('https://example.com/', 'leak') ? 'queued' : 'blocked';
    outcome.image = await new Promise((resolve) => {
      const i = new Image();
      i.onload = () => resolve('allowed');
      i.onerror = () => resolve('blocked');
      i.src = 'https://example.com/x.png?leak=1';
    });
    outcome.script = await new Promise((resolve) => {
      const s = document.createElement('script');
      s.onload = () => resolve('allowed');
      s.onerror = () => resolve('blocked');
      s.src = 'https://example.com/x.js';
      document.head.append(s);
    });
    outcome.inlineScript = (() => {
      window.__inline = false;
      const s = document.createElement('script');
      s.textContent = 'window.__inline = true';
      document.head.append(s);
      return window.__inline ? 'allowed' : 'blocked';
    })();
    outcome.evalCode = (() => { try { return eval('1+1') === 2 ? 'allowed' : 'blocked'; } catch { return 'blocked'; } })();
    await new Promise((r) => setTimeout(r, 100));
    outcome.violations = violations.length;
    return outcome;
  })()`);
  assert.equal(blocked.fetch, 'blocked');
  assert.equal(blocked.xhr, 'blocked');
  assert.equal(blocked.image, 'blocked');
  assert.equal(blocked.script, 'blocked');
  assert.equal(blocked.inlineScript, 'blocked');
  assert.equal(blocked.evalCode, 'blocked');
  assert.ok(blocked.violations >= 6, `нарушений зафиксировано: ${blocked.violations}`);
});

await scenario('код в заметке и названии категории остаётся текстом', async () => {
  const page = await freshPage('2026-11-01');
  await start(page);
  const payloads = [
    '<img src=x onerror="window.__xss=1">',
    '<script>window.__xss=2</script>',
    '"><svg onload=window.__xss=3>',
    "'; window.__xss=4; //",
  ];
  for (const note of payloads) await addSpend(page, '1', { note });
  await page.click('#chip-add');
  await page.type('#cat-name', '<b onclick=x>Ж</b>');
  await page.click('#cat-save');
  await page.waitFor(`!document.getElementById('sheet').open`);
  await page.click('#tab-month');
  await page.click('#tab-settings');
  await page.click('#tab-today');
  await page.evaluate('new Promise((r) => setTimeout(r, 150))');
  assert.equal(await page.evaluate('window.__xss ?? null'), null);
  assert.equal(await page.evaluate(`document.querySelectorAll('#app img, #app script, #app svg[onload], #app b').length`), 0);
  for (const note of payloads) assert.ok((await page.text('#today-list')).includes(note), note);
  await noErrors(page);
});

await scenario('резервная копия: сохранение и восстановление', async () => {
  const page = await freshPage('2026-11-03');
  await start(page);
  await addSpend(page, '10', { note: 'Копия', category: 'c-food' });

  // Сохранение через системное меню «Поделиться»
  await page.evaluate(`
    navigator.canShare = () => true;
    window.__shared = null;
    navigator.share = async (data) => { window.__shared = await data.files[0].text(); window.__sharedName = data.files[0].name; };
  `);
  await page.click('#tab-settings');
  assert.match(await page.text('#backup-status'), /ещё не было/);
  await page.click('#btn-export');
  await page.waitFor('window.__shared !== null');
  assert.equal(await page.evaluate('window.__sharedName'), 'budget-backup-2026-11-03.json');
  await page.waitFor(`document.getElementById('backup-status').textContent.includes('Последняя копия: 3 ноября 2026')`);
  const backup = await page.evaluate('window.__shared');
  assert.ok(JSON.parse(backup).data.transactions.some((t) => t.note === 'Копия'));
  assert.notEqual((await stored(page)).lastBackupAt, null);

  // Отказ в меню «Поделиться» не считается созданной копией
  const cancelled = await freshPage('2026-11-03');
  await start(cancelled);
  await cancelled.evaluate(`
    navigator.canShare = () => true;
    navigator.share = async () => { throw new DOMException('cancel', 'AbortError'); };
  `);
  await cancelled.click('#tab-settings');
  await cancelled.click('#btn-export');
  await cancelled.evaluate('new Promise((r) => setTimeout(r, 100))');
  assert.equal((await stored(cancelled)).lastBackupAt, null);
  assert.equal(await cancelled.visible('.toast-error'), false);

  // Запасной путь — скачивание файла
  const download = await freshPage('2026-11-03');
  await start(download);
  await download.evaluate(`
    navigator.canShare = () => false;
    window.__downloaded = null;
    const createObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { blob.text().then((t) => { window.__downloaded = t; }); return createObjectURL(blob); };
    HTMLAnchorElement.prototype.click = function () { window.__downloadName = this.download; };
  `);
  await download.click('#tab-settings');
  await download.click('#btn-export');
  await download.waitFor('window.__downloaded !== null');
  assert.equal(await download.evaluate('window.__downloadName'), 'budget-backup-2026-11-03.json');

  // Восстановление на «новом телефоне», начиная с первого экрана
  const restored = await freshPage('2026-11-03');
  await importFile(restored, backup);
  await restored.waitFor(`document.getElementById('sheet').open`);
  assert.match(await restored.text('#sheet'), /1 трата/);
  await shot(restored, '13-restore');
  await restored.click('#confirm-yes');
  await restored.waitFor(`Boolean(document.querySelector('#hero-amount'))`);
  assert.equal(await hero(restored), '56,00 €');
  assert.match(await restored.text('#today-list'), /Копия/);
  await noErrors(restored);

  // Плохие файлы отклоняются, а данные остаются
  const dirty = await freshPage('2026-11-03');
  await start(dirty);
  await addSpend(dirty, '1');
  await dirty.click('#tab-settings');
  const untouched = JSON.stringify(await stored(dirty));
  for (const [text, pattern] of [
    ['привет', /не удалось прочитать/],
    ['{"a":1}', /не файл резервной копии/],
    [JSON.stringify({ app: 'daily-budget', exportedAt: 1, data: { version: 99 } }), /более новой версией/],
    [JSON.stringify({ app: 'daily-budget', exportedAt: 1, data: { version: 1, budgets: { '2026-11': -5 }, categories: [], transactions: [], lastBackupAt: null } }), /повреждены/],
    [JSON.stringify({ app: 'daily-budget', exportedAt: 1, data: { version: 1, budgets: { '2026-11': 100 }, categories: [], transactions: [{ id: 'a', date: '2026-11-01', amount: 1, categoryId: 'нет', note: '<img src=x onerror=window.__xss=1>', createdAt: 1 }], lastBackupAt: null } }), /повреждены/],
  ]) {
    await importFile(dirty, text);
    await dirty.waitFor(`document.querySelector('.toast-error') && !document.getElementById('toast').hidden`);
    assert.match(await dirty.text('#toast'), pattern);
    assert.equal(await dirty.evaluate(`document.getElementById('sheet').open`), false);
    assert.equal(JSON.stringify(await stored(dirty)), untouched);
    await dirty.evaluate(`document.getElementById('toast').hidden = true; document.getElementById('toast').classList.remove('toast-error')`);
  }
  assert.equal(await dirty.evaluate('window.__xss ?? null'), null);
  await noErrors(dirty);
});

await scenario('сбой записи: изменение не показывается как сохранённое', async () => {
  const page = await freshPage('2026-11-01');
  await start(page);
  await page.evaluate(`
    Storage.prototype.setItem = function () { throw new DOMException('quota', 'QuotaExceededError'); };
  `);
  await page.type('#add-amount', '5');
  await page.click('#add-submit');
  assert.equal(await hero(page), '22,00 €', 'лимит не изменился');
  assert.equal(await page.visible('.toast-error'), true);
  assert.match(await page.text('#toast'), /Не удалось сохранить/);
  assert.equal(await page.evaluate(`document.getElementById('add-amount').value`), '5', 'ввод не потерян');
  assert.equal((await stored(page)).transactions.length, 0);
});

await scenario('повреждённые данные не перезаписываются молча', async () => {
  const page = await freshPage('2026-11-01');
  await start(page);
  const broken = '{"version":1,"budgets":';
  await page.evaluate(`localStorage.setItem('${STORAGE_KEY}', ${JSON.stringify(broken)})`);
  await page.navigate(URL_APP);
  assert.ok(await page.visible('#corrupt-screen'));
  assert.equal(await page.evaluate(`localStorage.getItem('${STORAGE_KEY}')`), broken, 'данные не тронуты');
  await shot(page, '14-corrupt');
  await page.click('#corrupt-reset');
  await page.click('#confirm-yes');
  assert.ok(await page.visible('#onb-amount'));
  assert.equal(await page.evaluate(`localStorage.getItem('${STORAGE_KEY}')`), null);
  await noErrors(page);
});

await scenario('удаление всех данных требует подтверждения', async () => {
  const page = await freshPage('2026-11-01');
  await start(page);
  await addSpend(page, '5');
  await page.click('#tab-settings');
  await page.click('#btn-reset');
  await shot(page, '15-reset');
  await page.click('#confirm-no');
  assert.equal((await stored(page)).transactions.length, 1, 'отмена ничего не удаляет');
  await page.click('#btn-reset');
  await page.click('#confirm-yes');
  assert.ok(await page.visible('#onb-amount'));
  assert.equal(await page.evaluate(`document.getElementById('tabs').hidden`), true);
  await start(page, '100');
  assert.match(await hero(page), /^3,33/);
  await noErrors(page);
});

await scenario('дата телефона раньше начала учёта', async () => {
  const page = await freshPage('2026-11-05');
  await start(page);
  await setClock(page, '2026-10-20');
  await page.navigate(URL_APP);
  assert.ok(await page.visible('#date-notice'));
  assert.match(await page.text('#date-notice'), /раньше начала учёта/);
  assert.match(await page.text('#date-notice'), /с ноября 2026/);
  assert.equal(await wallet(page), '—');
  await shot(page, '16-before-start');
  await page.click('#wallet');
  await page.click('#sheet-close');
  await page.type('#add-amount', '1');
  await page.click('#add-submit');
  assert.match(await page.text('#add-form'), /Более ранние/);
  await page.click('#tab-month');
  assert.equal(await page.text('#month-title'), 'ноябрь 2026');
  await page.click('#tab-settings');
  assert.equal(await page.exists('#settings-budget'), false);
  assert.doesNotMatch(await page.text('#panel-settings'), /null|undefined/);
  await noErrors(page);
});

await scenario('напоминание о резервной копии через месяц', async () => {
  const page = await freshPage('2026-11-01');
  await start(page);
  await addSpend(page, '5');
  assert.equal(await page.exists('#backup-reminder'), false);
  await setClock(page, '2026-12-05');
  await page.navigate(URL_APP);
  assert.equal(await page.exists('#backup-reminder'), true);
  await shot(page, '17-reminder');
});

await scenario('форма записи видна над клавиатурой iPhone 15 Pro Max', async () => {
  const page = await freshPage('2026-11-02');
  await start(page);
  const hasSafeArea = await page.evaluate(`getComputedStyle(document.querySelector('.screen')).paddingTop !== '10px'`);
  const offset = hasSafeArea ? 0 : SAFE_TOP;
  const assertAboveKeyboard = async (label) => {
    const bottoms = await page.evaluate(`Object.fromEntries(['add-amount', 'add-submit', 'add-chips', 'add-note', 'add-date'].map((id) => [id, Math.round(document.getElementById(id).getBoundingClientRect().bottom)]))`);
    for (const [id, bottom] of Object.entries(bottoms)) {
      assert.ok(bottom + offset <= VISIBLE_WITH_KEYBOARD, `${label}: ${id} заканчивается на ${bottom + offset} pt при видимых ${VISIBLE_WITH_KEYBOARD} pt`);
    }
  };
  await assertAboveKeyboard('обычный лимит');
  await page.click('#add-submit');
  assert.match(await page.text('#add-form'), /Введи сумму/);
  assert.equal(await page.evaluate(`document.activeElement.id`), 'add-amount', 'при ошибке фокус на поле суммы');
  await addSpend(page, '100000');
  assert.match(await page.text('#hero-caption'), /Перерасход/);
  await assertAboveKeyboard('перерасход, подпись в две строки');
});

await scenario('ошибка даты видна над клавиатурой', async () => {
  const page = await freshPage('2026-11-05');
  await start(page);
  await page.type('#add-amount', '5');
  await page.setValue('#add-date', '2026-11-20');
  await page.click('#add-submit');
  const bottom = await page.evaluate(`document.querySelector('#add-form .field-error').getBoundingClientRect().bottom`);
  assert.match(await page.text('#add-form .field-error'), /будущем/);
  assert.ok(bottom <= VISIBLE_WITH_KEYBOARD, `сообщение заканчивается на ${bottom} pt`);
});

await scenario('сообщение поднимается над клавиатурой', async () => {
  const page = await freshPage('2026-11-05');
  await start(page);
  await page.evaluate(`
    Object.defineProperty(visualViewport, 'height', { get: () => ${VISIBLE_WITH_KEYBOARD}, configurable: true });
    visualViewport.dispatchEvent(new Event('resize'));
    Storage.prototype.setItem = function () { throw new DOMException('quota', 'QuotaExceededError'); };
  `);
  await page.type('#add-amount', '5');
  await page.click('#add-submit');
  assert.ok(await page.visible('.toast-error'));
  const bottom = await page.evaluate(`document.getElementById('toast').getBoundingClientRect().bottom`);
  assert.ok(bottom <= VISIBLE_WITH_KEYBOARD, `сообщение заканчивается на ${bottom} pt`);
});

await scenario('сообщение после записи не перекрывает кошелёк, число и форму', async () => {
  const page = await freshPage('2026-11-03');
  await start(page);
  await addSpend(page, '10');
  const overlaps = await page.evaluate(`(() => {
    const toast = document.getElementById('toast').getBoundingClientRect();
    return ['wallet', 'hero-amount', 'add-submit', 'add-amount', 'add-note']
      .filter((id) => {
        const r = document.getElementById(id).getBoundingClientRect();
        return r.left < toast.right && r.right > toast.left && r.top < toast.bottom && r.bottom > toast.top;
      });
  })()`);
  assert.deepEqual(overlaps, []);
  await page.click('#wallet');
  assert.equal(await page.evaluate(`document.getElementById('sheet').open`), true);
  assert.equal((await stored(page)).transactions.length, 1, 'нажатие на кошелёк не отменяет трату');
});

await scenario('ошибка записи видна в открытом листе, ввод не теряется', async () => {
  const page = await freshPage('2026-11-03');
  await start(page);
  await addSpend(page, '10');
  await page.click('#today-list .tx-row');
  await page.evaluate(`Storage.prototype.setItem = function () { throw new DOMException('quota', 'QuotaExceededError'); }`);
  await page.type('#edit-amount', '20');
  await page.click('#edit-save');
  assert.equal(await page.evaluate(`document.getElementById('sheet').open`), true);
  assert.match(await page.text('#sheet-alert'), /Не удалось сохранить/);
  const hit = await page.evaluate(`(() => {
    const r = document.getElementById('sheet-alert').getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.id;
  })()`);
  assert.equal(hit, 'sheet-alert', 'сообщение ничем не закрыто');
  assert.equal(await page.evaluate(`document.getElementById('edit-amount').value`), '20');
  assert.equal((await stored(page)).transactions[0].amount, 1000);
});

await scenario('сбой приложения виден поверх открытого листа', async () => {
  const page = await freshPage('2026-11-03');
  await start(page);
  await page.click('#wallet');
  await page.evaluate(`setTimeout(() => { throw new Error('проверка сбоя'); })`);
  await page.waitFor(`!document.getElementById('fatal').hidden`);
  assert.equal(await page.evaluate(`document.getElementById('sheet').open`), false);
  assert.match(await page.text('#fatal'), /проверка сбоя/);
  page.exceptions.length = 0;
});

await scenario('двойное нажатие на строку не удаляет трату', async () => {
  const page = await freshPage('2026-11-03');
  await start(page);
  for (let i = 0; i < 12; i += 1) await addSpend(page, String(i + 1));
  await page.click('#today-list .tx-row');
  const deleteY = await page.evaluate(`(() => { const r = document.getElementById('edit-delete').getBoundingClientRect(); return r.top + r.height / 2; })()`);
  await page.click('#sheet-close');
  await page.evaluate('new Promise((r) => setTimeout(r, 550))');
  await page.evaluate(`document.getElementById('toast').hidden = true`);
  // Прокручиваем так, чтобы одна из строк оказалась ровно под кнопкой удаления в листе.
  const point = await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('#today-list .tx-row')];
    const row = rows[Math.floor(rows.length / 2)];
    window.scrollBy(0, row.getBoundingClientRect().top + row.offsetHeight / 2 - ${deleteY});
    const r = row.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  assert.ok(Math.abs(point.y - deleteY) < 20, `строка на ${point.y}, кнопка на ${deleteY}`);
  for (let i = 0; i < 2; i += 1) {
    await page.send('Input.dispatchMouseEvent', { ...point, type: 'mousePressed', button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { ...point, type: 'mouseReleased', button: 'left', clickCount: 1 });
  }
  await page.evaluate('new Promise((r) => setTimeout(r, 30))');
  assert.equal(await page.evaluate(`document.getElementById('sheet').open`), true, 'лист открыт');
  assert.equal((await stored(page)).transactions.length, 12, 'все траты на месте');
});

await scenario('первый запуск после смены месяца и после полуночи', async () => {
  const page = await freshPage('2026-11-30');
  await page.type('#onb-amount', '660');
  assert.match(money(await page.text('#onb-preview')), /ноябрь 2026/);
  await page.evaluate(`window.__setNow(${noon('2026-12-01')}); document.dispatchEvent(new Event('visibilitychange'))`);
  assert.match(money(await page.text('#onb-preview')), /декабрь 2026/, 'подсказка обновилась');
  await page.click('#onb-submit');
  await page.waitFor(`Boolean(document.querySelector('#hero-amount'))`);
  assert.deepEqual((await stored(page)).budgets, { '2026-12': 66000 });
  assert.equal(await hero(page), '21,29 €');
  assert.equal(await wallet(page), '660,00 €');

  // Трата в первые секунды нового дня, когда поле даты ещё показывает вчера
  const midnight = await freshPage('2026-11-30');
  await start(midnight);
  await midnight.evaluate(`window.__setNow(${noon('2026-12-01')})`);
  await addSpend(midnight, '7');
  assert.equal((await stored(midnight)).transactions[0].date, '2026-12-01');
  assert.doesNotMatch(await midnight.text('#toast'), / за /);
  assert.match(await midnight.text('#today-list'), /Без категории/);
});

await scenario('долгий долг показан с годом', async () => {
  const page = await freshPage('2026-11-05');
  await start(page);
  await addSpend(page, '8000');
  assert.match(await page.text('#hero-caption'), /ноября 2027/);
});

await scenario('лист бюджета, сохранённый после смены месяца, не меняет новый месяц', async () => {
  const page = await freshPage('2026-11-30');
  await start(page);
  await page.click('#wallet');
  await page.click('#wallet-budget');
  await page.type('#budget-amount', '900');
  await setClock(page, '2026-12-01');
  await page.click('#budget-save');
  assert.deepEqual((await stored(page)).budgets, { '2026-11': 90000, '2026-12': 66000 });
});

await scenario('правку траты можно отменить', async () => {
  const page = await freshPage('2026-11-03');
  await start(page);
  await addSpend(page, '10');
  await page.click('#today-list .tx-row');
  await page.type('#edit-amount', '1000');
  await page.click('#edit-save');
  assert.equal(await hero(page), '−934,00 €');
  await page.click('#toast-action');
  assert.equal(await hero(page), '56,00 €');
});

await scenario('экспорт, завершившийся после удаления данных, ничего не записывает', async () => {
  const page = await freshPage('2026-11-03');
  await start(page);
  await page.evaluate(`
    navigator.canShare = () => true;
    navigator.share = () => new Promise((resolve) => { window.__finishShare = resolve; });
  `);
  await page.click('#tab-settings');
  await page.click('#btn-export');
  await page.click('#btn-reset');
  await page.click('#confirm-yes');
  assert.ok(await page.visible('#onb-amount'));
  await page.evaluate('window.__finishShare()');
  await page.evaluate('new Promise((r) => setTimeout(r, 50))');
  assert.equal(await page.evaluate(`localStorage.getItem('${STORAGE_KEY}')`), null);
  assert.equal(await page.visible('.toast-error'), false);
  await noErrors(page);
});

await scenario('импорт: будущая трата, странная дата копии, нечитаемый файл', async () => {
  const page = await freshPage('2026-11-03');
  await start(page);
  await page.click('#tab-settings');

  const future = {
    app: 'daily-budget',
    exportedAt: noon('2026-11-01'),
    data: {
      version: 1,
      budgets: { '2026-11': 66000 },
      categories: [],
      transactions: [{ id: 'f', date: '2026-11-20', amount: 500, categoryId: null, note: 'заранее', createdAt: 1 }],
      lastBackupAt: null,
    },
  };
  await importFile(page, JSON.stringify(future));
  await page.waitFor(`document.getElementById('sheet').open`);
  assert.match(await page.text('#sheet'), /С будущей датой: 1/);
  await page.click('#confirm-yes');
  await page.click('#tab-month');
  await page.click('#month-history .tx-row');
  await page.type('#edit-amount', '6');
  await page.click('#edit-save');
  assert.equal((await stored(page)).transactions[0].amount, 600, 'сумму будущей траты можно поправить');

  await page.click('#tab-settings');
  await importFile(page, JSON.stringify({ ...future, exportedAt: Number.MAX_SAFE_INTEGER }));
  await page.waitFor(`Boolean(document.querySelector('.toast-error'))`);
  assert.match(await page.text('#toast'), /дата создания/);

  await page.evaluate(`Blob.prototype.text = () => Promise.reject(new Error('нет доступа'))`);
  await importFile(page, 'что угодно');
  await page.waitFor(`document.getElementById('toast').textContent.includes('нет доступа')`);
  await noErrors(page);
});

await scenario('фокус не теряется', async () => {
  const page = await freshPage('2027-01-03');
  await start(page);
  await page.evaluate(`document.querySelector('.chip[data-id="c-food"]').focus()`);
  await page.click('.chip[data-id="c-food"]');
  assert.equal(await page.evaluate(`document.activeElement.dataset.id`), 'c-food', 'на категории');
  assert.equal(await page.text('.chip[aria-pressed="true"]'), 'Еда');

  await page.click('#wallet');
  assert.equal(await page.evaluate('document.activeElement.id'), 'sheet-title', 'на заголовке листа');
  await page.click('#wallet-budget');
  assert.equal(await page.evaluate('document.activeElement.id'), 'sheet-title', 'на заголовке следующего листа');
  await page.type('#budget-amount', '700');
  await page.click('#budget-save');
  assert.notEqual(await page.evaluate('document.activeElement.tagName'), 'BODY', 'после закрытия листа');

  await setClock(page, '2027-03-03');
  await page.navigate(URL_APP);
  await page.click('#tab-month');
  await page.evaluate(`document.getElementById('month-prev').focus()`);
  await page.click('#month-prev');
  assert.equal(await page.evaluate('document.activeElement.id'), 'month-prev', 'на листании');
  await page.click('#month-prev');
  assert.equal(await page.evaluate('document.activeElement.id'), 'month-title', 'кнопка стала недоступна');
});

await scenario('категория из одной буквы удобна для нажатия, кнопка добавления подписана', async () => {
  const page = await freshPage('2026-11-03');
  await start(page);
  await page.click('#chip-add');
  await page.type('#cat-name', 'Я');
  await page.click('#cat-save');
  await page.waitFor(`!document.getElementById('sheet').open`);
  const width = await page.evaluate(`document.querySelector('.chip[aria-pressed="true"]').getBoundingClientRect().width`);
  assert.ok(width >= 44, `ширина ${width}`);
  assert.equal(await page.evaluate(`document.getElementById('chip-add').getAttribute('aria-label')`), 'Новая категория');
});

await scenario('лист закрывается нажатием мимо него, и изменения не применяются', async () => {
  const page = await freshPage('2026-11-02');
  await start(page);
  await page.click('#wallet');
  await page.click('#wallet-budget');
  await page.type('#budget-amount', '900');
  const point = await page.evaluate(`(() => { const r = document.getElementById('sheet').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom + 40 }; })()`);
  await page.send('Input.dispatchMouseEvent', { ...point, type: 'mousePressed', button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { ...point, type: 'mouseReleased', button: 'left', clickCount: 1 });
  await page.waitFor(`!document.getElementById('sheet').open`);
  assert.deepEqual((await stored(page)).budgets, { '2026-11': 66000 });
});

await scenario('крупный системный размер текста: ничего не вылезает и не наезжает', async () => {
  for (const [width, rootSize] of [[430, 17], [430, 23], [430, 28], [430, 33], [430, 40], [430, 47], [430, 53], [320, 17], [320, 23]]) {
    const page = await freshPage('2026-11-02', { viewport: { width, height: 800, scale: 2 } });
    await page.evaluate(`document.documentElement.style.fontSize = '${rootSize}px'`);
    await start(page);
    await addSpend(page, '123,45', { note: 'Заметка', category: 'c-food' });
    for (const tab of ['today', 'month', 'settings']) {
      await page.click(`#tab-${tab}`);
      const overflow = await page.evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
      assert.ok(overflow <= 0, `${width} pt, текст ${rootSize} px, ${tab}: сдвиг вбок на ${overflow}px`);
      const outside = await page.evaluate(`[...document.querySelectorAll('#app button, #app input, #app .row-amount, #app .wallet-amount')]
        .filter((n) => n.type !== 'file' && n.getBoundingClientRect().width > 0)
        .filter((n) => { const r = n.getBoundingClientRect(); return r.right > ${width} + 0.5 || r.left < -0.5; })
        .filter((n) => !n.closest('.chips'))
        .map((n) => n.id || n.className)`);
      assert.deepEqual(outside, [], `${width} pt, текст ${rootSize} px, ${tab}`);
    }
    await page.click('#btn-reset'); // последняя кнопка настроек не под панелью вкладок
    await page.click('#confirm-no');
    await page.click('#tab-today');

    const context = `${width} pt, текст ${rootSize} px`;
    const unobstructed = await page.evaluate(`['add-amount', 'add-note', 'add-date', 'add-submit'].filter((id) => {
      const node = document.getElementById(id);
      node.scrollIntoView({ block: 'center' });
      const r = node.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit !== node && !node.contains(hit);
    })`);
    assert.deepEqual(unobstructed, [], `${context}: закрытые поля`);
    await page.setValue('#add-amount', '123,45');
    const amount = await page.evaluate(`(() => { const n = document.getElementById('add-amount'); return { client: n.clientWidth, scroll: n.scrollWidth }; })()`);
    assert.ok(amount.scroll <= amount.client, `${context}: сумма обрезана (${amount.scroll} > ${amount.client})`);
    await page.setValue('#add-amount', '');
    if (width === 430 && rootSize === 33) await shot(page, '20-large-text');
    if (width === 430 && rootSize === 53) await shot(page, '21-largest-text');
    await noErrors(page);
  }
});

await scenario('вёрстка: нет сдвига вбок, кнопки не меньше 44 pt, большие суммы влезают', async () => {
  for (const [width, height] of [[320, 568], [375, 667], [393, 852], [430, 932], [932, 430]]) {
    const page = await freshPage('2026-11-30', { viewport: { width, height, scale: 2 } });
    await start(page, '99999999');
    await addSpend(page, '1234567,89', { note: 'Очень длинная заметка '.repeat(8).slice(0, 200), category: 'c-small' });
    for (const tab of ['today', 'month', 'settings']) {
      await page.click(`#tab-${tab}`);
      const overflow = await page.evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
      assert.ok(overflow <= 0, `${width}×${height}, ${tab}: сдвиг вбок на ${overflow}px`);
      const small = await page.evaluate(`[...document.querySelectorAll('button, input, select')]
        .filter((n) => n.type !== 'file' && n.getBoundingClientRect().width > 0)
        .map((n) => { const r = n.getBoundingClientRect(); return { id: n.id || n.className || n.tagName, w: Math.round(r.width), h: Math.round(r.height) }; })
        .filter((r) => r.w < 44 || r.h < 44)`);
      assert.deepEqual(small, [], `${width}×${height}, ${tab}: мелкие кнопки`);
    }
    await page.click('#tab-today');
    const clipped = await page.evaluate(`(() => {
      const box = document.getElementById('hero-amount').getBoundingClientRect();
      const inner = [...document.querySelectorAll('#hero-amount span')].map((n) => n.getBoundingClientRect());
      return inner.filter((r) => r.right > box.right + 0.5 || r.left < box.left - 0.5).length;
    })()`);
    assert.equal(clipped, 0, `${width}×${height}: число не помещается`);
    if (width === 320) await shot(page, '18-narrow-big');
    await noErrors(page);
  }
});

await scenario('приложение работает из подпапки хостинга', async () => {
  const nested = await startServer(0, () => {}, '/budget');
  const base = `http://localhost:${nested.address().port}/budget/`;
  const page = await browser.newPage({ init: `${FAKE_CLOCK}\n${INSTALLED}` });
  await page.viewport();
  await page.navigate(base);
  await setClock(page, '2026-11-01');
  await page.navigate(base);
  await start(page);
  assert.equal(await hero(page), '22,00 €');
  await page.waitFor(`navigator.serviceWorker.ready.then((r) => r.scope.endsWith('/budget/'))`);
  await page.waitFor(`caches.keys().then(async (names) => { const c = await caches.open(names.find((n) => n.startsWith('daily-budget-%2Fbudget%2F-'))); return (await c.keys()).length === ${Object.keys(fileHashes()).length}; })`);
  await page.navigate(base);
  await noErrors(page);
  assert.notEqual(await page.evaluate(`localStorage.getItem('${STORAGE_KEY}:/budget/')`), null, 'данные копии в подпапке отдельно');
  nested.closeAllConnections();
  nested.close();
});

await scenario('подсказка установки только на iPhone вне установленного приложения', async () => {
  const page = await browser.newPage({ init: FAKE_CLOCK });
  await page.viewport();
  await page.send('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA });
  await page.navigate(URL_APP);
  assert.ok(await page.visible('#install-notice'), 'на первом экране');
  await shot(page, '19-install-notice');
  await page.evaluate(`window.__setNow(${noon('2026-11-01')})`);
  await page.navigate(URL_APP);
  await start(page);
  assert.ok(await page.visible('#install-notice'), 'на главном экране');

  const installed = await browser.newPage({
    init: `${FAKE_CLOCK}\n${INSTALLED}`,
  });
  await installed.viewport();
  await installed.send('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA });
  await installed.navigate(URL_APP);
  assert.equal(await installed.exists('#install-notice'), false);
});

await scenario('обновление: новая версия приходит на телефон, данные и чужие кэши целы', async () => {
  const root = mkdtempSync(join(process.env.E2E_TMP ?? tmpdir(), 'site-'));
  cpSync(DOCS_DIR, root, { recursive: true });
  const site = await startServer(0, () => {}, '', root);
  const base = `http://localhost:${site.address().port}/`;
  try {
    const page = await browser.newPage({ init: `${FAKE_CLOCK}\n${INSTALLED}` });
    await page.viewport();
    await page.navigate(base);
    await setClock(page, '2026-11-01');
    await page.navigate(base);
    await start(page);
    await addSpend(page, '3');
    await page.waitFor(`navigator.serviceWorker.ready.then(() => Boolean(navigator.serviceWorker.controller))`);
    await page.waitFor(`caches.keys().then((names) => names.some((n) => n.startsWith('daily-budget-')))`);
    await page.evaluate(`caches.open('other-project-v1')`);
    await page.navigate(base); // теперь страницей управляет service worker старой версии
    const [oldCache] = await page.evaluate(`caches.keys().then((names) => names.filter((n) => n.startsWith('daily-budget-')))`);

    // Выкладываем новую версию: другой файл и другая версия в sw.js
    const indexPath = join(root, 'index.html');
    const nextIndex = readFileSync(indexPath, 'utf8').replace('</head>', '<meta name="release" content="next"></head>');
    writeFileSync(indexPath, nextIndex);
    const swPath = join(root, 'sw.js');
    writeFileSync(swPath, readFileSync(swPath, 'utf8')
      .replace(/const VERSION = '[^']*';/, `const VERSION = 'next-version';`)
      .replace(/'\.\/index\.html': '[0-9a-f]+'/, `'./index.html': '${createHash('sha256').update(nextIndex).digest('hex')}'`));

    assert.equal(await page.exists('meta[name="release"]'), false);
    await page.evaluate(`navigator.serviceWorker.getRegistration().then((r) => r.update())`);
    await page.waitFor(`Boolean(document.getElementById('update-reload'))`, 8000);
    assert.equal(await hero(page), '19,00 €', 'открытый экран продолжает работать');
    await addSpend(page, '1');
    assert.equal(await page.exists('#update-reload'), true, 'предложение обновиться не исчезает после записи');
    await page.click('#toast-action'); // отменяем эту запись

    await page.waitFor(`caches.keys().then((names) => names.includes('daily-budget-%2F-next-version') && !names.includes(${JSON.stringify(oldCache)}))`);
    const names = await page.evaluate(`caches.keys()`);
    assert.ok(names.includes('other-project-v1'), 'чужой кэш не удалён');

    const reloaded = page.evaluate(`new Promise((r) => { addEventListener('pagehide', () => r(true)); })`).catch(() => true);
    await page.click('#update-reload');
    await reloaded;
    await new Promise((resolve) => setTimeout(resolve, 200));
    await page.waitFor(`Boolean(document.getElementById('hero-amount'))`);
    assert.equal(await page.exists('meta[name="release"]'), true, 'загружена новая версия');
    assert.equal(await hero(page), '19,00 €', 'данные на месте');
    await noErrors(page);
  } finally {
    site.closeAllConnections();
    site.close();
    rmSync(root, { recursive: true, force: true });
  }
});

await scenario('несогласованные файлы на хостинге: обновление не ставится, приложение работает', async () => {
  const root = mkdtempSync(join(process.env.E2E_TMP ?? tmpdir(), 'site-'));
  cpSync(DOCS_DIR, root, { recursive: true });
  const site = await startServer(0, () => {}, '', root);
  const base = `http://localhost:${site.address().port}/`;
  try {
    const page = await browser.newPage({ init: `${FAKE_CLOCK}\n${INSTALLED}` });
    await page.viewport();
    await page.navigate(base);
    await setClock(page, '2026-11-01');
    await page.navigate(base);
    await start(page);
    await page.waitFor(`navigator.serviceWorker.ready.then(() => Boolean(navigator.serviceWorker.controller))`);
    await page.waitFor(`caches.keys().then((names) => names.some((n) => n.startsWith('daily-budget-')))`);
    await page.navigate(base);
    const before = await page.evaluate(`caches.keys()`);

    // Новый sw.js с новыми контрольными суммами, а core.js на хостинге ещё старый.
    const swPath = join(root, 'sw.js');
    writeFileSync(swPath, readFileSync(swPath, 'utf8')
      .replace(/const VERSION = '[^']*';/, `const VERSION = 'mixed-version';`)
      .replace(/'\.\/core\.js': '[0-9a-f]+'/, `'./core.js': '${'0'.repeat(64)}'`));
    await page.evaluate(`navigator.serviceWorker.getRegistration().then((r) => r.update()).catch(() => {})`);
    await page.evaluate('new Promise((r) => setTimeout(r, 400))');
    assert.deepEqual(await page.evaluate(`caches.keys()`).then((names) => names.filter((n) => !n.includes('mixed-version'))), before, 'прошлая версия цела');
    assert.equal(await page.exists('#update-reload'), false, 'обновление не предлагается');

    for (let i = 0; i < 3; i += 1) {
      await page.navigate(base);
      assert.equal(await hero(page), '22,00 €', `запуск ${i + 1}`);
    }
    await noErrors(page);
  } finally {
    site.closeAllConnections();
    site.close();
    rmSync(root, { recursive: true, force: true });
  }
});

await scenario('хостинг с редиректом index.html: приложение открывается и работает офлайн', async () => {
  const redirecting = await startServer(0, (request, response) => {
    if (request.url === '/index.html') response.writeHead(308, { location: '/' }).end();
  });
  const base = `http://localhost:${redirecting.address().port}/`;
  const page = await browser.newPage({ init: `${FAKE_CLOCK}\n${INSTALLED}` });
  await page.viewport();
  await page.navigate(base);
  await setClock(page, '2026-11-01');
  await page.navigate(base);
  await start(page);
  await page.waitFor(`navigator.serviceWorker.ready.then(() => Boolean(navigator.serviceWorker.controller))`);
  await page.waitFor(`caches.keys().then((names) => names.some((n) => n.startsWith('daily-budget-')))`);
  await page.navigate(base);
  await page.navigate(base);
  assert.equal(await hero(page), '22,00 €', 'повторный запуск');
  redirecting.closeAllConnections();
  await new Promise((resolve) => redirecting.close(resolve));
  await page.navigate(base);
  assert.equal(await hero(page), '22,00 €', 'без сети');
  await noErrors(page);
});

await scenario('приложение не запустилось: экран восстановления, данные целы', async () => {
  const root = mkdtempSync(join(process.env.E2E_TMP ?? tmpdir(), 'site-'));
  cpSync(DOCS_DIR, root, { recursive: true });
  const site = await startServer(0, () => {}, '', root);
  const base = `http://localhost:${site.address().port}/`;
  try {
    const page = await browser.newPage({ init: INSTALLED });
    await page.viewport();
    await page.navigate(base);
    await page.type('#onb-amount', '660');
    await page.click('#onb-submit');
    await page.waitFor(`Boolean(document.querySelector('#hero-amount'))`);
    await page.waitFor(`navigator.serviceWorker.ready.then(() => Boolean(navigator.serviceWorker.controller))`);
    const data = await page.evaluate(`localStorage.getItem('${STORAGE_KEY}')`);

    // Убираем service worker и ломаем файл на хостинге: так выглядит любая битая загрузка.
    await page.evaluate(`(async () => {
      for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
      for (const n of await caches.keys()) await caches.delete(n);
    })()`);
    const corePath = join(root, 'core.js');
    const goodCore = readFileSync(corePath);
    writeFileSync(corePath, '<!doctype html><title>Ошибка хостинга</title>');
    await page.navigate(base);
    await page.waitFor(`!document.getElementById('start-failure').hidden`);
    assert.equal(await page.evaluate(`document.getElementById('app').childElementCount`), 0);
    assert.equal(await page.evaluate(`localStorage.getItem('${STORAGE_KEY}')`), data, 'данные не тронуты');
    await shot(page, '22-start-failure');

    writeFileSync(corePath, goodCore);
    // Нажатие перезагружает страницу, поэтому запрос к ней может оборваться.
    await page.click('#start-reload').catch((error) => assert.match(error.message, /navigated|closed|context/i));
    await new Promise((resolve) => setTimeout(resolve, 400));
    await page.waitFor(`Boolean(document.querySelector('#hero-amount'))`, 8000);
    assert.equal(await page.evaluate(`localStorage.getItem('${STORAGE_KEY}')`), data);
    assert.equal(await page.visible('#start-failure'), false);
  } finally {
    site.closeAllConnections();
    site.close();
    rmSync(root, { recursive: true, force: true });
  }
});

await scenario('неудавшаяся установка: приложение честно предупреждает', async () => {
  const root = mkdtempSync(join(process.env.E2E_TMP ?? tmpdir(), 'site-'));
  cpSync(DOCS_DIR, root, { recursive: true });
  rmSync(join(root, 'icons', 'icon-512.png'));
  const site = await startServer(0, () => {}, '', root);
  const base = `http://localhost:${site.address().port}/`;
  try {
    const page = await browser.newPage({ init: INSTALLED });
    await page.viewport();
    await page.navigate(base);
    await page.type('#onb-amount', '660');
    await page.click('#onb-submit');
    await page.waitFor(`Boolean(document.querySelector('#offline-problem'))`, 8000);
    await page.click('#tab-settings');
    await page.waitFor(`document.getElementById('about-status').textContent.includes('не настроена')`);
    page.consoleErrors.length = 0;
    await noErrors(page);
  } finally {
    site.closeAllConnections();
    site.close();
    rmSync(root, { recursive: true, force: true });
  }
});

await scenario('очищенный кэш восстанавливается при запуске с интернетом', async () => {
  const page = await freshPage('2026-11-01');
  await start(page);
  await page.waitFor(`navigator.serviceWorker.ready.then(() => Boolean(navigator.serviceWorker.controller))`);
  await page.waitFor(`caches.keys().then((names) => names.some((n) => n.startsWith('daily-budget-')))`);
  await page.evaluate(`(async () => { for (const n of await caches.keys()) await caches.delete(n); })()`);
  await page.click('#tab-settings');
  await page.waitFor(`document.getElementById('about-status').textContent.includes('ещё настраивается')`);
  await page.navigate(URL_APP);
  assert.equal(await hero(page), '22,00 €');
  await page.waitFor(`caches.keys().then(async (names) => {
    const name = names.find((n) => n.startsWith('daily-budget-'));
    return Boolean(name) && Boolean(await (await caches.open(name)).match('index.html'));
  })`);
  await noErrors(page);
});

await scenario('приложение в корне домена не подменяет чужие страницы', async () => {
  const page = await freshPage('2026-11-01');
  await start(page);
  await page.waitFor(`navigator.serviceWorker.ready.then(() => Boolean(navigator.serviceWorker.controller))`);
  await page.navigate(URL_APP);
  for (const path of ['other/', 'foo/bar']) {
    // Сервер отвечает 404 без содержимого, поэтому браузер сообщает об ошибке перехода: страница не подменена.
    const { errorText } = await page.send('Page.navigate', { url: `${URL_APP}${path}` });
    await page.evaluate('new Promise((r) => setTimeout(r, 150))');
    assert.ok(errorText || (await page.evaluate('document.title')) !== 'Бюджет', path);
    assert.equal(await page.exists('#add-form'), false, path);
  }
  await page.navigate(`${URL_APP}index.html`);
  assert.equal(await page.evaluate('document.title'), 'Бюджет');
});

await scenario('категория с невидимым символом внутри буквы не ломает запуск и копию', async () => {
  const page = await freshPage('2026-11-03');
  await start(page);
  await page.click('#chip-add');
  await page.type('#cat-name', 'Чаи­̆');
  await page.click('#cat-save');
  await page.waitFor(`!document.getElementById('sheet').open`);
  await page.navigate(URL_APP);
  assert.equal(await page.exists('#corrupt-screen'), false, 'данные читаются после перезапуска');
  assert.ok((await page.text('#add-chips')).includes('Чай'));
  await noErrors(page);
});

await scenario('приложение не записывает то, что не сможет прочитать', async () => {
  const page = await freshPage('2026-11-03');
  await start(page);
  await addSpend(page, '1');
  await page.click('#tab-settings');
  const before = await page.evaluate(`localStorage.getItem('${STORAGE_KEY}')`);
  // Часы телефона ушли за допустимые годы: время создания траты не прошло бы проверку при следующем запуске.
  await page.evaluate(`window.__setNow(new Date(2150, 0, 15, 12).getTime())`);
  await page.click('#tab-today');
  await page.type('#add-amount', '5');
  await page.setValue('#add-date', '2026-11-02');
  await page.click('#add-submit');
  assert.equal(await page.evaluate(`localStorage.getItem('${STORAGE_KEY}')`), before, 'недействительные данные не записаны');
  assert.match(await page.text('#toast'), /не записано/);
  assert.equal(await page.evaluate(`document.getElementById('add-amount').value`), '5', 'ввод не потерян');
  await page.navigate(URL_APP);
  assert.equal(await page.exists('#corrupt-screen'), false);
});

await scenario('двойное касание не срабатывает на том, что появилось под пальцем после закрытия листа', async () => {
  const page = await freshPage('2026-11-03');
  await start(page);
  await addSpend(page, '10');
  await page.evaluate('new Promise((r) => setTimeout(r, 550))');
  const doubleTap = async (selector) => {
    const point = await page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    for (let i = 0; i < 2; i += 1) {
      await page.send('Input.dispatchMouseEvent', { ...point, type: 'mousePressed', button: 'left', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { ...point, type: 'mouseReleased', button: 'left', clickCount: 1 });
    }
    await page.evaluate('new Promise((r) => setTimeout(r, 30))');
  };

  // Крестик лежит над кнопкой кошелька: лист не должен открыться снова.
  await page.click('#wallet');
  await page.evaluate('new Promise((r) => setTimeout(r, 550))');
  await doubleTap('#sheet-close');
  assert.equal(await page.evaluate(`document.getElementById('sheet').open`), false, 'лист закрыт');

  // Второе касание по «Удалить» не должно попасть в появившееся «Отменить».
  await page.evaluate('new Promise((r) => setTimeout(r, 550))');
  await page.click('#today-list .tx-row');
  await page.evaluate('new Promise((r) => setTimeout(r, 550))');
  // Ставим уведомление ровно туда, где палец: так бывает при открытой клавиатуре.
  const point = await page.evaluate(`(() => {
    const r = document.getElementById('edit-delete').getBoundingClientRect();
    const y = r.top + r.height / 2;
    document.documentElement.style.setProperty('--keyboard-inset', (innerHeight - y - 8 - 26) + 'px');
    return { x: r.right - 40, y };
  })()`);
  for (let i = 0; i < 2; i += 1) {
    await page.send('Input.dispatchMouseEvent', { ...point, type: 'mousePressed', button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { ...point, type: 'mouseReleased', button: 'left', clickCount: 1 });
    if (i === 0) {
      const under = await page.evaluate(`document.elementFromPoint(${point.x}, ${point.y})?.id`);
      assert.equal(under, 'toast-action', 'под пальцем оказалась кнопка отмены');
    }
  }
  await page.evaluate('new Promise((r) => setTimeout(r, 30))');
  assert.equal((await stored(page)).transactions.length, 0, 'трата удалена, второе касание её не вернуло');
  await page.evaluate('new Promise((r) => setTimeout(r, 550))');
  await page.click('#toast-action');
  assert.equal((await stored(page)).transactions.length, 1, 'обычное нажатие «Отменить» работает');
});

await scenario('кнопка восстановления без связи с хостингом ничего не удаляет', async () => {
  const site = await startServer(0);
  const base = `http://localhost:${site.address().port}/`;
  const page = await browser.newPage({ init: INSTALLED });
  await page.viewport();
  await page.navigate(base);
  await page.waitFor(`navigator.serviceWorker.ready.then(() => Boolean(navigator.serviceWorker.controller))`);
  await page.waitFor(`caches.keys().then((names) => names.some((n) => n.startsWith('daily-budget-')))`);
  site.closeAllConnections();
  await new Promise((resolve) => site.close(resolve));
  await page.evaluate(`document.getElementById('start-failure').hidden = false`);
  await page.click('#start-reload');
  await page.waitFor(`document.getElementById('start-failure-note').textContent.includes('Не удалось связаться')`);
  assert.equal(await page.evaluate(`navigator.serviceWorker.getRegistrations().then((list) => list.length)`), 1, 'регистрация цела');
  assert.equal(await page.evaluate(`caches.keys().then((names) => names.filter((n) => n.startsWith('daily-budget-')).length)`), 1, 'кэш цел');
  assert.equal(await page.evaluate(`document.getElementById('start-reload').disabled`), false, 'можно нажать ещё раз');
});

await scenario('кэш без одного файла чинится, а статус не обещает офлайн заранее', async () => {
  const page = await freshPage('2026-11-01');
  await start(page);
  await page.waitFor(`navigator.serviceWorker.ready.then(() => Boolean(navigator.serviceWorker.controller))`);
  await page.waitFor(`caches.keys().then((names) => names.some((n) => n.startsWith('daily-budget-')))`);
  const name = `(await caches.keys()).find((n) => n.startsWith('daily-budget-'))`;
  await page.evaluate(`(async () => { const c = await caches.open(${name}); await c.delete('core.js'); })()`);
  await page.click('#tab-settings');
  await page.waitFor(`document.getElementById('about-status').textContent.includes('ещё настраивается')`);
  await page.navigate(URL_APP);
  await page.waitFor(`(async () => Boolean(await (await caches.open(${name})).match('core.js')))()`);
  await noErrors(page);
});

await scenario('новая версия в сеансе первой установки тоже предлагает обновиться', async () => {
  const page = await freshPage('2026-11-01');
  await page.waitFor(`navigator.serviceWorker.ready.then(() => Boolean(navigator.serviceWorker.controller))`);
  await start(page);
  assert.equal(await page.exists('#update-reload'), false, 'первая установка не считается обновлением');
  await page.evaluate(`navigator.serviceWorker.dispatchEvent(new Event('controllerchange'))`);
  await page.waitFor(`Boolean(document.getElementById('update-reload'))`);
});

await scenario('кнопка восстановления: сломанный sw.js при живом сайте и зависшая связь', async () => {
  const root = mkdtempSync(join(process.env.E2E_TMP ?? tmpdir(), 'site-'));
  cpSync(DOCS_DIR, root, { recursive: true });
  let breakWorker = false;
  let hangProbe = false;
  const site = await startServer(0, (request, response) => {
    if (breakWorker && request.url === '/sw.js') response.writeHead(503).end();
    if (hangProbe && request.url.includes('probe=')) response.writeHead(200, { 'content-type': 'image/png' }); // ответ начат и не заканчивается
  }, '', root);
  const base = `http://localhost:${site.address().port}/`;
  try {
    const page = await browser.newPage({ init: INSTALLED });
    await page.viewport();
    await page.navigate(base);
    await page.type('#onb-amount', '660');
    await page.click('#onb-submit');
    await page.waitFor(`navigator.serviceWorker.ready.then(() => Boolean(navigator.serviceWorker.controller))`);
    await page.waitFor(`caches.keys().then((names) => names.some((n) => n.startsWith('daily-budget-')))`);
    const data = await page.evaluate(`localStorage.getItem('${STORAGE_KEY}')`);

    hangProbe = true;
    await page.evaluate(`document.getElementById('start-failure').hidden = false`);
    await page.click('#start-reload');
    assert.match(await page.text('#start-failure-note'), /Проверяю связь/, 'кнопка не молчит');
    await page.waitFor(`document.getElementById('start-failure-note').textContent.includes('Не удалось связаться')`, 12000);
    assert.equal(await page.evaluate(`document.getElementById('start-reload').disabled`), false, 'проверка ограничена по времени');

    hangProbe = false;
    breakWorker = true;
    await page.evaluate('window.__beforeReload = true');
    await page.click('#start-reload').catch((error) => assert.match(error.message, /navigated|closed|context/i));
    // Страница перезагружается: запросы к ней могут обрываться, пока она не откроется заново.
    const deadline = Date.now() + 10000;
    let recovered = false;
    while (!recovered && Date.now() < deadline) {
      recovered = await page.evaluate(`!window.__beforeReload && Boolean(document.querySelector('#hero-amount'))`).catch(() => false);
      if (!recovered) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(recovered, 'приложение поднялось с рабочих файлов сервера');
    assert.equal(await page.evaluate(`localStorage.getItem('${STORAGE_KEY}')`), data, 'данные на месте');
  } finally {
    site.closeAllConnections();
    site.close();
    rmSync(root, { recursive: true, force: true });
  }
});

await scenario('повторное нажатие «Сохранить» при открытом меню не даёт ложной ошибки', async () => {
  const page = await freshPage('2026-11-03');
  await start(page);
  await page.evaluate(`
    navigator.canShare = () => true;
    window.__shares = 0;
    navigator.share = () => {
      window.__shares += 1;
      if (window.__shares > 1) return Promise.reject(new DOMException('An earlier share has not yet completed.', 'InvalidStateError'));
      return new Promise((resolve) => { window.__finishShare = resolve; });
    };
  `);
  await page.click('#tab-settings');
  await page.click('#btn-export');
  await page.evaluate('new Promise((r) => setTimeout(r, 550))');
  await page.click('#btn-export');
  await page.evaluate('new Promise((r) => setTimeout(r, 30))');
  assert.equal(await page.evaluate('window.__shares'), 1);
  assert.equal(await page.exists('.toast-error'), false);
  await page.evaluate('window.__finishShare()');
  await page.waitFor(`document.getElementById('toast').textContent.includes('Резервная копия создана')`);
});

await scenario('статус офлайна обновляется на открытом экране', async () => {
  const page = await freshPage('2026-11-03');
  await start(page);
  await page.waitFor(`navigator.serviceWorker.ready.then(() => Boolean(navigator.serviceWorker.controller))`);
  await page.click('#tab-settings');
  await page.evaluate(`document.getElementById('about-status').textContent = 'старый текст'`);
  await page.evaluate(`navigator.serviceWorker.dispatchEvent(new Event('controllerchange'))`);
  await page.waitFor(`document.getElementById('about-status').textContent.includes('Работа без интернета')`);
});

await scenario('часы телефона до 2000 года: обычное сообщение, а не сбой', async () => {
  const page = await freshPage('2026-11-03');
  await page.evaluate(`window.__setNow(new Date(1995, 0, 15, 12).getTime())`);
  await page.type('#onb-amount', '6');
  assert.equal(await page.visible('#fatal'), false);
  await page.click('#onb-submit');
  assert.match(await page.text('#onb-form'), /неверная дата/);
  await noErrors(page);
});

// ---------- Итог ----------

await browser.close();
server.closeAllConnections();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} из ${results.length} сценариев прошли.`);
process.exit(failed.length === 0 ? 0 : 1);
