// Логика бюджета. Здесь нет DOM, сети и чтения часов: всё приходит параметрами,
// поэтому каждую формулу можно проверить тестом.
// Деньги везде хранятся в целых центах, чтобы не копить ошибки округления.

export const SCHEMA_VERSION = 2;
export const BACKUP_APP = 'daily-budget';
export const MAX_CENTS = 10_000_000_000; // 100 млн €
export const MAX_NOTE_LENGTH = 200;
export const MAX_CATEGORY_NAME_LENGTH = 30;
export const MAX_CATEGORIES = 100;
export const MAX_TRANSACTIONS = 200_000;
export const MAX_BACKUP_CHARS = 10_000_000;
export const MIN_YEAR = 2000;
export const MAX_YEAR = 2100;
export const UNCATEGORIZED = 'Без категории';
export const MAX_TIMESTAMP = Date.UTC(MAX_YEAR + 1, 0, 1);

const DAY_MS = 86_400_000;
export const BACKUP_REMINDER_DAYS = 30;

const MONTHS_NOMINATIVE = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

const DEFAULT_CATEGORIES = [
  { id: 'c-food', name: 'Еда' },
  { id: 'c-transport', name: 'Транспорт' },
  { id: 'c-small', name: 'Мелкие траты' },
];

/** Ошибка, которую можно показать пользователю как есть. */
export class BudgetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BudgetError';
  }
}

// ---------- Даты (только строки YYYY-MM-DD и YYYY-MM, без часовых поясов) ----------

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const pad2 = (n) => String(n).padStart(2, '0');

export function isValidMonth(ym) {
  if (typeof ym !== 'string') return false;
  const match = MONTH_RE.exec(ym);
  if (!match) return false;
  const year = Number(match[1]);
  return year >= MIN_YEAR && year <= MAX_YEAR;
}

export function daysInMonth(ym) {
  const [year, month] = ym.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isValidDate(iso) {
  if (typeof iso !== 'string' || !DATE_RE.test(iso)) return false;
  const ym = iso.slice(0, 7);
  return isValidMonth(ym) && Number(iso.slice(8)) <= daysInMonth(ym);
}

export const monthOf = (iso) => iso.slice(0, 7);
export const dayOf = (iso) => Number(iso.slice(8));

export function addMonths(ym, delta) {
  const [year, month] = ym.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}`;
}

export function addDays(iso, delta) {
  const [year, month, day] = iso.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + delta));
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/** Сегодняшняя дата по местному времени телефона (не UTC). */
export function localDateISO(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

// ---------- Форматирование ----------

export function moneyParts(cents) {
  const abs = Math.abs(cents);
  const euros = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return {
    sign: cents < 0 ? '−' : '',
    int: euros,
    frac: String(abs % 100).padStart(2, '0'),
  };
}

export function formatMoney(cents) {
  const { sign, int, frac } = moneyParts(cents);
  return `${sign}${int},${frac} €`;
}

/** Значение для поля ввода: 1250 → «12,50», 1200 → «12». */
export function centsToInput(cents) {
  const euros = Math.floor(cents / 100);
  const rest = cents % 100;
  return rest === 0 ? String(euros) : `${euros},${String(rest).padStart(2, '0')}`;
}

export function formatMonth(ym) {
  const [year, month] = ym.split('-').map(Number);
  return `${MONTHS_NOMINATIVE[month - 1]} ${year}`;
}

export function formatFullDate(iso) {
  return `${formatDay(iso)} ${iso.slice(0, 4)}`;
}

export function formatDay(iso) {
  const month = Number(iso.slice(5, 7));
  return `${dayOf(iso)} ${MONTHS_GENITIVE[month - 1]}`;
}

/** Дата с годом, если год отличается от опорной даты: долг на год не должен выглядеть как долг на неделю. */
export function formatDayNear(iso, referenceIso) {
  return iso.slice(0, 4) === referenceIso.slice(0, 4) ? formatDay(iso) : `${formatDay(iso)} ${iso.slice(0, 4)}`;
}

export function weekdayShort(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return WEEKDAYS_SHORT[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

export function pluralRu(n, one, few, many) {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

// ---------- Разбор суммы ----------

/**
 * Принимает «12», «12,5», «12.50», «1 000,50», «12,». Отвечает ошибкой, а не догадкой:
 * «1,000» или «1.000,50» — неоднозначные записи, их программа не угадывает.
 */
export function parseMoney(input) {
  const cleaned = String(input ?? '').replace(/[\s  ]/g, '').replace(/€$/, '');
  if (cleaned === '') throw new BudgetError('Введи сумму.');
  const match = /^(\d*)(?:[.,](\d{0,2}))?$/.exec(cleaned);
  if (!match || (match[1] === '' && !match[2])) {
    throw new BudgetError('Сумма записана неверно. Пример: 12,50');
  }
  const euros = match[1] === '' ? 0 : Number(match[1]);
  const cents = Number((match[2] ?? '').padEnd(2, '0'));
  const total = euros * 100 + cents;
  if (!Number.isSafeInteger(total) || total > MAX_CENTS) {
    throw new BudgetError('Слишком большая сумма.');
  }
  return total;
}

export function parseAmount(input) {
  const cents = parseMoney(input);
  if (cents <= 0) throw new BudgetError('Сумма должна быть больше нуля.');
  return cents;
}

// ---------- Состояние ----------

function assertBudgetCents(cents) {
  if (!Number.isInteger(cents) || cents < 0 || cents > MAX_CENTS) {
    throw new BudgetError('Неверная сумма бюджета.');
  }
}

/** Дата начала учёта: любой день текущего месяца, но не позже сегодня. */
export function validateStartDate(date, today) {
  if (!isValidDate(today)) throw new BudgetError('На телефоне неверная дата.');
  if (!isValidDate(date)) throw new BudgetError('Выбери дату.');
  if (monthOf(date) !== monthOf(today)) throw new BudgetError('Выбери дату в текущем месяце.');
  if (date > today) throw new BudgetError('Дата начала не может быть в будущем.');
}

export function createInitialState(startDate, budgetCents) {
  if (!isValidDate(startDate)) throw new BudgetError('На телефоне неверная дата.');
  assertBudgetCents(budgetCents);
  return {
    version: SCHEMA_VERSION,
    startDate,
    budgets: { [monthOf(startDate)]: budgetCents },
    categories: DEFAULT_CATEGORIES.map((category) => ({ ...category })),
    transactions: [],
    lastBackupAt: null,
  };
}

export function startMonth(state) {
  return monthOf(state.startDate);
}

/**
 * Меняет дату начала, пока идёт первый месяц учёта. Траты раньше новой даты выпали бы
 * из расчёта, поэтому такая дата отклоняется.
 */
export function setStartDate(state, date, today) {
  validateStartDate(date, today);
  if (monthOf(today) !== startMonth(state)) {
    throw new BudgetError('Дату начала можно менять только в первый месяц учёта.');
  }
  const earliest = state.transactions.reduce((first, t) => (t.date < first ? t.date : first), date);
  if (earliest < date) {
    throw new BudgetError(`Есть трата за ${formatDay(earliest)}. Дату начала нельзя поставить позже неё.`);
  }
  return { ...state, startDate: date };
}

/** Сумма месяца: своя или ближайшая предыдущая (новый месяц наследует прошлую сумму). */
export function budgetFor(state, ym) {
  let best = null;
  for (const key of Object.keys(state.budgets)) {
    if (key <= ym && (best === null || key > best)) best = key;
  }
  if (best === null) throw new Error(`Месяц ${ym} раньше начала учёта`);
  return state.budgets[best];
}

/**
 * Меняет сумму месяца. Новая сумма наследуется дальше только при правке текущего месяца.
 * При правке другого месяца следующий сохраняет прежнюю сумму, иначе правка незаметно
 * изменила бы все унаследованные суммы после него.
 */
export function setBudget(state, ym, cents, currentMonth) {
  assertBudgetCents(cents);
  if (!isValidMonth(ym) || ym < startMonth(state)) {
    throw new BudgetError('Этот месяц раньше начала учёта.');
  }
  const budgets = { ...state.budgets };
  if (ym !== currentMonth) {
    const next = addMonths(ym, 1);
    if (isValidMonth(next) && !Object.hasOwn(budgets, next)) budgets[next] = budgetFor(state, next);
  }
  budgets[ym] = cents;
  return { ...state, budgets };
}

function normalizeTransactionInput(state, { date, amount, categoryId, note }, today, existingDate = null) {
  if (!isValidDate(date)) throw new BudgetError('Выбери дату.');
  // Уже записанную будущую дату (смена часового пояса, импорт) можно оставить при правке суммы.
  if (date > today && date !== existingDate) throw new BudgetError('Дата не может быть в будущем.');
  if (date < state.startDate) {
    throw new BudgetError(`Учёт начат с ${formatFullDate(state.startDate)}. Более ранние траты записать нельзя.`);
  }
  if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_CENTS) {
    throw new BudgetError('Неверная сумма.');
  }
  const normalizedCategory = categoryId ?? null;
  if (normalizedCategory !== null && !state.categories.some((c) => c.id === normalizedCategory)) {
    throw new BudgetError('Такой категории больше нет.');
  }
  const normalizedNote = String(note ?? '').trim();
  if (normalizedNote.length > MAX_NOTE_LENGTH) {
    throw new BudgetError(`Заметка длиннее ${MAX_NOTE_LENGTH} символов.`);
  }
  return { date, amount, categoryId: normalizedCategory, note: normalizedNote };
}

export function addTransaction(state, { id, createdAt, ...fields }, today) {
  if (state.transactions.length >= MAX_TRANSACTIONS) {
    throw new BudgetError('Слишком много записей.');
  }
  const normalized = normalizeTransactionInput(state, fields, today);
  return {
    ...state,
    transactions: [...state.transactions, { id, createdAt, ...normalized }],
  };
}

export function updateTransaction(state, id, fields, today) {
  const existing = state.transactions.find((t) => t.id === id);
  if (!existing) throw new BudgetError('Этой траты больше нет.');
  const normalized = normalizeTransactionInput(state, fields, today, existing.date);
  return {
    ...state,
    transactions: state.transactions.map((t) => (t.id === id ? { ...t, ...normalized } : t)),
  };
}

export function deleteTransaction(state, id) {
  if (!state.transactions.some((t) => t.id === id)) {
    throw new BudgetError('Этой траты больше нет.');
  }
  return { ...state, transactions: state.transactions.filter((t) => t.id !== id) };
}

// Эмодзи-флаг вроде флага Англии состоит из чёрного флага и невидимых символов-тегов: их нужно сохранить.
const BLACK_FLAG = '\u{1F3F4}';
const FLAG_OR_INVISIBLE = /\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]+\u{E007F}|[\p{Cc}\p{Cf}\u2800]/gu;
const FLAG_OR_IGNORABLE = /\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]+\u{E007F}|\p{Default_Ignorable_Code_Point}/gu;
const keepFlag = (match) => (match.startsWith(BLACK_FLAG) ? match : '');

// Сравнение без учёта регистра, формы записи Unicode и невидимых символов.
const nameKey = (name) => name.replace(FLAG_OR_IGNORABLE, keepFlag).normalize('NFC').toLocaleLowerCase('ru');

/** Убирает управляющие и невидимые символы: они дают пустые кнопки и имена-двойники. Соединитель эмодзи остаётся. */
export function cleanCategoryName(raw) {
  // Повтор до неизменности: после удаления символа буква и знак могут соединиться,
  // а проверка при чтении данных требует, чтобы очистка уже очищенного имени ничего не меняла.
  let name = String(raw ?? '');
  for (;;) {
    const next = name
      .replace(/\s+/g, ' ')
      .replace(FLAG_OR_INVISIBLE, (match) => (match === '\u200D' ? match : keepFlag(match)))
      .normalize('NFC')
      .replace(/ {2,}/g, ' ')
      .trim();
    if (next === name) return name;
    name = next;
  }
}

const hasVisibleCharacter = (name) => /[\p{L}\p{N}\p{P}\p{S}]/u.test(name.replace(/\p{Default_Ignorable_Code_Point}/gu, ''));

function normalizeCategoryName(state, rawName, ownId = null) {
  const name = cleanCategoryName(rawName);
  if (!hasVisibleCharacter(name)) throw new BudgetError('Введи название категории.');
  if (name.length > MAX_CATEGORY_NAME_LENGTH) {
    throw new BudgetError(`Название длиннее ${MAX_CATEGORY_NAME_LENGTH} символов.`);
  }
  if (nameKey(name) === nameKey(UNCATEGORIZED)) {
    throw new BudgetError(`Название «${UNCATEGORIZED}» занято.`);
  }
  if (state.categories.some((c) => c.id !== ownId && nameKey(c.name) === nameKey(name))) {
    throw new BudgetError('Такая категория уже есть.');
  }
  return name;
}

export function addCategory(state, id, rawName) {
  if (state.categories.length >= MAX_CATEGORIES) {
    throw new BudgetError(`Категорий не может быть больше ${MAX_CATEGORIES}.`);
  }
  const name = normalizeCategoryName(state, rawName);
  return { ...state, categories: [...state.categories, { id, name }] };
}

export function renameCategory(state, id, rawName) {
  if (!state.categories.some((c) => c.id === id)) throw new BudgetError('Такой категории больше нет.');
  const name = normalizeCategoryName(state, rawName, id);
  return {
    ...state,
    categories: state.categories.map((c) => (c.id === id ? { ...c, name } : c)),
  };
}

/** Траты удалённой категории не исчезают, а переходят в «Без категории». */
export function deleteCategory(state, id) {
  if (!state.categories.some((c) => c.id === id)) throw new BudgetError('Такой категории больше нет.');
  return {
    ...state,
    categories: state.categories.filter((c) => c.id !== id),
    transactions: state.transactions.map((t) => (t.categoryId === id ? { ...t, categoryId: null } : t)),
  };
}

export function categoryUsage(state, id) {
  return state.transactions.reduce((count, t) => count + (t.categoryId === id ? 1 : 0), 0);
}

// ---------- Расчёты ----------

function spentByMonth(state) {
  const totals = new Map();
  for (const t of state.transactions) {
    const ym = monthOf(t.date);
    totals.set(ym, (totals.get(ym) ?? 0) + t.amount);
  }
  return totals;
}

/** Дни месяца, на которые делится бюджет: в первый месяц только с даты начала. */
function planFor(state, ym) {
  const first = ym === startMonth(state) ? dayOf(state.startDate) : 1;
  return { first, count: daysInMonth(ym) - first + 1 };
}

/** Сколько набежало к концу дня day: последний день месяца всегда даёт весь бюджет ровно. */
const accrued = (budget, day, plan) => (day < plan.first ? 0 : Math.round((budget * (day - plan.first + 1)) / plan.count));

/** Остаток (+) или долг (−), пришедший из прошлых месяцев. */
export function carryInto(state, ym) {
  const totals = spentByMonth(state);
  let carry = 0;
  for (let m = startMonth(state); m < ym; m = addMonths(m, 1)) {
    carry += budgetFor(state, m) - (totals.get(m) ?? 0);
  }
  return carry;
}

/**
 * Главная формула:
 * доступно сегодня = перенос + бюджет × (прошло дней учёта / дней учёта в месяце) − всё потраченное по сегодня.
 * Обычно дней учёта столько же, сколько дней в месяце; в первый месяц они считаются с даты начала.
 */
export function dayView(state, today) {
  const month = monthOf(today);
  if (today < state.startDate) {
    return { beforeStart: true, date: today, month, startDate: state.startDate };
  }
  const day = dayOf(today);
  const plan = planFor(state, month);
  const days = plan.count;
  const budget = budgetFor(state, month);
  const carry = carryInto(state, month);
  let spentToday = 0;
  let spentToDate = 0;
  let spentMonth = 0;
  for (const t of state.transactions) {
    if (monthOf(t.date) !== month) continue;
    spentMonth += t.amount;
    if (t.date <= today) spentToDate += t.amount;
    if (t.date === today) spentToday += t.amount;
  }
  const availableToday = carry + accrued(budget, day, plan) - spentToDate;
  return {
    beforeStart: false,
    date: today,
    month,
    day,
    days,
    budget,
    normDay: Math.round(budget / days),
    carry,
    spentToday,
    spentMonth,
    availableToday,
    limitToday: availableToday + spentToday,
    remainingMonth: carry + budget - spentMonth,
  };
}

/**
 * Первый день, когда лимит снова станет больше нуля, если больше ничего не тратить.
 * null — лимит и так не в минусе или минус не закроется в ближайшие два года (например, бюджет 0).
 */
export function recoveryDate(state, today) {
  const view = dayView(state, today);
  if (view.beforeStart || view.availableToday >= 0) return null;
  const laterSpending = new Map();
  for (const t of state.transactions) {
    if (t.date > today) laterSpending.set(t.date, (laterSpending.get(t.date) ?? 0) + t.amount);
  }
  let balance = view.availableToday;
  let date = today;
  for (let i = 0; i < 732; i += 1) {
    date = addDays(date, 1);
    const month = monthOf(date);
    const day = dayOf(date);
    const plan = planFor(state, month);
    const budget = budgetFor(state, month);
    balance += accrued(budget, day, plan) - accrued(budget, day - 1, plan);
    balance -= laterSpending.get(date) ?? 0;
    if (balance > 0) return date;
  }
  return null;
}

const newestFirst = (a, b) =>
  b.date.localeCompare(a.date) || b.createdAt - a.createdAt || b.id.localeCompare(a.id);

/** Сводка месяца: итоги, расходы по категориям и траты, сгруппированные по дням. */
export function monthView(state, ym) {
  const names = new Map(state.categories.map((c) => [c.id, c.name]));
  const items = state.transactions.filter((t) => monthOf(t.date) === ym).sort(newestFirst);
  const spent = items.reduce((sum, t) => sum + t.amount, 0);

  const byCategory = new Map();
  for (const t of items) byCategory.set(t.categoryId, (byCategory.get(t.categoryId) ?? 0) + t.amount);
  const categories = [...byCategory.entries()]
    .map(([categoryId, amount]) => ({
      categoryId,
      name: categoryId === null ? UNCATEGORIZED : names.get(categoryId),
      amount,
      share: spent === 0 ? 0 : amount / spent,
    }))
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'ru'));

  const dayGroups = [];
  for (const t of items) {
    let group = dayGroups[dayGroups.length - 1];
    if (!group || group.date !== t.date) {
      group = { date: t.date, total: 0, items: [] };
      dayGroups.push(group);
    }
    group.total += t.amount;
    group.items.push(t);
  }

  const beforeStart = ym < startMonth(state);
  const budget = beforeStart ? 0 : budgetFor(state, ym);
  const carry = beforeStart ? 0 : carryInto(state, ym);
  const days = beforeStart ? daysInMonth(ym) : planFor(state, ym).count;
  return {
    month: ym,
    days,
    budget,
    carry,
    spent,
    normDay: Math.round(budget / days),
    remaining: carry + budget - spent,
    categories,
    dayGroups,
  };
}

export function transactionsOn(state, date) {
  return state.transactions.filter((t) => t.date === date).sort(newestFirst);
}

/** Последний месяц, который есть смысл показывать в истории. */
export function futureTransactionCount(state, today) {
  return state.transactions.reduce((count, t) => count + (t.date > today ? 1 : 0), 0);
}

export function latestMonth(state, currentMonth) {
  const first = startMonth(state);
  let latest = currentMonth > first ? currentMonth : first;
  for (const t of state.transactions) {
    const ym = monthOf(t.date);
    if (ym > latest) latest = ym;
  }
  return latest;
}

/** Пора ли напомнить о резервной копии: данные только на телефоне, потерять их легко. */
export function backupReminderDue(state, nowMs) {
  if (state.transactions.length === 0) return false;
  let reference = state.lastBackupAt;
  if (reference === null) {
    reference = state.transactions.reduce((oldest, t) => Math.min(oldest, t.createdAt), Infinity);
  }
  // Дата из будущего (часы переводили назад, такой файл) не должна отключать напоминание.
  return reference > nowMs || nowMs - reference >= BACKUP_REMINDER_DAYS * DAY_MS;
}

// ---------- Проверка данных и резервные копии ----------

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCentsInRange = (value, min) => Number.isInteger(value) && value >= min && value <= MAX_CENTS;
const isValidTimestamp = (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP;

/**
 * Строгая проверка всего состояния: и при чтении из памяти телефона, и при импорте файла.
 * Возвращает новый объект только с известными полями; при любом нарушении бросает ошибку,
 * а не подставляет значения по умолчанию.
 */
export function validateState(raw) {
  const fail = (detail) => {
    throw new BudgetError(`Данные повреждены: ${detail}.`);
  };
  if (!isPlainObject(raw)) fail('ожидался объект');
  if (raw.version !== SCHEMA_VERSION && raw.version !== 1) {
    if (Number.isInteger(raw.version) && raw.version > SCHEMA_VERSION) {
      throw new BudgetError('Данные созданы более новой версией приложения. Обнови приложение.');
    }
    fail('неизвестная версия');
  }

  if (!isPlainObject(raw.budgets)) fail('нет бюджетов');
  const budgets = {};
  for (const [month, cents] of Object.entries(raw.budgets)) {
    if (!isValidMonth(month)) fail(`неверный месяц «${String(month).slice(0, 20)}»`);
    if (!isCentsInRange(cents, 0)) fail(`неверный бюджет за ${month}`);
    budgets[month] = cents;
  }
  const firstMonth = Object.keys(budgets).sort()[0];
  if (!firstMonth) fail('нет ни одного бюджета');

  // В версии 1 даты начала не было: расчёт всегда шёл с 1-го числа первого месяца.
  const startDate = raw.version === 1 ? `${firstMonth}-01` : raw.startDate;
  if (!isValidDate(startDate)) fail('неверная дата начала');
  if (monthOf(startDate) !== firstMonth) fail('дата начала не совпадает с первым бюджетом');

  if (!Array.isArray(raw.categories)) fail('нет списка категорий');
  if (raw.categories.length > MAX_CATEGORIES) fail('слишком много категорий');
  const categoryIds = new Set();
  const categoryNames = new Set([nameKey(UNCATEGORIZED)]);
  const categories = raw.categories.map((c) => {
    if (!isPlainObject(c) || typeof c.id !== 'string' || c.id === '' || c.id.length > 64) fail('неверная категория');
    if (categoryIds.has(c.id)) fail('повторяется категория');
    if (typeof c.name !== 'string' || cleanCategoryName(c.name) !== c.name || !hasVisibleCharacter(c.name) || c.name.length > MAX_CATEGORY_NAME_LENGTH) {
      fail('неверное название категории');
    }
    if (categoryNames.has(nameKey(c.name))) fail('повторяется название категории');
    categoryIds.add(c.id);
    categoryNames.add(nameKey(c.name));
    return { id: c.id, name: c.name };
  });

  if (!Array.isArray(raw.transactions)) fail('нет списка трат');
  if (raw.transactions.length > MAX_TRANSACTIONS) fail('слишком много трат');
  const transactionIds = new Set();
  const transactions = raw.transactions.map((t) => {
    if (!isPlainObject(t) || typeof t.id !== 'string' || t.id === '' || t.id.length > 64) fail('неверная трата');
    if (transactionIds.has(t.id)) fail('повторяется трата');
    transactionIds.add(t.id);
    if (!isValidDate(t.date)) fail('неверная дата траты');
    if (t.date < startDate) fail('трата раньше начала учёта');
    if (!isCentsInRange(t.amount, 1)) fail('неверная сумма траты');
    if (t.categoryId !== null && !categoryIds.has(t.categoryId)) fail('трата ссылается на несуществующую категорию');
    if (typeof t.note !== 'string' || t.note.length > MAX_NOTE_LENGTH) fail('неверная заметка');
    if (!isValidTimestamp(t.createdAt)) fail('неверное время создания');
    return { id: t.id, date: t.date, amount: t.amount, categoryId: t.categoryId, note: t.note, createdAt: t.createdAt };
  });

  const lastBackupAt = raw.lastBackupAt;
  if (lastBackupAt !== null && !isValidTimestamp(lastBackupAt)) fail('неверная дата резервной копии');

  return { version: SCHEMA_VERSION, startDate, budgets, categories, transactions, lastBackupAt };
}

export function serializeBackup(state, nowMs) {
  return JSON.stringify({ app: BACKUP_APP, exportedAt: nowMs, data: state }, null, 1);
}

export function parseBackup(text) {
  if (typeof text !== 'string' || text.length > MAX_BACKUP_CHARS) {
    throw new BudgetError('Файл слишком большой для резервной копии.');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BudgetError('Это не файл резервной копии: не удалось прочитать содержимое.');
  }
  if (!isPlainObject(parsed) || parsed.app !== BACKUP_APP) {
    throw new BudgetError('Это не файл резервной копии этого приложения.');
  }
  if (!isValidTimestamp(parsed.exportedAt)) throw new BudgetError('В файле неверная дата создания копии.');
  const state = validateState(parsed.data);
  return { state: { ...state, lastBackupAt: parsed.exportedAt }, exportedAt: parsed.exportedAt };
}

export function backupFilename(today) {
  return `budget-backup-${today}.json`;
}
