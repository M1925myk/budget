// Интерфейс приложения. Вся логика и формулы — в core.js.
// Пользовательский текст попадает на страницу только как текст (textContent), не как HTML.

import {
  BudgetError,
  MAX_CATEGORY_NAME_LENGTH,
  MAX_BACKUP_CHARS,
  MAX_NOTE_LENGTH,
  UNCATEGORIZED,
  addCategory,
  addMonths,
  addTransaction,
  backupFilename,
  backupReminderDue,
  categoryUsage,
  centsToInput,
  createInitialState,
  dayView,
  deleteCategory,
  deleteTransaction,
  formatDay,
  formatDayNear,
  formatFullDate,
  formatMoney,
  formatMonth,
  futureTransactionCount,
  latestMonth,
  localDateISO,
  monthOf,
  monthView,
  moneyParts,
  parseAmount,
  parseBackup,
  parseMoney,
  pluralRu,
  recoveryDate,
  renameCategory,
  serializeBackup,
  setBudget,
  setStartDate,
  startMonth,
  transactionsOn,
  updateTransaction,
  validateStartDate,
  validateState,
  weekdayShort,
} from './core.js';

// Две копии приложения на одном домене (рабочая и тестовая) не должны делить данные и кэш.
const APP_DIR = new URL('./', location.href).pathname;
const STORAGE_KEY = `daily-budget.state.v1${APP_DIR === '/' ? '' : `:${APP_DIR}`}`;
const CACHE_PREFIX = `daily-budget-${encodeURIComponent(APP_DIR)}-`;
const TOAST_MS = 8000;
const DOUBLE_TAP_GUARD_MS = 1000;
const SECOND_TAP_MS = 500;
const SECOND_TAP_PX = 44;

const appRoot = document.getElementById('app');
const tabsNav = document.getElementById('tabs');
const sheet = document.getElementById('sheet');
const toastBox = document.getElementById('toast');
const announcer = document.getElementById('announcer');

let state = null;
let activeTab = 'today';
let viewedMonth = null;
let renderedDay = null;
let main = null; // элементы главного экрана
let toastTimer = null;
let toastDuration = TOAST_MS;
let swProblem = null;
let updateReady = false;
let onboardingRefresh = null;
let isSharingFile = false;
let lastClick = { x: -1000, y: -1000, time: -Infinity, isTap: false };
let secondTapGuard = lastClick;

// ---------- Мелкие помощники ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key.startsWith('aria-') || key.startsWith('data-') || key === 'role') node.setAttribute(key, value);
    else node[key] = value;
  }
  node.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

const todayISO = () => localDateISO(new Date());

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function isStandalone() {
  return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
}

function isIOS() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function setFill(node, fraction) {
  node.style.setProperty('--fill', String(Math.max(0, Math.min(1, fraction))));
}

/** Выполняет действие и показывает ошибку пользователю; настоящие сбои не прячет. */
function attempt(action, onUserError) {
  try {
    return action();
  } catch (error) {
    if (error instanceof BudgetError) {
      onUserError(error.message);
      return undefined;
    }
    throw error;
  }
}

function fieldError() {
  // Пустой элемент остаётся в разметке: диктор озвучивает появление текста только в уже существующей области.
  const node = el('p', { class: 'field-error', role: 'alert' });
  return {
    node,
    show(message, input) {
      node.textContent = message;
      if (input) {
        input.setAttribute('aria-invalid', 'true');
        input.focus();
      }
    },
    clear(input) {
      node.textContent = '';
      input?.removeAttribute('aria-invalid');
    },
  };
}

function moneyInput(props) {
  const input = el('input', {
    class: 'input',
    type: 'text',
    inputMode: 'decimal',
    autocomplete: 'off',
    placeholder: '0',
    enterKeyHint: 'done',
    ...props,
  });
  input.setAttribute('autocorrect', 'off');
  const wrap = el('span', { class: 'money-input' }, input, el('span', { class: 'money-suffix', text: '€', 'aria-hidden': 'true' }));
  return { input, wrap };
}

function textField(label, control, ...extra) {
  return el('label', { class: 'field' }, el('span', { class: 'field-label', text: label }), control, ...extra);
}

// ---------- Хранение ----------

function loadState() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    return { status: 'unavailable', detail: error.message };
  }
  if (raw === null) return { status: 'empty' };
  try {
    return { status: 'ok', state: validateState(JSON.parse(raw)) };
  } catch (error) {
    return { status: 'corrupt', raw, detail: error.message };
  }
}

/**
 * Сначала запись в память телефона, и только потом обновление экрана. При сбое состояние не меняется.
 * Перед записью данные проверяются тем же кодом, что и при чтении: приложение не должно
 * записать то, что само не сможет прочитать при следующем запуске.
 */
function commit(next) {
  try {
    validateState(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    showToast(`Не удалось сохранить на телефоне, изменение не записано. ${error.name === 'QuotaExceededError' ? 'Закончилось место для данных.' : error.message}`, { error: true });
    return false;
  }
  hideToast();
  state = next;
  render();
  return true;
}

/** Просим систему не удалять данные автоматически. iPhone решает сам; итог виден в настройках. */
function requestPersistentStorage() {
  if (navigator.storage?.persist) {
    navigator.storage.persist().catch((error) => {
      console.warn('storage.persist:', error);
    });
  }
}

// ---------- Уведомления ----------

function announce(message) {
  // Пустая пауза нужна, чтобы экранный диктор заметил изменение даже при том же тексте.
  announcer.textContent = '';
  setTimeout(() => {
    announcer.textContent = message;
  }, 60);
}

function hideToast() {
  clearTimeout(toastTimer);
  toastBox.hidden = true;
  toastBox.replaceChildren();
  toastBox.classList.remove('toast-error');
}

function showToast(message, { actionLabel, onAction, error = false } = {}) {
  // Открытый лист перекрывает всё остальное на экране, поэтому ошибка показывается в нём самом.
  if (error && sheet.open) {
    showSheetAlert(message);
    return;
  }
  hideToast();
  toastBox.classList.toggle('toast-error', error);
  toastBox.append(el('span', { class: 'toast-text', text: message }));
  if (actionLabel) {
    toastBox.append(el('button', {
      type: 'button',
      class: 'toast-action',
      id: 'toast-action',
      text: actionLabel,
      onClick: () => {
        hideToast();
        onAction();
      },
    }));
  }
  toastBox.hidden = false;
  announce(message);
  toastDuration = error ? TOAST_MS * 2 : TOAST_MS;
  toastTimer = setTimeout(hideToast, toastDuration);
}

// Пока на кнопке уведомления стоит фокус, оно не должно исчезать из-под неё.
toastBox.addEventListener('focusin', () => clearTimeout(toastTimer));
toastBox.addEventListener('focusout', () => {
  if (!toastBox.hidden) toastTimer = setTimeout(hideToast, toastDuration);
});

// ---------- Лист поверх экрана ----------

function focusCurrentHeading() {
  document.querySelector('.panel:not([hidden]) h1')?.focus({ preventScroll: true });
}

function openSheet(title, ...content) {
  secondTapGuard = lastClick;
  hideToast(); // Под листом уведомление всё равно недоступно для нажатия.
  const heading = el('h2', { class: 'sheet-title', id: 'sheet-title', text: title, tabIndex: -1 });
  // Фокус на заголовке, чтобы клавиатура не выезжала сама при открытии.
  heading.setAttribute('autofocus', '');
  sheet.replaceChildren(
    el('div', { class: 'sheet-body' },
      el('div', { class: 'sheet-head' },
        heading,
        el('button', { type: 'button', class: 'icon-btn sheet-close', id: 'sheet-close', 'aria-label': 'Закрыть', onClick: closeSheet }, icon('close'))),
      el('p', { class: 'sheet-alert', id: 'sheet-alert', role: 'alert' }),
      ...content),
  );
  if (sheet.open) heading.focus();
  else sheet.showModal();
  sheet.scrollTop = 0;
}

function showSheetAlert(message) {
  const alert = document.getElementById('sheet-alert');
  alert.textContent = message;
  sheet.scrollTop = 0;
}

function closeSheet() {
  const wasOpen = sheet.open;
  if (wasOpen) {
    secondTapGuard = lastClick;
    sheet.close();
  }
  sheet.replaceChildren();
  // Кнопка, открывшая лист, могла исчезнуть при обновлении экрана.
  if (wasOpen && document.activeElement === document.body) focusCurrentHeading();
}

// Лист открылся или закрылся, а под пальцем оказалось что-то другое. Второе нажатие двойного
// касания не должно сработать на этом элементе: удалить трату, отменить удаление, открыть кошелёк.
document.addEventListener('click', (event) => {
  // detail = 0 у нажатий с клавиатуры и экранного диктора: у них нет координат пальца.
  const isTap = event.detail > 0;
  const isSecondTap = isTap && secondTapGuard.isTap
    && performance.now() - secondTapGuard.time < SECOND_TAP_MS
    && Math.hypot(event.clientX - secondTapGuard.x, event.clientY - secondTapGuard.y) < SECOND_TAP_PX;
  if (isSecondTap) {
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  lastClick = { x: event.clientX, y: event.clientY, time: performance.now(), isTap };
}, true);
sheet.addEventListener('click', (event) => {
  if (event.target === sheet) closeSheet();
});
sheet.addEventListener('cancel', () => sheet.replaceChildren());

function confirmSheet({ title, text, yesLabel, onYes }) {
  openSheet(title,
    el('p', { text }),
    el('div', { class: 'actions' },
      el('button', {
        type: 'button',
        class: 'btn btn-danger',
        id: 'confirm-yes',
        text: yesLabel,
        onClick: () => {
          closeSheet();
          onYes();
        },
      }),
      el('button', { type: 'button', class: 'btn btn-quiet', id: 'confirm-no', text: 'Отмена', onClick: closeSheet })));
}

// ---------- Экран установки и служебные экраны ----------

function installNotice({ compact = false } = {}) {
  if (!isIOS() || isStandalone()) return null;
  if (compact) {
    return el('p', { class: 'notice small', id: 'install-notice', text: 'Это вкладка Safari, а не приложение. Установи его: «Поделиться» → «На экран “Домой”». Данные отсюда туда не перейдут.' });
  }
  return el('div', { class: 'notice', id: 'install-notice' },
    el('strong', { text: 'Сначала установи приложение на iPhone' }),
    el('ol', {},
      el('li', { text: 'Нажми «Поделиться» внизу Safari.' }),
      el('li', { text: 'Выбери «На экран “Домой”» и нажми «Добавить».' }),
      el('li', { text: 'Открой приложение с главного экрана.' })),
    el('span', { class: 'small muted', text: 'Данные, введённые здесь в Safari, в установленное приложение не перейдут.' }));
}

function setScreen(...children) {
  tabsNav.hidden = true;
  main = null;
  onboardingRefresh = null;
  closeSheet();
  hideToast();
  appRoot.replaceChildren(el('div', { class: 'screen screen-plain' }, ...children));
}

function showUnavailable(detail) {
  setScreen(el('div', { class: 'onboarding', id: 'storage-unavailable' },
    el('h1', { text: 'Нет доступа к памяти' }),
    el('p', { text: 'Браузер не даёт приложению хранить данные, поэтому записывать траты нельзя. Проверь, что не включён приватный режим, и разреши хранение данных сайтов.' }),
    el('p', { class: 'small muted', text: detail })));
}

function showCorrupt(raw, detail) {
  setScreen(el('div', { class: 'onboarding', id: 'corrupt-screen' },
    el('h1', { text: 'Данные не читаются' }),
    el('p', { text: 'Приложение не может прочитать сохранённые данные и ничего не меняло. Сохрани их в файл или восстанови из своей резервной копии.' }),
    el('p', { class: 'small muted', text: detail }),
    el('div', { class: 'actions' },
      el('button', {
        type: 'button',
        class: 'btn',
        id: 'corrupt-save',
        text: 'Сохранить данные как есть',
        onClick: () => saveFile(raw, `budget-damaged-${todayISO()}.json`).catch(reportFileError),
      }),
      el('button', {
        type: 'button',
        class: 'btn',
        id: 'corrupt-restore',
        text: 'Восстановить из копии',
        onClick: pickBackupFile,
      }),
      el('button', {
        type: 'button',
        class: 'btn btn-danger',
        id: 'corrupt-reset',
        text: 'Удалить и начать заново',
        onClick: () => confirmSheet({
          title: 'Удалить данные?',
          text: 'Повреждённые данные будут удалены без возможности восстановления.',
          yesLabel: 'Удалить',
          onYes: resetAll,
        }),
      })),
    importInput()));
}

function showOnboarding() {
  const { input, wrap } = moneyInput({ id: 'onb-amount' });
  const error = fieldError();
  const preview = el('div', { class: 'preview', id: 'onb-preview', 'aria-live': 'polite' });
  const date = el('input', { class: 'input', id: 'onb-date', type: 'date' });
  let dateTouched = false;
  const chosenDate = (today) => (dateTouched ? date.value : today);

  const updatePreview = () => {
    error.clear(input);
    preview.replaceChildren();
    const today = todayISO();
    date.max = today;
    date.min = `${monthOf(today)}-01`;
    if (!dateTouched) date.value = today;
    let cents;
    let view;
    try {
      cents = parseMoney(input.value);
      validateStartDate(chosenDate(today), today);
      view = dayView(createInitialState(chosenDate(today), cents), today);
    } catch (problem) {
      if (!(problem instanceof BudgetError)) throw problem;
      return; // Пока человек печатает, неполная сумма не ошибка. Остальное покажет кнопка «Начать».
    }
    if (cents === 0) return;
    preview.append(el('span', {},
      el('strong', { text: formatMoney(view.normDay) }),
      ` в день · с ${formatDay(chosenDate(today))}, ${view.days} ${pluralRu(view.days, 'день', 'дня', 'дней')}`));
  };
  input.addEventListener('input', updatePreview);
  date.addEventListener('change', () => {
    dateTouched = date.value !== todayISO();
    updatePreview();
  });

  const onSubmit = (event) => {
    event.preventDefault();
    attempt(() => {
      const cents = parseAmount(input.value);
      // Дата берётся в момент нажатия: экран мог быть открыт ещё со вчерашнего дня.
      const today = todayISO();
      validateStartDate(chosenDate(today), today);
      if (commit(createInitialState(chosenDate(today), cents))) requestPersistentStorage();
    }, (message) => error.show(message, input));
  };

  setScreen(
    installNotice(),
    el('form', { class: 'onboarding', id: 'onb-form', noValidate: true, onSubmit },
      el('h1', { text: 'Сколько денег на месяц?' }),
      el('p', { class: 'muted', text: 'Сумма разделится на дни с выбранной даты до конца месяца. Что не потратишь сегодня, прибавится к завтрашнему лимиту.' }),
      textField('Сумма', wrap, error.node),
      textField('Считать с', date),
      preview,
      el('button', { type: 'submit', class: 'btn btn-primary', id: 'onb-submit', text: 'Начать' }),
      el('button', { type: 'button', class: 'btn btn-quiet', id: 'onb-restore', text: 'Восстановить из резервной копии', onClick: pickBackupFile }),
      el('p', { class: 'small muted', text: 'Все данные хранятся только на этом телефоне. Сервера и аккаунта нет.' })),
    importInput(),
  );
  onboardingRefresh = updatePreview;
  updatePreview();
}

// ---------- Главный экран ----------

function buildMain() {
  const topbarDay = el('span', { class: 'topbar-day', id: 'topbar-day' });
  const topbarWeekday = el('span', { class: 'topbar-weekday', id: 'topbar-weekday' });
  const walletAmount = el('span', { class: 'wallet-amount', id: 'wallet-amount' });
  const wallet = el('button', { type: 'button', class: 'wallet', id: 'wallet', onClick: openWalletSheet },
    icon('wallet'),
    walletAmount);

  const heroAmount = el('div', { class: 'hero-amount', id: 'hero-amount' });
  const heroFill = el('span', { class: 'meter-fill' });
  const heroCaption = el('p', { class: 'hero-caption', id: 'hero-caption' });
  const hero = el('section', { class: 'hero', id: 'hero', 'aria-labelledby': 'hero-label' },
    el('h1', { class: 'hero-label', id: 'hero-label', text: 'Остаток', tabIndex: -1 }),
    heroAmount,
    el('div', { class: 'meter', 'aria-hidden': 'true' }, heroFill),
    heroCaption);

  const dateNotice = el('div', { class: 'notice notice-danger', id: 'date-notice', hidden: true });

  // Форма добавления собирается один раз, поэтому обновление экрана не стирает ввод.
  const { input: amount, wrap: amountWrap } = moneyInput({ id: 'add-amount' });
  const formError = fieldError();
  const categoryValue = el('span', { class: 'form-row-value', id: 'add-category-value' });
  const categoryButton = el('button', { type: 'button', class: 'form-row', id: 'add-category', onClick: openCategoryPicker },
    el('span', { class: 'form-row-label', text: 'Категория' }),
    el('span', { class: 'form-row-end' }, categoryValue, icon('right')));
  const note = el('input', { class: 'form-row-input', id: 'add-note', type: 'text', maxLength: MAX_NOTE_LENGTH, placeholder: 'Куда потрачено', autocomplete: 'off', enterKeyHint: 'done' });
  const date = el('input', { class: 'form-row-input', id: 'add-date', type: 'date' });
  // Кнопка и сообщение об ошибке стоят рядом с суммой: так они не уходят под клавиатуру iPhone.
  const form = el('form', { class: 'card', id: 'add-form', noValidate: true, 'aria-label': 'Новая трата', onSubmit: onAddSubmit },
    el('div', { class: 'add-amount' },
      el('label', { class: 'sr-only', htmlFor: 'add-amount', text: 'Сумма' }),
      el('div', { class: 'amount-row' },
        amountWrap,
        el('button', { type: 'submit', class: 'btn btn-primary', id: 'add-submit', text: 'Записать' })),
      formError.node),
    categoryButton,
    el('label', { class: 'form-row' }, el('span', { class: 'form-row-label', text: 'Заметка' }), note),
    el('label', { class: 'form-row' }, el('span', { class: 'form-row-label', text: 'Дата' }), date));

  amount.addEventListener('input', () => formError.clear(amount));
  date.addEventListener('change', () => {
    formError.clear(amount);
    main.dateTouched = date.value !== todayISO();
  });

  const reminderSlot = el('div', { id: 'backup-reminder-slot' });
  const todayListTitle = el('h2', { class: 'section-title', text: 'Сегодня' });
  const todayTotal = el('span', { class: 'amount muted', id: 'today-total' });
  const todayList = el('div', { id: 'today-list' });

  const panelToday = el('div', { class: 'panel', id: 'panel-today' },
    dateNotice,
    hero,
    form,
    reminderSlot,
    el('section', { class: 'section' },
      el('div', { class: 'section-head' }, todayListTitle, todayTotal),
      todayList));

  const panelMonth = el('div', { class: 'panel', id: 'panel-month', hidden: true });
  const panelSettings = el('div', { class: 'panel', id: 'panel-settings', hidden: true });

  const updateSlot = el('div', { id: 'update-slot' });

  appRoot.replaceChildren(el('div', { class: 'screen' },
    installNotice({ compact: true }),
    updateSlot,
    el('header', { class: 'topbar' }, el('div', { class: 'topbar-date' }, topbarDay, ', ', topbarWeekday), wallet),
    panelToday,
    panelMonth,
    panelSettings,
    importInput()));

  tabsNav.hidden = false;
  main = {
    topbarDay, topbarWeekday, wallet, walletAmount,
    hero, heroAmount, heroFill, heroCaption, dateNotice,
    amount, formError, categoryValue, note, date,
    reminderSlot, updateSlot, todayTotal, todayList,
    panelToday, panelMonth, panelSettings,
    selectedCategory: null,
    dateTouched: false,
    lastSavedAt: 0,
  };
}

function onAddSubmit(event) {
  event.preventDefault();
  const { amount, formError, date, note } = main;
  formError.clear(amount);

  // Двойное нажатие на «Записать»: второе нажатие приходит уже в пустую форму.
  if (amount.value.trim() === '' && Date.now() - main.lastSavedAt < DOUBLE_TAP_GUARD_MS) return;

  const cents = attempt(() => parseAmount(amount.value), (message) => formError.show(message, amount));
  if (cents === undefined) return;

  // Если дату не меняли, трата идёт на сегодня, даже если поле ещё не успело обновиться после полуночи.
  const today = todayISO();
  const savedDate = main.dateTouched ? date.value : today;
  const before = state;
  const next = attempt(() => addTransaction(state, {
    id: newId(),
    createdAt: Date.now(),
    date: savedDate,
    amount: cents,
    categoryId: main.selectedCategory,
    note: note.value,
  }, today), (message) => formError.show(message));
  if (!next) return;
  if (!commit(next)) return;

  main.lastSavedAt = Date.now();
  amount.value = '';
  note.value = '';
  main.selectedCategory = null;
  main.dateTouched = false;
  document.activeElement?.blur();
  render();
  showToast(`Записано: ${formatMoney(cents)}${savedDate !== today ? ` за ${formatDayNear(savedDate, today)}` : ''}`, {
    actionLabel: 'Отменить',
    onAction: () => commit(before),
  });
}

function renderTopbar(view) {
  const { topbarDay, topbarWeekday, wallet, walletAmount } = main;
  topbarDay.textContent = formatDay(view.date);
  topbarWeekday.textContent = weekdayShort(view.date);
  if (view.beforeStart) {
    walletAmount.textContent = '—';
    wallet.classList.remove('is-negative');
    wallet.removeAttribute('aria-label');
    return;
  }
  walletAmount.textContent = formatMoney(view.remainingMonth);
  wallet.classList.toggle('is-negative', view.remainingMonth < 0);
  wallet.setAttribute('aria-label', `Кошелёк. Осталось на месяц ${formatMoney(view.remainingMonth)}, остаток на сегодня ${formatMoney(view.availableToday)}`);
}

function renderHero(view) {
  const { hero, heroAmount, heroFill, heroCaption, dateNotice } = main;
  hero.hidden = view.beforeStart;
  dateNotice.hidden = !view.beforeStart;
  if (view.beforeStart) {
    dateNotice.replaceChildren(
      el('strong', { text: 'Дата на телефоне раньше начала учёта' }),
      el('span', { text: `Учёт начат с ${formatFullDate(view.startDate)}, а на телефоне ${formatFullDate(view.date)}. Проверь дату в настройках iPhone.` }));
    return;
  }

  const { sign, int, frac } = moneyParts(view.availableToday);
  const intText = `${sign}${int}`;
  heroAmount.replaceChildren(
    el('span', { class: 'hero-int', text: intText }),
    el('span', { class: 'hero-frac', text: `,${frac} €` }));
  heroAmount.dataset.size = intText.length <= 5 ? 'l' : intText.length <= 9 ? 'm' : 's';
  hero.classList.toggle('is-negative', view.availableToday < 0);

  const { availableToday: available, limitToday: limit, spentToday: spent } = view;
  setFill(heroFill, available < 0 ? 1 : limit > 0 ? spent / limit : 0);

  if (available < 0) {
    const recovery = recoveryDate(state, view.date);
    heroCaption.replaceChildren(
      el('strong', { text: 'Перерасход. ' }),
      recovery
        ? `Лимит вернётся в плюс ${formatDayNear(recovery, view.date)}, если больше не тратить.`
        : 'Долг перейдёт на следующие дни.');
  } else if (available === 0 && spent > 0) {
    heroCaption.textContent = `На сегодня всё потрачено: ${formatMoney(spent)}.`;
  } else if (spent > 0) {
    heroCaption.textContent = `Потрачено ${formatMoney(spent)} из ${formatMoney(limit)}.`;
  } else {
    heroCaption.textContent = `Сегодня ещё нет трат. Норма: ${formatMoney(view.normDay)} в день.`;
  }
}

function renderCategoryButton() {
  const selected = state.categories.find((c) => c.id === main.selectedCategory);
  if (!selected) main.selectedCategory = null;
  main.categoryValue.textContent = selected ? selected.name : 'Выбрать';
  main.categoryValue.classList.toggle('is-chosen', Boolean(selected));
}

function openCategoryPicker() {
  const choose = (id) => {
    main.selectedCategory = id;
    renderCategoryButton();
    closeSheet();
  };
  const row = (id, name) => el('button', {
    type: 'button',
    class: 'row picker-row',
    'data-id': id ?? undefined,
    id: id === null ? 'picker-none' : undefined,
    'aria-pressed': String(main.selectedCategory === id),
    onClick: () => choose(id),
  },
    el('span', { class: 'row-title', text: name }),
    main.selectedCategory === id ? el('span', { class: 'picker-check' }, icon('check')) : null);

  openSheet('Категория',
    el('div', { class: 'list', id: 'picker-list' },
      state.categories.map((category) => row(category.id, category.name)),
      row(null, UNCATEGORIZED)),
    el('button', {
      type: 'button',
      class: 'btn',
      id: 'picker-new',
      onClick: () => openCategorySheet(null, (created) => {
        main.selectedCategory = created;
        renderCategoryButton();
      }),
    }, icon('plus'), 'Новая категория'));
}

function renderDateField() {
  const today = todayISO();
  const { date } = main;
  date.max = today;
  date.min = state.startDate;
  if (!main.dateTouched) date.value = today;
}

function transactionRow(transaction) {
  const category = state.categories.find((c) => c.id === transaction.categoryId);
  return el('button', {
    type: 'button',
    class: 'row tx-row',
    'data-id': transaction.id,
    onClick: () => openTransactionSheet(transaction.id),
  },
    el('span', { class: 'row-main' },
      el('span', { class: 'row-title', text: category ? category.name : UNCATEGORIZED }),
      transaction.note ? el('span', { class: 'row-sub', text: ` · ${transaction.note}` }) : null),
    el('span', { class: 'row-amount', text: formatMoney(transaction.amount) }));
}

function renderTodayList(view) {
  const items = transactionsOn(state, view.date);
  main.todayTotal.textContent = items.length ? formatMoney(view.beforeStart ? 0 : view.spentToday) : '';
  main.todayList.replaceChildren(items.length
    ? el('div', { class: 'list' }, items.map(transactionRow))
    : el('p', { class: 'empty', text: 'Пока ничего. Запиши первую трату выше.' }));
}

function renderNotices() {
  const notices = [];
  if (swProblem) {
    notices.push(el('div', { class: 'notice notice-danger', id: 'offline-problem' },
      el('strong', { text: 'Работа без интернета не настроилась' }),
      el('span', { text: `Причина: ${swProblem}. Пока приложение открывается только с интернетом. Оно попробует снова при следующем запуске.` })));
  }
  if (backupReminderDue(state, Date.now())) {
    notices.push(el('div', { class: 'notice', id: 'backup-reminder' },
      el('span', { text: 'Данные хранятся только на этом телефоне, а свежей резервной копии нет больше месяца.' }),
      el('button', { type: 'button', class: 'btn', id: 'reminder-export', text: 'Сохранить копию', onClick: exportBackup })));
  }
  main.reminderSlot.replaceChildren(...notices);
}

function renderUpdateSlot() {
  if (!main) return;
  main.updateSlot.replaceChildren(...(updateReady
    ? [el('div', { class: 'notice', id: 'update-notice' },
      el('span', { text: 'Загружена новая версия приложения. Твои данные не изменятся.' }),
      el('button', { type: 'button', class: 'btn', id: 'update-reload', text: 'Обновить', onClick: () => location.reload() }))]
    : []));
}

function renderMonth() {
  const today = todayISO();
  const first = startMonth(state);
  const last = latestMonth(state, monthOf(today));
  if (viewedMonth === null || viewedMonth < first) viewedMonth = first > monthOf(today) ? first : monthOf(today);
  if (viewedMonth > last) viewedMonth = last;
  const view = monthView(state, viewedMonth);
  const focusedId = document.activeElement?.id;

  const nav = el('div', { class: 'month-nav' },
    el('button', {
      type: 'button',
      class: 'icon-btn',
      id: 'month-prev',
      'aria-label': 'Предыдущий месяц',
      disabled: viewedMonth <= first,
      onClick: () => {
        viewedMonth = addMonths(viewedMonth, -1);
        renderMonth();
      },
    }, icon('left')),
    el('h1', { class: 'month-title', id: 'month-title', text: formatMonth(viewedMonth), tabIndex: -1 }),
    el('button', {
      type: 'button',
      class: 'icon-btn',
      id: 'month-next',
      'aria-label': 'Следующий месяц',
      disabled: viewedMonth >= last,
      onClick: () => {
        viewedMonth = addMonths(viewedMonth, 1);
        renderMonth();
      },
    }, icon('right')));

  const summary = el('div', { class: 'list', id: 'month-summary' },
    el('button', {
      type: 'button',
      class: 'row',
      id: 'month-budget',
      onClick: () => openBudgetSheet(viewedMonth),
    },
      el('span', { class: 'row-main' },
        el('span', { class: 'row-title', text: 'Бюджет' }),
        el('span', { class: 'row-sub', text: `${formatMoney(view.normDay)} в день · изменить` })),
      el('span', { class: 'row-amount', text: formatMoney(view.budget) })),
    summaryRow('Перенос с прошлого месяца', view.carry, true),
    summaryRow('Потрачено', view.spent),
    summaryRow('Осталось', view.remaining, false, 'month-remaining'));

  const categories = view.categories.length
    ? el('section', { class: 'section' },
      el('h2', { class: 'section-title', text: 'Куда ушло' }),
      spendingRing(view),
      el('div', { class: 'list', id: 'month-categories' }, view.categories.map((category) => el('div', { class: 'cat-row' },
        el('span', { class: `series-dot ${seriesClass(category.categoryId)}`, 'aria-hidden': 'true' }),
        el('span', { class: 'cat-name', text: category.name }),
        el('span', { class: 'amount', text: `${formatMoney(category.amount)} · ${Math.round(category.share * 100)}\u00A0%` })))))
    : null;

  const history = el('section', { class: 'section', id: 'month-history' },
    el('h2', { class: 'section-title', text: 'Все траты' }),
    view.dayGroups.length
      ? view.dayGroups.flatMap((group) => [
        el('div', { class: 'day-head' },
          el('span', { text: `${formatDay(group.date)}, ${weekdayShort(group.date)}` }),
          el('span', { class: 'amount', text: formatMoney(group.total) })),
        el('div', { class: 'list' }, group.items.map(transactionRow)),
      ])
      : el('p', { class: 'empty', text: `В этом месяце трат нет.` }));

  main.panelMonth.replaceChildren(...[nav, summary, categories, history].filter(Boolean));

  // Кнопки листания создаются заново, поэтому фокус нужно вернуть, иначе диктор теряет место на экране.
  if (focusedId === 'month-prev' || focusedId === 'month-next') {
    const button = document.getElementById(focusedId);
    (button.disabled ? document.getElementById('month-title') : button).focus();
  }
}

const SERIES_COUNT = 8;

/** Цвет закреплён за категорией, а не за её местом по сумме. После восьмой и «Без категории» — серый. */
function seriesClass(categoryId) {
  const index = state.categories.findIndex((c) => c.id === categoryId);
  return index >= 0 && index < SERIES_COUNT ? `series-${index + 1}` : 'series-other';
}

function svgEl(tag, attributes) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

/** Кольцо расходов. Подписи и суммы — в списке под ним, цвет не единственный носитель смысла. */
function spendingRing(view) {
  const radius = 48;
  const circumference = 2 * Math.PI * radius;
  const gap = view.categories.length > 1 ? 2 : 0;
  const svg = svgEl('svg', { viewBox: '0 0 120 120', class: 'ring-svg', 'aria-hidden': 'true' });
  const group = svgEl('g', { transform: 'rotate(-90 60 60)' });
  let offset = 0;
  for (const category of view.categories) {
    const length = category.share * circumference;
    group.append(svgEl('circle', {
      cx: 60,
      cy: 60,
      r: radius,
      fill: 'none',
      'stroke-width': 14,
      class: `ring-segment ${seriesClass(category.categoryId)}`,
      'stroke-dasharray': `${Math.max(length - gap, 0.5)} ${circumference}`,
      'stroke-dashoffset': -offset,
    }));
    offset += length;
  }
  svg.append(group);
  const summary = view.categories.map((c) => `${c.name} ${Math.round(c.share * 100)} %`).join(', ');
  return el('div', { class: 'ring', id: 'month-ring', role: 'img', 'aria-label': `Потрачено ${formatMoney(view.spent)}: ${summary}` },
    svg,
    el('div', { class: 'ring-center' },
      el('span', { class: 'ring-label', text: 'Потрачено' }),
      el('span', { class: 'ring-total', text: formatMoney(view.spent) })));
}

function summaryRow(title, cents, signed = false, id = undefined) {
  const prefix = signed && cents > 0 ? '+' : '';
  return el('div', { class: `row${cents < 0 ? ' is-negative' : ''}`, id },
    el('span', { class: 'row-title', text: title }),
    el('span', { class: 'row-amount', text: `${prefix}${formatMoney(cents)}` }));
}

function renderSettings() {
  const today = todayISO();
  const month = monthOf(today);
  const showBudgetRow = today >= state.startDate;

  const categoryRows = state.categories.map((category) => {
    const used = categoryUsage(state, category.id);
    return el('button', {
      type: 'button',
      class: 'row category-row',
      'data-id': category.id,
      onClick: () => openCategorySheet(category.id),
    },
      el('span', { class: 'row-main' },
        el('span', { class: 'row-title', text: category.name }),
        el('span', { class: 'row-sub', text: `${used} ${pluralRu(used, 'трата', 'траты', 'трат')}` })),
      el('span', { class: 'row-action muted' }, icon('right')));
  });

  const backupText = state.lastBackupAt === null
    ? 'Резервной копии ещё не было.'
    : `Последняя копия: ${formatDay(localDateISO(new Date(state.lastBackupAt)))} ${new Date(state.lastBackupAt).getFullYear()}.`;

  const about = el('p', { class: 'small muted', id: 'about-status', text: 'Проверяю состояние…' });
  fillAboutStatus(about);

  main.panelSettings.replaceChildren(...[
    el('h1', { class: 'section-title', text: 'Настройки', tabIndex: -1 }),

    showBudgetRow
      ? el('section', { class: 'section' },
        el('h2', { class: 'field-label', text: `Бюджет на ${formatMonth(month)}` }),
        el('div', { class: 'list' },
          el('button', { type: 'button', class: 'row', id: 'settings-budget', onClick: () => openBudgetSheet(month) },
            el('span', { class: 'row-title', text: 'Сумма на месяц' }),
            el('span', { class: 'row-amount', text: formatMoney(dayView(state, today).budget) })),
          month === startMonth(state)
            ? el('button', { type: 'button', class: 'row', id: 'settings-start', onClick: openStartDateSheet },
              el('span', { class: 'row-title', text: 'Считать с' }),
              el('span', { class: 'row-amount', id: 'settings-start-value', text: formatDay(state.startDate) }))
            : null))
      : null,

    el('section', { class: 'section' },
      el('h2', { class: 'field-label', text: 'Категории' }),
      el('div', { class: 'list', id: 'category-list' }, categoryRows),
      el('button', { type: 'button', class: 'btn', id: 'category-add', onClick: () => openCategorySheet(null) }, icon('plus'), 'Новая категория')),

    el('section', { class: 'section' },
      el('h2', { class: 'field-label', text: 'Резервная копия' }),
      el('p', { class: 'small muted', id: 'backup-status', text: `Траты хранятся только на этом телефоне. Если удалить приложение, они пропадут. ${backupText}` }),
      el('div', { class: 'btn-row' },
        el('button', { type: 'button', class: 'btn', id: 'btn-export', text: 'Сохранить', onClick: exportBackup }),
        el('button', { type: 'button', class: 'btn', id: 'btn-import', text: 'Восстановить', onClick: pickBackupFile }))),

    el('section', { class: 'section' },
      el('h2', { class: 'field-label', text: 'Приватность' }),
      el('p', { class: 'small muted', text: 'Нет аккаунта, сервера, аналитики и рекламы. Приложение не отправляет траты никуда. Интернет нужен только для установки и проверки обновлений. Файл копии не зашифрован: храни его в надёжном месте.' }),
      about),

    el('button', {
      type: 'button',
      class: 'btn btn-danger',
      id: 'btn-reset',
      text: 'Удалить все данные',
      onClick: () => confirmSheet({
        title: 'Удалить все данные?',
        text: 'Бюджеты, категории и все траты будут удалены с этого телефона. Отменить это нельзя. Если данные могут понадобиться, сначала сохрани резервную копию.',
        yesLabel: 'Удалить всё',
        onYes: resetAll,
      }),
    }),
  ].filter(Boolean));
}

async function fillAboutStatus(node) {
  try {
    node.textContent = (await readAboutStatus()).join(' ');
  } catch (error) {
    node.textContent = `Не удалось проверить состояние: ${error.message}.`;
  }
}

async function hasStartupFiles(cacheName) {
  const cache = await caches.open(cacheName);
  const found = await Promise.all(['index.html', 'styles.css', 'boot.js', 'app.js', 'core.js'].map((file) => cache.match(file)));
  return found.every(Boolean);
}

async function readAboutStatus() {
  const parts = [];
  const hasCaches = 'caches' in window;
  const cacheName = hasCaches ? (await caches.keys()).find((name) => name.startsWith(CACHE_PREFIX)) : undefined;
  if (swProblem) {
    parts.push(`Работа без интернета не настроена: ${swProblem}.`);
  } else if (!('serviceWorker' in navigator)) {
    parts.push('Этот браузер не поддерживает работу без интернета.');
  } else {
    // «Готова» только если файлы действительно лежат в кэше: одного активного service worker мало.
    const isCached = cacheName ? await hasStartupFiles(cacheName) : false;
    parts.push(navigator.serviceWorker.controller && isCached
      ? 'Работа без интернета: готова.'
      : 'Работа без интернета: ещё настраивается, нужен запуск с интернетом.');
  }
  if (navigator.storage?.persisted) {
    const persisted = await navigator.storage.persisted();
    parts.push(persisted ? 'Защита от автоочистки: включена.' : 'Защита от автоочистки: система не подтвердила.');
  }
  // После загрузки обновления кэш уже новый, а на экране ещё старая версия.
  if (updateReady) parts.push('Загружена новая версия, нажми «Обновить».');
  else if (cacheName) parts.push(`Версия: ${cacheName.slice(CACHE_PREFIX.length)}.`);
  return parts;
}

function render() {
  if (!state) return;
  if (!main) buildMain();
  const today = todayISO();
  renderedDay = today;
  const view = dayView(state, today);
  renderTopbar(view);
  renderUpdateSlot();

  document.querySelectorAll('.tab').forEach((button) => {
    if (button.dataset.tab === activeTab) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  main.panelToday.hidden = activeTab !== 'today';
  main.panelMonth.hidden = activeTab !== 'month';
  main.panelSettings.hidden = activeTab !== 'settings';

  if (activeTab === 'today') {
    renderHero(view);
    renderCategoryButton();
    renderDateField();
    renderNotices();
    renderTodayList(view);
  } else if (activeTab === 'month') {
    renderMonth();
  } else {
    renderSettings();
  }
}

function switchTab(tab) {
  if (tab === activeTab) return;
  activeTab = tab;
  hideToast(); // Сообщение относится к прошлому экрану и не должно закрывать кнопки нового.
  if (tab === 'month') viewedMonth = monthOf(todayISO());
  render();
  scrollTo(0, 0);
}

tabsNav.addEventListener('click', (event) => {
  const button = event.target.closest('.tab');
  if (button) switchTab(button.dataset.tab);
});

// ---------- Листы: кошелёк, трата, бюджет, категория ----------

function openWalletSheet() {
  const today = todayISO();
  const view = dayView(state, today);
  if (view.beforeStart) {
    openSheet('Кошелёк', el('p', { text: `Учёт начат с ${formatFullDate(view.startDate)}. Проверь дату в настройках iPhone.` }));
    return;
  }
  const box = (label, cents, id) => el('div', { class: `wallet-box${cents < 0 ? ' is-negative' : ''}` },
    el('span', { class: 'wallet-box-label', text: label }),
    el('span', { class: 'wallet-box-amount', id, text: formatMoney(cents) }));

  openSheet('Кошелёк',
    el('div', { class: 'wallet-duo' },
      box('На сегодня', view.availableToday, 'wallet-sheet-today'),
      box('На месяц', view.remainingMonth, 'wallet-sheet-month')),
    el('div', { class: 'list' },
      summaryRow('Бюджет месяца', view.budget),
      summaryRow('Норма в день', view.normDay),
      summaryRow('Перенос с прошлого месяца', view.carry, true),
      summaryRow('Потрачено за месяц', view.spentMonth)),
    el('p', { class: 'small muted', text: 'Сэкономленное сегодня прибавится к лимиту завтра, а перерасход уменьшит лимит следующих дней. Это расчёт по записанным тратам, а не реальный баланс счёта.' }),
    el('button', { type: 'button', class: 'btn', id: 'wallet-budget', text: 'Изменить бюджет', onClick: () => openBudgetSheet(view.month) }));
}

function openTransactionSheet(id) {
  const transaction = state.transactions.find((t) => t.id === id);
  if (!transaction) {
    showToast('Этой траты больше нет.', { error: true });
    return;
  }
  const { input: amount, wrap } = moneyInput({ id: 'edit-amount', value: centsToInput(transaction.amount) });
  const amountError = fieldError();
  const category = el('select', { class: 'select', id: 'edit-category' },
    el('option', { value: '', text: UNCATEGORIZED }),
    state.categories.map((c) => el('option', { value: c.id, text: c.name })));
  category.value = transaction.categoryId ?? '';
  const note = el('input', { class: 'input', id: 'edit-note', type: 'text', maxLength: MAX_NOTE_LENGTH, value: transaction.note, placeholder: 'Куда потрачено', autocomplete: 'off', enterKeyHint: 'done' });
  const date = el('input', { class: 'input', id: 'edit-date', type: 'date', value: transaction.date, max: todayISO(), min: state.startDate });
  const generalError = fieldError();

  const onSubmit = (event) => {
    event.preventDefault();
    amountError.clear(amount);
    generalError.clear();
    const cents = attempt(() => parseAmount(amount.value), (message) => amountError.show(message, amount));
    if (cents === undefined) return;
    const next = attempt(() => updateTransaction(state, id, {
      date: date.value,
      amount: cents,
      categoryId: category.value || null,
      note: note.value,
    }, todayISO()), (message) => generalError.show(message));
    if (!next) return;
    const before = state;
    if (!commit(next)) return;
    closeSheet();
    showToast('Изменения сохранены.', { actionLabel: 'Отменить', onAction: () => commit(before) });
  };

  const onDelete = () => {
    const before = state;
    const next = attempt(() => deleteTransaction(state, id), (message) => generalError.show(message));
    if (!next) return;
    if (!commit(next)) return;
    closeSheet();
    showToast(`Удалено: ${formatMoney(transaction.amount)}`, { actionLabel: 'Отменить', onAction: () => commit(before) });
  };

  openSheet('Трата',
    el('form', { class: 'section', id: 'edit-form', noValidate: true, onSubmit },
      textField('Сумма', wrap, amountError.node),
      textField('Категория', category),
      textField('Заметка', note),
      textField('Дата', date),
      generalError.node,
      el('div', { class: 'actions' },
        el('button', { type: 'submit', class: 'btn btn-primary', id: 'edit-save', text: 'Сохранить' }),
        el('button', { type: 'button', class: 'btn btn-danger', id: 'edit-delete', text: 'Удалить трату', onClick: onDelete }))));
}

function openStartDateSheet() {
  const today = todayISO();
  const input = el('input', { class: 'input', id: 'start-date', type: 'date', value: state.startDate, min: `${monthOf(today)}-01`, max: today });
  const error = fieldError();
  const helper = el('p', { class: 'helper', id: 'start-helper' });

  const updateHelper = () => {
    error.clear(input);
    helper.textContent = '';
    let view;
    try {
      view = dayView(setStartDate(state, input.value, todayISO()), todayISO());
    } catch (problem) {
      if (!(problem instanceof BudgetError)) throw problem;
      error.show(problem.message);
      return;
    }
    helper.textContent = `${view.days} ${pluralRu(view.days, 'день', 'дня', 'дней')} по ${formatMoney(view.normDay)}. Остаток на сегодня: ${formatMoney(view.availableToday)}.`;
  };
  input.addEventListener('change', updateHelper);

  const onSubmit = (event) => {
    event.preventDefault();
    error.clear(input);
    const next = attempt(() => setStartDate(state, input.value, todayISO()), (message) => error.show(message));
    if (!next) return;
    if (commit(next)) closeSheet();
  };

  openSheet('С какого числа считать',
    el('form', { class: 'section', id: 'start-form', noValidate: true, onSubmit },
      textField('Дата начала', input, error.node),
      helper,
      el('button', { type: 'submit', class: 'btn btn-primary', id: 'start-save', text: 'Сохранить' })));
  updateHelper();
}

function openBudgetSheet(month) {
  const before = monthView(state, month);
  const { input, wrap } = moneyInput({ id: 'budget-amount', value: centsToInput(before.budget) });
  const error = fieldError();
  const helper = el('p', { class: 'helper', id: 'budget-helper' });

  const updateHelper = () => {
    error.clear(input);
    let cents;
    try {
      cents = parseMoney(input.value);
    } catch {
      helper.textContent = '';
      return;
    }
    const perDay = formatMoney(Math.round(cents / before.days));
    const today = todayISO();
    const currentMonth = monthOf(today);
    if (month === currentMonth) {
      const delta = dayView(setBudget(state, month, cents, currentMonth), today).availableToday - dayView(state, today).availableToday;
      const change = delta === 0 ? '' : ` Лимит на сегодня ${delta > 0 ? 'вырастет' : 'уменьшится'} на ${formatMoney(Math.abs(delta))}.`;
      helper.textContent = `${perDay} в день.${change} Следующие месяцы возьмут эту сумму, пока её не изменят.`;
    } else {
      helper.textContent = `${perDay} в день. Изменится перенос на следующие месяцы, их суммы останутся прежними.`;
    }
  };
  input.addEventListener('input', updateHelper);
  updateHelper();

  const onSubmit = (event) => {
    event.preventDefault();
    error.clear(input);
    // Текущий месяц берётся в момент нажатия: лист мог быть открыт ещё в прошлом месяце.
    const next = attempt(() => setBudget(state, month, parseMoney(input.value), monthOf(todayISO())), (message) => error.show(message, input));
    if (!next) return;
    if (commit(next)) closeSheet();
  };

  openSheet(`Бюджет: ${formatMonth(month)}`,
    el('form', { class: 'section', id: 'budget-form', noValidate: true, onSubmit },
      textField('Сумма на месяц', wrap, error.node),
      helper,
      el('button', { type: 'submit', class: 'btn btn-primary', id: 'budget-save', text: 'Сохранить' })));
}

function openCategorySheet(id, onCreated) {
  const existing = id === null ? null : state.categories.find((c) => c.id === id);
  if (id !== null && !existing) {
    showToast('Такой категории больше нет.', { error: true });
    return;
  }
  const input = el('input', {
    class: 'input',
    id: 'cat-name',
    type: 'text',
    maxLength: MAX_CATEGORY_NAME_LENGTH,
    value: existing ? existing.name : '',
    placeholder: 'Например, Кафе',
    autocomplete: 'off',
    autocapitalize: 'sentences',
    enterKeyHint: 'done',
  });
  const error = fieldError();
  input.addEventListener('input', () => error.clear(input));

  const onSubmit = (event) => {
    event.preventDefault();
    error.clear(input);
    const newCategoryId = newId();
    const next = attempt(
      () => (existing ? renameCategory(state, id, input.value) : addCategory(state, newCategoryId, input.value)),
      (message) => error.show(message, input),
    );
    if (!next) return;
    if (!commit(next)) return;
    closeSheet();
    if (!existing && onCreated) onCreated(newCategoryId);
  };

  const onDelete = () => {
    const used = categoryUsage(state, id);
    confirmSheet({
      title: `Удалить «${existing.name}»?`,
      text: used > 0
        ? `${used} ${pluralRu(used, 'трата перейдёт', 'траты перейдут', 'трат перейдут')} в «${UNCATEGORIZED}». Суммы не изменятся.`
        : 'В этой категории нет трат.',
      yesLabel: 'Удалить категорию',
      onYes: () => attempt(() => commit(deleteCategory(state, id)), (message) => showToast(message, { error: true })),
    });
  };

  openSheet(existing ? 'Категория' : 'Новая категория',
    el('form', { class: 'section', id: 'cat-form', noValidate: true, onSubmit },
      textField('Название', input, error.node),
      el('div', { class: 'actions' },
        el('button', { type: 'submit', class: 'btn btn-primary', id: 'cat-save', text: existing ? 'Сохранить' : 'Создать' }),
        existing ? el('button', { type: 'button', class: 'btn btn-danger', id: 'cat-delete', text: 'Удалить категорию', onClick: onDelete }) : null)));
  if (!existing) input.focus();
}

// ---------- Резервная копия ----------

function isShareCancel(error) {
  return error?.name === 'AbortError';
}

/**
 * На iPhone надёжный путь сохранить файл из установленного приложения — системное меню
 * «Поделиться». Скачивание по ссылке там может оставить человека на экране без выхода,
 * поэтому оно только запасной вариант. Возвращает true, если файл передан системе.
 */
async function saveFile(text, filename) {
  const file = new File([text], filename, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    if (isSharingFile) return false; // Меню «Поделиться» уже открыто: повторное нажатие ничего не делает.
    isSharingFile = true;
    try {
      await navigator.share({ files: [file] });
      return true;
    } catch (error) {
      if (isShareCancel(error)) return false;
      throw error;
    } finally {
      isSharingFile = false;
    }
  }
  const url = URL.createObjectURL(file);
  const link = el('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

function reportFileError(error) {
  showToast(`Не удалось сохранить файл: ${error.message}`, { error: true });
}

function exportBackup() {
  const now = Date.now();
  const text = serializeBackup(state, now);
  saveFile(text, backupFilename(todayISO()))
    .then((saved) => {
      // Пока открыто системное меню, данные могли удалить: тогда отмечать копию не на чем.
      if (saved && state && commit({ ...state, lastBackupAt: now })) showToast('Резервная копия создана. Проверь, что файл сохранён.');
    })
    .catch(reportFileError);
}

function importInput() {
  return el('input', { type: 'file', id: 'import-file', hidden: true, onChange: onImportFile });
}

function pickBackupFile() {
  document.getElementById('import-file').click();
}

async function onImportFile(event) {
  const input = event.target;
  const [file] = input.files;
  input.value = ''; // Чтобы тот же файл можно было выбрать ещё раз.
  if (!file) return;
  if (file.size > MAX_BACKUP_CHARS * 4) {
    showToast('Файл слишком большой для резервной копии.', { error: true });
    return;
  }
  let text;
  try {
    text = await file.text();
  } catch (error) {
    showToast(`Не удалось прочитать файл: ${error.message}`, { error: true });
    return;
  }
  const parsed = attempt(() => parseBackup(text), (message) => showToast(message, { error: true }));
  if (!parsed) return;

  const count = parsed.state.transactions.length;
  const created = new Date(parsed.exportedAt);
  const future = futureTransactionCount(parsed.state, todayISO());
  const futureText = future > 0 ? ` С будущей датой: ${future}. Такие траты войдут в лимит, когда наступит их день.` : '';
  confirmSheet({
    title: 'Восстановить из копии?',
    text: `В файле ${count} ${pluralRu(count, 'трата', 'траты', 'трат')}, копия от ${formatDay(localDateISO(created))} ${created.getFullYear()}.${futureText} Всё, что сейчас есть в приложении, будет заменено.`,
    yesLabel: 'Заменить данные',
    onYes: () => {
      if (commit(parsed.state)) {
        activeTab = 'today';
        viewedMonth = null;
        render();
        requestPersistentStorage();
        showToast('Данные восстановлены.');
      }
    },
  });
}

function resetAll() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    showToast(`Не удалось удалить данные: ${error.message}`, { error: true });
    return;
  }
  state = null;
  activeTab = 'today';
  viewedMonth = null;
  showOnboarding();
}

// ---------- Запуск ----------

function boot() {
  closeSheet();
  hideToast();
  renderedDay = todayISO();
  const loaded = loadState();
  if (loaded.status === 'unavailable') {
    state = null;
    showUnavailable(loaded.detail);
  } else if (loaded.status === 'corrupt') {
    state = null;
    showCorrupt(loaded.raw, loaded.detail);
  } else if (loaded.status === 'empty') {
    state = null;
    showOnboarding();
  } else {
    state = loaded.state;
    main = null;
    render();
    requestPersistentStorage();
  }
}

function refreshIfDayChanged() {
  const today = todayISO();
  if (today === renderedDay) return;
  renderedDay = today;
  if (state) render();
  else onboardingRefresh?.();
}

/** Высота видимой части экрана и высота клавиатуры: фиксированные элементы iPhone сам не поднимает. */
function trackViewport() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const update = () => {
    const root = document.documentElement.style;
    root.setProperty('--viewport-height', `${Math.round(viewport.height)}px`);
    root.setProperty('--keyboard-inset', `${Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop))}px`);
  };
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  // После закрытия клавиатуры iOS может обновить размеры с задержкой.
  document.addEventListener('focusout', () => setTimeout(update, 350));
  update();
}

function reportOfflineProblem(reason) {
  swProblem = reason;
  console.error('Service worker:', reason);
  if (state) render();
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  // Первая смена при первой установке не обновление: на экране уже эта версия.
  let isControlled = hadController;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (isControlled) {
      updateReady = true;
      renderUpdateSlot();
    }
    isControlled = true;
    const status = document.getElementById('about-status');
    if (status) fillAboutStatus(status);
  });
  let registration;
  try {
    registration = await navigator.serviceWorker.register('sw.js');
  } catch (error) {
    reportOfflineProblem(error.message);
    return;
  }
  const firstInstall = hadController ? null : registration.installing ?? registration.waiting;
  firstInstall?.addEventListener('statechange', () => {
    if (firstInstall.state === 'redundant' && !navigator.serviceWorker.controller) {
      reportOfflineProblem('не все файлы приложения загрузились');
    }
  });
  document.addEventListener('visibilitychange', () => {
    // Без интернета проверка обновления просто не удаётся, и это нормально.
    if (document.visibilityState === 'visible' && navigator.onLine) registration.update().catch(() => {});
  });
}

window.addEventListener('storage', (event) => {
  if (event.key === STORAGE_KEY || event.key === null) boot();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshIfDayChanged();
});
window.addEventListener('pageshow', refreshIfDayChanged);
setInterval(refreshIfDayChanged, 30_000);

trackViewport();
boot();
window.budgetBoot?.started();
registerServiceWorker();
