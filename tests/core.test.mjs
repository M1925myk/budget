import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BudgetError,
  MAX_CENTS,
  UNCATEGORIZED,
  addCategory,
  addDays,
  addMonths,
  addTransaction,
  MAX_TIMESTAMP,
  backupReminderDue,
  budgetFor,
  carryInto,
  categoryUsage,
  centsToInput,
  cleanCategoryName,
  createInitialState,
  dayView,
  daysInMonth,
  deleteCategory,
  deleteTransaction,
  formatDay,
  formatDayNear,
  formatMoney,
  formatMonth,
  formatMonthGenitive,
  futureTransactionCount,
  isValidDate,
  isValidMonth,
  latestMonth,
  localDateISO,
  monthView,
  parseAmount,
  parseBackup,
  parseMoney,
  pluralRu,
  recoveryDate,
  renameCategory,
  serializeBackup,
  setBudget,
  startMonth,
  transactionsOn,
  updateTransaction,
  validateState,
  weekdayShort,
} from '../docs/core.js';

let nextId = 0;
const spend = (state, date, amount, extra = {}) =>
  addTransaction(
    state,
    { id: `t${(nextId += 1)}`, createdAt: nextId, date, amount, categoryId: null, note: '', ...extra },
    '2100-12-31',
  );

const eur = (euros) => Math.round(euros * 100);

describe('примеры из обсуждения', () => {
  const november = () => createInitialState('2026-11', eur(660));

  test('660 € / 30 дней = 22 € в первый день', () => {
    const view = dayView(november(), '2026-11-01');
    assert.equal(view.normDay, eur(22));
    assert.equal(view.availableToday, eur(22));
  });

  test('из 22 € потрачено 10 €: на следующий день 34 €', () => {
    const state = spend(november(), '2026-11-01', eur(10));
    assert.equal(dayView(state, '2026-11-01').availableToday, eur(12));
    assert.equal(dayView(state, '2026-11-02').availableToday, eur(34));
  });

  test('100 € в первый день: −56, −34, −12, затем +10', () => {
    const state = spend(november(), '2026-11-01', eur(100));
    assert.equal(dayView(state, '2026-11-02').availableToday, eur(-56));
    assert.equal(dayView(state, '2026-11-03').availableToday, eur(-34));
    assert.equal(dayView(state, '2026-11-04').availableToday, eur(-12));
    assert.equal(dayView(state, '2026-11-05').availableToday, eur(10));
    assert.equal(recoveryDate(state, '2026-11-02'), '2026-11-05');
  });

  test('старт 15 ноября: сразу 330 €, при 22 € в день к концу остаётся 308 €', () => {
    let state = november();
    assert.equal(dayView(state, '2026-11-15').availableToday, eur(330));
    for (let day = 15; day <= 30; day += 1) state = spend(state, `2026-11-${day}`, eur(22));
    assert.equal(dayView(state, '2026-11-30').remainingMonth, eur(308));
    assert.equal(dayView(state, '2026-11-30').availableToday, eur(308));
  });

  test('остаток +50 € переносится на первый день: 72 €', () => {
    const state = spend(november(), '2026-11-30', eur(610));
    assert.equal(dayView(state, '2026-11-30').remainingMonth, eur(50));
    const december = setBudget(state, '2026-12', eur(660), '2026-12');
    // В декабре 31 день, поэтому возьмём 30-дневный месяц для точного примера из обсуждения.
    assert.equal(carryInto(december, '2026-12'), eur(50));
    const fromApril = spend(createInitialState('2027-03', eur(660)), '2027-03-31', eur(610));
    const april = setBudget(fromApril, '2027-04', eur(660), '2027-04');
    assert.equal(dayView(april, '2027-04-01').availableToday, eur(72));
    assert.equal(dayView(april, '2027-04-01').remainingMonth, eur(710));
  });

  test('долг 30 € переносится на первый день: −8 €, на месяц 630 €', () => {
    const state = spend(createInitialState('2027-03', eur(660)), '2027-03-31', eur(690));
    const april = setBudget(state, '2027-04', eur(660), '2027-04');
    assert.equal(dayView(april, '2027-04-01').availableToday, eur(-8));
    assert.equal(dayView(april, '2027-04-01').remainingMonth, eur(630));
  });

  test('бюджет 660 → 800 € 20 ноября: лимит сразу +93,33 €', () => {
    const before = dayView(november(), '2026-11-20').availableToday;
    const changed = setBudget(november(), '2026-11', eur(800), '2026-11');
    const after = dayView(changed, '2026-11-20').availableToday;
    assert.equal(after - before, 9333);
  });
});

describe('даты', () => {
  test('длина месяцев, включая високосный февраль', () => {
    assert.equal(daysInMonth('2026-11'), 30);
    assert.equal(daysInMonth('2026-12'), 31);
    assert.equal(daysInMonth('2026-02'), 28);
    assert.equal(daysInMonth('2028-02'), 29);
    assert.equal(daysInMonth('2100-02'), 28);
    assert.equal(daysInMonth('2000-02'), 29);
  });

  test('проверка дат и месяцев', () => {
    for (const good of ['2026-11-02', '2028-02-29', '2026-12-31']) assert.ok(isValidDate(good), good);
    for (const bad of ['2026-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '26-11-02', '2026-11-2', '', null, 20261102, '2026-11-02T00:00', '1999-01-01']) {
      assert.equal(isValidDate(bad), false, String(bad));
    }
    assert.ok(isValidMonth('2026-11'));
    for (const bad of ['2026-13', '2026-1', 'abcd-ef', '__proto__', '1999-12', '2101-01']) {
      assert.equal(isValidMonth(bad), false, bad);
    }
  });

  test('сдвиг месяцев и дней через границы года', () => {
    assert.equal(addMonths('2026-12', 1), '2027-01');
    assert.equal(addMonths('2027-01', -1), '2026-12');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2028-02-28', 1), '2028-02-29');
    assert.equal(addDays('2028-03-01', -1), '2028-02-29');
  });

  test('дата берётся по местному времени, а не по UTC', () => {
    assert.equal(localDateISO(new Date(2026, 10, 2, 23, 59, 59)), '2026-11-02');
    assert.equal(localDateISO(new Date(2026, 10, 3, 0, 0, 0)), '2026-11-03');
  });

  test('русские названия', () => {
    assert.equal(formatMonth('2026-11'), 'ноябрь 2026');
    assert.equal(formatDay('2026-11-02'), '2 ноября');
    assert.equal(formatMonthGenitive('2026-11'), 'ноября 2026');
    assert.equal(formatDayNear('2026-11-05', '2026-11-01'), '5 ноября');
    assert.equal(formatDayNear('2027-11-04', '2026-11-05'), '4 ноября 2027');
    assert.equal(weekdayShort('2026-11-02'), 'пн');
    assert.equal(pluralRu(1, 'трата', 'траты', 'трат'), 'трата');
    assert.equal(pluralRu(3, 'трата', 'траты', 'трат'), 'траты');
    assert.equal(pluralRu(11, 'трата', 'траты', 'трат'), 'трат');
    assert.equal(pluralRu(21, 'трата', 'траты', 'трат'), 'трата');
    assert.equal(pluralRu(112, 'трата', 'траты', 'трат'), 'трат');
  });
});

describe('разбор и вывод денег', () => {
  const cases = [
    ['12', 1200],
    ['12,5', 1250],
    ['12.50', 1250],
    ['12,', 1200],
    [',5', 50],
    ['.05', 5],
    ['0,01', 1],
    ['1 000,50', 100050],
    ['1 000', 100000],
    ['  7 ', 700],
    ['12 €', 1200],
    ['19,99', 1999],
    ['0.07', 7],
    ['1.10', 110],
    ['4.35', 435],
  ];
  for (const [input, expected] of cases) {
    test(`«${input}» → ${expected}`, () => assert.equal(parseMoney(input), expected));
  }

  for (const bad of ['', ' ', ',', '.', 'abc', '12,345', '1,000', '1.000,50', '-5', '+5', '1e3', '12,5,1', '٣', 'Infinity', '0x10']) {
    test(`«${bad}» отклоняется, а не угадывается`, () => {
      assert.throws(() => parseMoney(bad), BudgetError);
    });
  }

  test('слишком большие суммы отклоняются', () => {
    assert.equal(parseMoney('100000000'), MAX_CENTS);
    assert.throws(() => parseMoney('100000000,01'), BudgetError);
    assert.throws(() => parseMoney('9'.repeat(400)), BudgetError);
  });

  test('трата не может быть нулевой, бюджет может', () => {
    assert.throws(() => parseAmount('0'), BudgetError);
    assert.throws(() => parseAmount('0,00'), BudgetError);
    assert.equal(parseMoney('0'), 0);
  });

  test('вывод', () => {
    assert.equal(formatMoney(2200), '22,00 €');
    assert.equal(formatMoney(-5600), '−56,00 €');
    assert.equal(formatMoney(123456789), '1 234 567,89 €');
    assert.equal(formatMoney(5), '0,05 €');
    assert.equal(formatMoney(0), '0,00 €');
    assert.equal(formatMoney(-0), '0,00 €');
    assert.equal(centsToInput(1250), '12,50');
    assert.equal(centsToInput(1200), '12');
    assert.equal(centsToInput(1205), '12,05');
    assert.equal(parseMoney(centsToInput(1205)), 1205);
  });
});

describe('расчёт лимита', () => {
  test('месяц без ровного деления: последний день даёт весь бюджет без потери центов', () => {
    const state = createInitialState('2026-12', eur(660));
    assert.equal(dayView(state, '2026-12-01').availableToday, 2129);
    assert.equal(dayView(state, '2026-12-02').availableToday, 4258);
    assert.equal(dayView(state, '2026-12-31').availableToday, eur(660));
    assert.equal(dayView(state, '2026-12-31').normDay, 2129);
  });

  test('февраль: 28 и 29 дней', () => {
    const regular = createInitialState('2027-02', eur(280));
    assert.equal(dayView(regular, '2027-02-01').availableToday, eur(10));
    assert.equal(dayView(regular, '2027-02-28').availableToday, eur(280));
    const leap = createInitialState('2028-02', eur(290));
    assert.equal(dayView(leap, '2028-02-01').availableToday, eur(10));
    assert.equal(dayView(leap, '2028-02-29').availableToday, eur(290));
  });

  test('бюджет наследуется, пока его не изменят', () => {
    let state = createInitialState('2026-11', eur(660));
    assert.equal(budgetFor(state, '2026-12'), eur(660));
    assert.equal(budgetFor(state, '2027-06'), eur(660));
    state = setBudget(state, '2026-12', eur(500), '2026-12');
    assert.equal(budgetFor(state, '2026-11'), eur(660));
    assert.equal(budgetFor(state, '2026-12'), eur(500));
    assert.equal(budgetFor(state, '2027-01'), eur(500));
  });

  test('правка прошлого месяца не меняет следующие унаследованные суммы', () => {
    let state = createInitialState('2026-09', eur(660));
    state = setBudget(state, '2026-09', eur(500), '2026-11');
    assert.equal(budgetFor(state, '2026-09'), eur(500));
    assert.equal(budgetFor(state, '2026-10'), eur(660));
    assert.equal(budgetFor(state, '2026-11'), eur(660));
    assert.equal(carryInto(state, '2026-11'), eur(500) + eur(660));
  });

  test('правка текущего месяца наследуется дальше', () => {
    const state = setBudget(createInitialState('2026-11', eur(660)), '2026-11', eur(800), '2026-11');
    assert.equal(budgetFor(state, '2026-12'), eur(800));
  });

  test('правка месяца после текущего не меняет суммы следующих', () => {
    const state = setBudget(createInitialState('2026-11', eur(660)), '2026-12', eur(100), '2026-11');
    assert.equal(budgetFor(state, '2026-12'), eur(100));
    assert.equal(budgetFor(state, '2027-01'), eur(660));
    assert.equal(budgetFor(state, '2026-11'), eur(660));
  });

  test('правка последнего допустимого месяца не создаёт недопустимый следующий', () => {
    const state = setBudget(createInitialState('2100-11', eur(660)), '2100-12', eur(100), '2100-11');
    assert.deepEqual(Object.keys(state.budgets).sort(), ['2100-11', '2100-12']);
    assert.doesNotThrow(() => validateState(JSON.parse(JSON.stringify(state))));
  });

  test('нельзя поставить бюджет раньше начала учёта', () => {
    const state = createInitialState('2026-11', eur(660));
    assert.throws(() => setBudget(state, '2026-10', eur(1), '2026-11'), BudgetError);
  });

  test('ноль в бюджете допустим и не ломает деление', () => {
    const state = spend(createInitialState('2026-11', 0), '2026-11-01', eur(5));
    assert.equal(dayView(state, '2026-11-01').availableToday, eur(-5));
    assert.equal(dayView(state, '2026-11-30').availableToday, eur(-5));
    assert.equal(recoveryDate(state, '2026-11-01'), null);
  });

  test('дата раньше начала учёта не роняет расчёт', () => {
    const state = createInitialState('2026-11', eur(660));
    const view = dayView(state, '2026-10-15');
    assert.equal(view.beforeStart, true);
    assert.equal(view.startMonth, '2026-11');
  });

  test('запись задним числом сразу уменьшает сегодняшний лимит', () => {
    const state = spend(createInitialState('2026-11', eur(660)), '2026-11-01', eur(7));
    assert.equal(dayView(state, '2026-11-03').availableToday, eur(66 - 7));
    assert.equal(dayView(state, '2026-11-03').spentToday, 0);
  });

  test('трата в будущем (после перевода часов) не влияет на сегодня, но видна в месяце', () => {
    const state = spend(createInitialState('2026-11', eur(660)), '2026-11-20', eur(100));
    const view = dayView(state, '2026-11-02');
    assert.equal(view.availableToday, eur(44));
    assert.equal(view.remainingMonth, eur(560));
    assert.equal(latestMonth(spend(state, '2027-02-01', 1), '2026-11'), '2027-02');
  });

  test('последний месяц истории не бывает раньше начала учёта', () => {
    const state = createInitialState('2026-11', eur(660));
    assert.equal(latestMonth(state, '2026-10'), '2026-11');
    assert.equal(latestMonth(state, '2026-12'), '2026-12');
  });

  test('восстановление лимита учитывает смену месяца', () => {
    const state = spend(createInitialState('2026-11', eur(30)), '2026-11-30', eur(40));
    // Долг 10 €, в декабре норма 30/31 €: лимит станет положительным на 11-й день.
    assert.equal(recoveryDate(state, '2026-11-30'), '2026-12-11');
  });

  test('восстановление не считается, если лимит не в минусе', () => {
    assert.equal(recoveryDate(createInitialState('2026-11', eur(660)), '2026-11-01'), null);
    const zero = spend(createInitialState('2026-11', eur(30)), '2026-11-01', eur(1));
    assert.equal(dayView(zero, '2026-11-01').availableToday, 0);
    assert.equal(recoveryDate(zero, '2026-11-01'), null);
  });
});

describe('случайные проверки против независимого пересчёта по дням', () => {
  // Простой генератор, чтобы падающий запуск можно было повторить по seed.
  const makeRandom = (seed) => {
    let s = seed;
    return (max) => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return Math.floor((s / 4294967296) * max);
    };
  };

  for (let seed = 1; seed <= 200; seed += 1) {
    test(`seed ${seed}`, () => {
      const rnd = makeRandom(seed);
      const first = `20${20 + rnd(10)}-${String(1 + rnd(12)).padStart(2, '0')}`;
      let state = createInitialState(first, rnd(200000));
      const monthCount = 1 + rnd(14);
      const months = [first];
      for (let i = 1; i < monthCount; i += 1) {
        const m = addMonths(first, i);
        months.push(m);
        if (rnd(3) === 0) state = setBudget(state, m, rnd(200000), m);
      }
      const spentOn = new Map();
      const txCount = rnd(80);
      for (let i = 0; i < txCount; i += 1) {
        const m = months[rnd(months.length)];
        const date = `${m}-${String(1 + rnd(daysInMonth(m))).padStart(2, '0')}`;
        const amount = 1 + rnd(90000);
        state = spend(state, date, amount);
        spentOn.set(date, (spentOn.get(date) ?? 0) + amount);
      }

      // Пересчёт шаг за шагом: каждый день прибавляется доля бюджета и вычитаются траты дня.
      let balance = 0;
      for (const m of months) {
        const days = daysInMonth(m);
        const budget = budgetFor(state, m);
        let given = 0;
        let monthSpent = 0;
        for (let day = 1; day <= days; day += 1) {
          const date = `${m}-${String(day).padStart(2, '0')}`;
          const target = Math.round((budget * day) / days);
          balance += target - given;
          given = target;
          const todaySpent = spentOn.get(date) ?? 0;
          balance -= todaySpent;
          monthSpent += todaySpent;
          const view = dayView(state, date);
          assert.equal(view.availableToday, balance, date);
          assert.equal(view.limitToday, balance + todaySpent, date);
          assert.equal(view.spentToday, todaySpent, date);
        }
        assert.equal(given, budget, 'за месяц выдан ровно весь бюджет');
        const lastDate = `${m}-${String(days).padStart(2, '0')}`;
        assert.equal(dayView(state, lastDate).remainingMonth, dayView(state, lastDate).availableToday);
        assert.equal(monthView(state, m).spent, monthSpent);
        assert.equal(monthView(state, m).remaining, balance);
        assert.equal(monthView(state, m).categories.reduce((sum, c) => sum + c.amount, 0), monthSpent);
      }

      // Дата восстановления совпадает с прямым перебором дней.
      const probe = `${months[0]}-01`;
      const expected = (() => {
        if (dayView(state, probe).availableToday >= 0) return null;
        let date = probe;
        for (let i = 0; i < 732; i += 1) {
          date = addDays(date, 1);
          if (dayView(state, date).availableToday > 0) return date;
        }
        return null;
      })();
      assert.equal(recoveryDate(state, probe), expected);
    });
  }
});

describe('траты', () => {
  const base = () => createInitialState('2026-11', eur(660));
  const fields = (over = {}) => ({ id: 'x', createdAt: 1, date: '2026-11-02', amount: 100, categoryId: null, note: '', ...over });

  test('запрещены будущая дата, дата до начала учёта, плохая сумма и несуществующая категория', () => {
    const today = '2026-11-02';
    assert.throws(() => addTransaction(base(), fields({ date: '2026-11-03' }), today), /будущем/);
    assert.throws(() => addTransaction(base(), fields({ date: '2026-10-31' }), today), /раньше|Более ранние/);
    assert.throws(() => addTransaction(base(), fields({ date: '' }), today), BudgetError);
    assert.throws(() => addTransaction(base(), fields({ amount: 0 }), today), BudgetError);
    assert.throws(() => addTransaction(base(), fields({ amount: 1.5 }), today), BudgetError);
    assert.throws(() => addTransaction(base(), fields({ amount: MAX_CENTS + 1 }), today), BudgetError);
    assert.throws(() => addTransaction(base(), fields({ categoryId: 'nope' }), today), BudgetError);
    assert.throws(() => addTransaction(base(), fields({ note: 'a'.repeat(201) }), today), BudgetError);
  });

  test('функции не меняют исходное состояние', () => {
    const state = base();
    const frozen = JSON.stringify(state);
    const next = addTransaction(state, fields(), '2026-11-02');
    assert.equal(JSON.stringify(state), frozen);
    assert.notEqual(next, state);
    assert.equal(next.transactions.length, 1);
  });

  test('заметка обрезается по краям', () => {
    const next = addTransaction(base(), fields({ note: '  кофе  ' }), '2026-11-02');
    assert.equal(next.transactions[0].note, 'кофе');
  });

  test('редактирование сохраняет id и время создания и меняет расчёт', () => {
    let state = addTransaction(base(), fields({ id: 'a', createdAt: 42, amount: eur(10) }), '2026-11-02');
    state = updateTransaction(state, 'a', { date: '2026-11-01', amount: eur(20), categoryId: 'c-food', note: 'обед' }, '2026-11-02');
    assert.deepEqual(state.transactions[0], { id: 'a', createdAt: 42, date: '2026-11-01', amount: eur(20), categoryId: 'c-food', note: 'обед' });
    assert.equal(dayView(state, '2026-11-02').availableToday, eur(24));
  });

  test('у траты с уже будущей датой можно поправить сумму, но нельзя поставить новую будущую дату', () => {
    const state = spend(base(), '2026-12-25', eur(5), { id: 'future' });
    const fixed = updateTransaction(state, 'future', { date: '2026-12-25', amount: eur(6), categoryId: null, note: '' }, '2026-11-02');
    assert.equal(fixed.transactions[0].amount, eur(6));
    assert.throws(() => updateTransaction(state, 'future', { date: '2026-12-26', amount: eur(6), categoryId: null, note: '' }, '2026-11-02'), /будущем/);
    assert.equal(futureTransactionCount(state, '2026-11-02'), 1);
    assert.equal(futureTransactionCount(state, '2026-12-25'), 0);
  });

  test('редактирование и удаление несуществующей траты дают ошибку', () => {
    assert.throws(() => updateTransaction(base(), 'zz', { date: '2026-11-01', amount: 1 }, '2026-11-02'), BudgetError);
    assert.throws(() => deleteTransaction(base(), 'zz'), BudgetError);
  });

  test('удаление возвращает деньги в лимит', () => {
    const state = addTransaction(base(), fields({ id: 'a', amount: eur(10) }), '2026-11-02');
    assert.equal(dayView(deleteTransaction(state, 'a'), '2026-11-02').availableToday, eur(44));
  });

  test('сортировка: новые сверху, при равной дате — по времени создания', () => {
    let state = base();
    state = addTransaction(state, fields({ id: 'a', createdAt: 1 }), '2026-11-02');
    state = addTransaction(state, fields({ id: 'b', createdAt: 2 }), '2026-11-02');
    state = addTransaction(state, fields({ id: 'c', createdAt: 3, date: '2026-11-01' }), '2026-11-02');
    assert.deepEqual(transactionsOn(state, '2026-11-02').map((t) => t.id), ['b', 'a']);
    const groups = monthView(state, '2026-11').dayGroups;
    assert.deepEqual(groups.map((g) => g.date), ['2026-11-02', '2026-11-01']);
    assert.deepEqual(groups[0].items.map((t) => t.id), ['b', 'a']);
  });
});

describe('категории', () => {
  const base = () => createInitialState('2026-11', eur(660));
  const base2 = base;

  test('стартовые категории', () => {
    assert.deepEqual(base().categories.map((c) => c.name), ['Еда', 'Транспорт', 'Мелкие траты']);
  });

  test('добавление, очистка пробелов, запрет дублей и служебного имени', () => {
    const state = addCategory(base(), 'new', '  Кафе   и бары ');
    assert.equal(state.categories.at(-1).name, 'Кафе и бары');
    assert.throws(() => addCategory(state, 'x', 'кафе И БАРЫ'), /уже есть/);
    assert.throws(() => addCategory(state, 'x', '   '), BudgetError);
    assert.throws(() => addCategory(state, 'x', 'без КАТЕГОРИИ'), /занято/);
    assert.throws(() => addCategory(state, 'x', 'я'.repeat(31)), BudgetError);
  });

  test('невидимые символы не дают пустых имён и двойников', () => {
    for (const blank of ['\u200B', '\u200D', '\u2800', '\u3164', '\u00AD', '\u202E', ' \u200B\u200C ', '\uFE0F']) {
      assert.throws(() => addCategory(base(), 'x', blank), BudgetError, JSON.stringify(blank));
    }
    assert.equal(cleanCategoryName('Ка\u200Bфе'), 'Кафе');
    assert.equal(cleanCategoryName('\u202EКафе\u202C'), 'Кафе');
    assert.throws(() => addCategory(base(), 'x', 'Без\u200B категории'), /занято/);
    // «Ей» в двух формах записи Unicode: одна и та же видимая строка.
    const composed = addCategory(base(), 'a', 'Ей');
    assert.throws(() => addCategory(composed, 'b', 'Е\u0438\u0306'), /уже есть/);
    assert.equal(composed.categories.at(-1).name, 'Ей'.normalize('NFC'));
  });

  test('очистка имени: повторная ничего не меняет, принятое имя всегда проходит проверку при чтении', () => {
    const invisible = ['\u00AD', '\u200B', '\u200C', '\u200D', '\u202E', '\u2060', '\uFEFF', '\u034F', '\uFE0F', '\u3164', '\u{E0067}', '\u{E007F}', '\u2800', '\n', '\t', '\u00A0', ' '];
    const base = ['Чаи', 'е', 'и', 'a', 'A', 'й', '🏴', '👨', '1', '-', 'Å', '\u212B', '\u2000'];
    const marks = ['\u0306', '\u0308', '\u030A', '\u0301', '\u0327'];
    let seed = 7;
    const pick = (list) => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return list[Math.floor((seed / 4294967296) * list.length)];
    };
    const samples = ['Чаи\u00AD\u0306', 'а\u200B\u0308', 'и\u2060\u0306'];
    for (let i = 0; i < 4000; i += 1) {
      let text = '';
      for (let j = 0; j < 1 + (i % 6); j += 1) text += pick([base, invisible, marks]) === base ? pick(base) : pick(pick([invisible, marks]));
      samples.push(text);
    }
    for (const sample of samples) {
      const once = cleanCategoryName(sample);
      assert.equal(cleanCategoryName(once), once, JSON.stringify(sample));
      let state;
      try {
        state = addCategory(base2(), 'x', sample);
      } catch (error) {
        assert.ok(error instanceof BudgetError, JSON.stringify(sample));
        continue;
      }
      assert.doesNotThrow(() => validateState(JSON.parse(JSON.stringify(state))), JSON.stringify(sample));
    }
    assert.equal(cleanCategoryName('Чаи\u00AD\u0306'), 'Чай');
  });

  test('эмодзи-флаги с тегами сохраняются и различаются', () => {
    const england = '🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
    const scotland = '🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
    const state = addCategory(addCategory(base(), 'a', england), 'b', scotland);
    assert.deepEqual(state.categories.slice(-2).map((c) => c.name), [england, scotland]);
    assert.doesNotThrow(() => validateState(JSON.parse(JSON.stringify(state))));
    assert.throws(() => addCategory(state, 'c', '🏴'.concat('\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}')), /уже есть/);
    assert.equal(cleanCategoryName('Еда\u{E0067}'), 'Еда', 'теги вне флага удаляются');
  });

  test('эмодзи в названии разрешены, в том числе составные', () => {
    const family = '👨\u200D👩\u200D👧';
    assert.equal(addCategory(base(), 'x', family).categories.at(-1).name, family);
    assert.equal(addCategory(base(), 'x', '🍕 Еда вне дома').categories.at(-1).name, '🍕 Еда вне дома');
  });

  test('переименование своей категории в другой регистр разрешено', () => {
    const state = renameCategory(base(), 'c-food', 'ЕДА');
    assert.equal(state.categories[0].name, 'ЕДА');
    assert.throws(() => renameCategory(base(), 'c-food', 'транспорт'), /уже есть/);
    assert.throws(() => renameCategory(base(), 'zz', 'Новое'), BudgetError);
  });

  test('удаление переводит траты в «Без категории», сумма месяца не меняется', () => {
    let state = spend(base(), '2026-11-01', eur(10), { categoryId: 'c-food' });
    state = spend(state, '2026-11-01', eur(5), { categoryId: 'c-transport' });
    assert.equal(categoryUsage(state, 'c-food'), 1);
    const next = deleteCategory(state, 'c-food');
    assert.equal(next.categories.some((c) => c.id === 'c-food'), false);
    const view = monthView(next, '2026-11');
    assert.equal(view.spent, eur(15));
    assert.deepEqual(view.categories.map((c) => [c.name, c.amount]), [[UNCATEGORIZED, eur(10)], ['Транспорт', eur(5)]]);
    assert.doesNotThrow(() => validateState(next));
  });

  test('доли категорий в сумме дают 100 %', () => {
    let state = spend(base(), '2026-11-01', eur(30), { categoryId: 'c-food' });
    state = spend(state, '2026-11-01', eur(10));
    const { categories } = monthView(state, '2026-11');
    assert.deepEqual(categories.map((c) => c.share), [0.75, 0.25]);
  });

  test('пустой месяц: нет деления на ноль', () => {
    const view = monthView(base(), '2026-11');
    assert.equal(view.spent, 0);
    assert.deepEqual(view.categories, []);
    assert.deepEqual(view.dayGroups, []);
  });
});

describe('проверка данных', () => {
  const valid = () => {
    let state = createInitialState('2026-11', eur(660));
    state = spend(state, '2026-11-01', eur(10), { id: 'fixed', createdAt: 1, categoryId: 'c-food', note: 'обед' });
    return JSON.parse(JSON.stringify(state));
  };

  test('корректные данные проходят без изменений', () => {
    assert.deepEqual(validateState(valid()), valid());
  });

  test('лишние поля отбрасываются', () => {
    const raw = valid();
    raw.evil = 1;
    raw.transactions[0].evil = 1;
    raw.categories[0].evil = 1;
    assert.deepEqual(validateState(raw), valid());
  });

  const breakers = {
    'не объект': () => 5,
    'массив вместо объекта': () => [],
    null: () => null,
    'нет версии': (s) => { delete s.version; return s; },
    'версия строкой': (s) => { s.version = '1'; return s; },
    'нет бюджетов': (s) => { delete s.budgets; return s; },
    'пустые бюджеты': (s) => { s.budgets = {}; return s; },
    'плохой месяц': (s) => { s.budgets['2026-13'] = 100; return s; },
    'ключ __proto__': () => JSON.parse('{"version":1,"budgets":{"__proto__":1,"2026-11":100},"categories":[],"transactions":[],"lastBackupAt":null}'),
    'отрицательный бюджет': (s) => { s.budgets['2026-11'] = -1; return s; },
    'дробный бюджет': (s) => { s.budgets['2026-11'] = 1.5; return s; },
    'бюджет строкой': (s) => { s.budgets['2026-11'] = '660'; return s; },
    'категории не массив': (s) => { s.categories = {}; return s; },
    'дубль id категории': (s) => { s.categories[1].id = s.categories[0].id; return s; },
    'дубль имени категории': (s) => { s.categories[1].name = 'ЕДА'; return s; },
    'служебное имя категории': (s) => { s.categories[1].name = UNCATEGORIZED; return s; },
    'пустое имя': (s) => { s.categories[0].name = ''; return s; },
    'длинное имя': (s) => { s.categories[0].name = 'я'.repeat(31); return s; },
    'траты не массив': (s) => { s.transactions = 'x'; return s; },
    'дубль id траты': (s) => { s.transactions.push({ ...s.transactions[0] }); return s; },
    'плохая дата': (s) => { s.transactions[0].date = '2026-02-30'; return s; },
    'трата до начала учёта': (s) => { s.transactions[0].date = '2026-10-31'; return s; },
    'нулевая сумма': (s) => { s.transactions[0].amount = 0; return s; },
    'сумма NaN после JSON': (s) => { s.transactions[0].amount = null; return s; },
    'огромная сумма': (s) => { s.transactions[0].amount = MAX_CENTS + 1; return s; },
    'сломанная ссылка на категорию': (s) => { s.transactions[0].categoryId = 'zz'; return s; },
    'нет ссылки на категорию': (s) => { delete s.transactions[0].categoryId; return s; },
    'заметка не строка': (s) => { s.transactions[0].note = 5; return s; },
    'длинная заметка': (s) => { s.transactions[0].note = 'a'.repeat(201); return s; },
    'плохое время создания': (s) => { s.transactions[0].createdAt = -1; return s; },
    'плохая дата копии': (s) => { s.lastBackupAt = 'вчера'; return s; },
    'огромная дата копии': (s) => { s.lastBackupAt = Number.MAX_SAFE_INTEGER; return s; },
    'огромное время создания': (s) => { s.transactions[0].createdAt = MAX_TIMESTAMP + 1; return s; },
    'невидимое имя категории': (s) => { s.categories[0].name = '\u200B'; return s; },
    'служебное имя с невидимым символом': (s) => { s.categories[1].name = 'Без\u200B категории'; return s; },
    'двойной пробел в имени': (s) => { s.categories[0].name = 'A  B'; return s; },
    'нет даты копии': (s) => { delete s.lastBackupAt; return s; },
  };
  for (const [name, breakIt] of Object.entries(breakers)) {
    test(`отклоняется: ${name}`, () => {
      assert.throws(() => validateState(breakIt(valid())), BudgetError);
    });
  }

  test('данные новой версии отклоняются с понятным сообщением', () => {
    const raw = valid();
    raw.version = 2;
    assert.throws(() => validateState(raw), /более новой версией/);
  });

  test('после проверки startMonth равен первому месяцу', () => {
    const raw = valid();
    raw.budgets['2026-12'] = 100;
    assert.equal(startMonth(validateState(raw)), '2026-11');
  });
});

describe('резервная копия', () => {
  const state = () => spend(createInitialState('2026-11', eur(660)), '2026-11-01', eur(10), { note: '<img src=x onerror=alert(1)>' });

  test('копия читается обратно без потерь', () => {
    const original = state();
    const { state: restored, exportedAt } = parseBackup(serializeBackup(original, 1234));
    assert.equal(exportedAt, 1234);
    assert.deepEqual(restored, { ...JSON.parse(JSON.stringify(original)), lastBackupAt: 1234 });
  });

  for (const [name, text, pattern] of [
    ['не JSON', 'привет', /не удалось прочитать/],
    ['чужой JSON', '{"a":1}', /не файл резервной копии/],
    ['массив', '[1,2]', /не файл резервной копии/],
    ['null', 'null', /не файл резервной копии/],
    ['нет данных', '{"app":"daily-budget","exportedAt":1}', /повреждены/],
    ['нет даты', '{"app":"daily-budget","data":{}}', /дата создания/],
    ['огромная дата', `{"app":"daily-budget","exportedAt":${Number.MAX_SAFE_INTEGER},"data":{}}`, /дата создания/],
  ]) {
    test(`отклоняется: ${name}`, () => assert.throws(() => parseBackup(text), pattern));
  }

  test('слишком большой файл отклоняется до разбора', () => {
    assert.throws(() => parseBackup(' '.repeat(10_000_001)), /слишком большой/);
  });

  test('напоминание о копии', () => {
    const day = 86_400_000;
    const empty = createInitialState('2026-11', 100);
    assert.equal(backupReminderDue(empty, 100 * day), false);
    const withTx = addTransaction(empty, { id: 'a', createdAt: day, date: '2026-11-01', amount: 1, categoryId: null, note: '' }, '2026-11-01');
    assert.equal(backupReminderDue(withTx, 30 * day), false);
    assert.equal(backupReminderDue(withTx, 31 * day), true);
    assert.equal(backupReminderDue({ ...withTx, lastBackupAt: 20 * day }, 31 * day), false);
    assert.equal(backupReminderDue({ ...withTx, lastBackupAt: 20 * day }, 50 * day), true);
    assert.equal(backupReminderDue({ ...withTx, lastBackupAt: 100 * day }, 50 * day), true, 'дата из будущего не отключает напоминание');
  });
});
