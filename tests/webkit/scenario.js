// Сценарий внутри WebKit: настоящий движок, настоящая вёрстка. Возвращает JSON-строку с результатами.
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail: String(detail) });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const $ = (selector) => document.querySelector(selector);
const money = (text) => (text ?? '').replace(/ /g, ' ');
const setValue = (selector, value) => {
  const node = $(selector);
  node.value = value;
  node.dispatchEvent(new Event('input', { bubbles: true }));
  node.dispatchEvent(new Event('change', { bubbles: true }));
};

const errors = [];
window.addEventListener('error', (event) => errors.push(event.message));
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));
const violations = [];
document.addEventListener('securitypolicyviolation', (event) => violations.push(`${event.violatedDirective}: ${event.blockedURI}`));

for (let i = 0; i < 100 && !$('#onb-amount') && !$('#hero-amount'); i += 1) await wait(50);
check('приложение запустилось (модули, стили, boot.js)', $('#onb-amount'), document.body.innerText.slice(0, 200));
check('экран сбоя запуска скрыт', $('#start-failure').hidden);
check('стили применились', getComputedStyle(document.body).backgroundColor === 'rgb(11, 13, 12)', getComputedStyle(document.body).backgroundColor);
check('браузер — WebKit', /AppleWebKit/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent), navigator.userAgent);

const today = new Date();
const dayNumber = today.getDate();
const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();

setValue('#onb-amount', '660');
check('подсказка на первом экране', money($('#onb-preview').textContent).includes('в день'));
$('#onb-submit').click();
await wait(50);
// По умолчанию учёт идёт с сегодняшнего дня, поэтому в первый день доступна одна доля.
const expected = Math.round(66000 / (daysInMonth - dayNumber + 1));
const shown = (cents) => `${String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${String(cents % 100).padStart(2, '0')} €`;
check('лимит посчитан', money($('#hero-amount').textContent) === shown(expected), money($('#hero-amount').textContent));

setValue('#add-amount', '12,50');
$('#add-category').click();
await wait(50);
check('список категорий открылся', $('#sheet').open && $('.picker-row[data-id="c-food"]'));
$('.picker-row[data-id="c-food"]').click();
await wait(50);
check('категория выбрана', $('#add-category-value').textContent === 'Еда');
setValue('#add-note', '<img src=x onerror="window.__xss=1">');
$('#add-submit').click();
await wait(50);
check('трата записана', money($('#hero-amount').textContent) === shown(expected - 1250), money($('#hero-amount').textContent));
check('заметка осталась текстом', $('#today-list').textContent.includes('<img') && !window.__xss && !$('#today-list img'));
check('сообщение об отмене показано', $('#toast-action')?.textContent === 'Отменить');

const stored = JSON.parse(localStorage.getItem('daily-budget.state.v1'));
check('данные сохранены', stored.transactions.length === 1 && stored.transactions[0].amount === 1250 && stored.version === 2);

// Лист поверх экрана: <dialog>
$('#wallet').click();
await wait(250);
check('кошелёк открылся (dialog)', $('#sheet').open && $('#wallet-sheet-today'));
check('фокус на заголовке, клавиатура не выезжает', document.activeElement?.id === 'sheet-title', document.activeElement?.id);
const sheetRect = $('#sheet').getBoundingClientRect();
check('лист в пределах экрана', sheetRect.left >= 0 && sheetRect.right <= innerWidth && sheetRect.top >= 0, JSON.stringify(sheetRect));
$('#sheet-close').click();
await wait(50);
check('кошелёк закрылся', !$('#sheet').open);

// Защита от неверного ввода и категории с невидимыми символами (регулярные выражения Unicode)
$('#add-category').click();
await wait(50);
$('#picker-new').click();
await wait(50);
setValue('#cat-name', '​‮');
$('#cat-save').click();
await wait(30);
check('невидимое имя категории отклонено', $('#sheet').open && $('#sheet').textContent.includes('Введи название'));
setValue('#cat-name', 'Кафе');
$('#cat-save').click();
await wait(50);
check('категория создана', !$('#sheet').open && $('#add-category-value').textContent === 'Кафе');

// Поле даты в WebKit
const date = $('#add-date');
check('поле даты с сегодняшним значением', /^\d{4}-\d{2}-\d{2}$/.test(date.value), date.value);
const dateRect = date.getBoundingClientRect();
const formRect = $('#add-form').getBoundingClientRect();
check('поле даты не вылезает за форму', dateRect.right <= formRect.right && dateRect.left >= formRect.left, `${dateRect.left}..${dateRect.right} / ${formRect.left}..${formRect.right}`);
check('поле даты высотой от 44', dateRect.height >= 44, dateRect.height);

// Кольцо расходов
$('#tab-month').click();
await wait(30);
const ringSegment = document.querySelector('#month-ring .ring-segment');
check('кольцо нарисовано', ringSegment && getComputedStyle(ringSegment).stroke !== 'none', ringSegment && getComputedStyle(ringSegment).stroke);
const ringBox = $('#month-ring')?.getBoundingClientRect();
check('кольцо в пределах экрана', ringBox && ringBox.width > 100 && ringBox.right <= innerWidth, JSON.stringify(ringBox));
$('#tab-today').click();
await wait(30);

// Вёрстка на всех вкладках
for (const tab of ['today', 'month', 'settings']) {
  $(`#tab-${tab}`).click();
  await wait(30);
  const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  check(`вкладка ${tab}: нет сдвига вбок`, overflow <= 0, overflow);
}
$('#tab-today').click();
await wait(30);

// Политика безопасности в WebKit
const blocked = await fetch('https://example.com/').then(() => false, () => true);
check('внешний запрос заблокирован', blocked);
await wait(50);
check('политика безопасности работает', violations.some((v) => v.startsWith('connect-src')), violations.join('; '));
let evalBlocked = false;
try { eval('1'); } catch { evalBlocked = true; }
check('выполнение строк как кода запрещено', evalBlocked);
const violationsFromApp = violations.filter((v) => !v.includes('example.com') && !v.startsWith('script-src'));
check('приложение само не нарушает политику', violationsFromApp.length === 0, violationsFromApp.join('; '));

// Работа без интернета в WebKit: контрольные суммы (crypto.subtle), кэш, service worker
let serviceWorkerState = 'нет поддержки';
if ('serviceWorker' in navigator) {
  const registration = await Promise.race([navigator.serviceWorker.ready, wait(15000).then(() => null)]);
  serviceWorkerState = registration ? 'активен' : 'не дождался';
  for (let i = 0; i < 100 && !navigator.serviceWorker.controller; i += 1) await wait(50);
  check('service worker установился и управляет страницей', registration && navigator.serviceWorker.controller, serviceWorkerState);
  const names = await caches.keys();
  const name = names.find((n) => n.startsWith('daily-budget-'));
  check('файлы проверены по контрольным суммам и сохранены', name, names.join(', '));
  if (name) {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    check('в кэше все файлы приложения', keys.length === 11, keys.length);
    const page = await cache.match('index.html');
    check('страница в кэше без признака редиректа', page && !page.redirected && page.status === 200);
  }
}

check('необработанных ошибок нет', errors.length === 0, errors.join('; '));
check('баннера сбоя нет', $('#fatal').hidden);

const support = {
  serviceWorker: 'serviceWorker' in navigator,
  caches: 'caches' in window,
  share: 'share' in navigator,
  canShare: 'canShare' in navigator,
  persist: Boolean(navigator.storage?.persist),
  visualViewport: 'visualViewport' in window,
  dialog: 'showModal' in HTMLDialogElement.prototype,
  dvh: CSS.supports('height', '100dvh'),
  has: CSS.supports('selector(:has(a))'),
  safeArea: CSS.supports('padding-top', 'env(safe-area-inset-top)'),
};
return JSON.stringify({ results, support, userAgent: navigator.userAgent });
