'use strict';

// Справочник сроков (ТЗ, раздел 6.6, FR-44, FR-45).
//
// Справочник только читает правила раздела 8 и показывает итоговые даты
// горизонта. Даты не дублируются в тексте: они вычисляются генератором
// rules.js на наборе виртуальных клиентов, которые вместе покрывают все
// условия раздела 8. Поэтому справочник и календарь не могут разойтись.

const rules = require('./rules');

// Набор клиентов, покрывающий условия правил. В базу они не записываются.
const SAMPLE_CLIENTS = [
  {
    // Максимальный набор признаков — как у ООО «СтройДом» (раздел 8.5).
    form: 'ООО', sno: 'ОСНО', vat: true, vatExempt: false,
    profitAdvances: 'monthly', hasEmployees: true,
    hasLandTax: true, hasPropertyTax: true,
  },
  {
    // ИП на ОСНО — годовая 3-НДФЛ.
    form: 'ИП', sno: 'ОСНО', vat: false, vatExempt: false,
    profitAdvances: 'none', hasEmployees: false,
    hasLandTax: false, hasPropertyTax: false,
  },
  {
    // УСН у организации — декларация 25.03 и доплата по УСН.
    form: 'ООО', sno: 'УСН', vat: true, vatExempt: false,
    profitAdvances: 'quarterly', hasEmployees: true,
    hasLandTax: true, hasPropertyTax: true,
  },
  {
    // УСН у ИП — декларация 26.04.
    form: 'ИП', sno: 'УСН', vat: false, vatExempt: false,
    profitAdvances: 'none', hasEmployees: false,
    hasLandTax: false, hasPropertyTax: false,
  },
  {
    // ЕСХН — декларация и доплата по ЕСХН.
    form: 'ООО', sno: 'ЕСХН', vat: true, vatExempt: false,
    profitAdvances: 'none', hasEmployees: true,
    hasLandTax: true, hasPropertyTax: true,
  },
  {
    // ПСН без сотрудников: только бухгалтерская отчётность организации.
    form: 'ООО', sno: 'ПСН', vat: false, vatExempt: false,
    profitAdvances: 'none', hasEmployees: false,
    hasLandTax: false, hasPropertyTax: false,
  },
];

const GROUPS = [
  {
    section: '8.1',
    title: 'Кто платит НДС и по каким ставкам',
    rules: [
      {
        id: 'vat-payers',
        title: 'Плательщики НДС и ставки',
        condition:
          'Организации и ИП на ОСНО, УСН и ЕСХН. Не являются плательщиками НДС клиенты на ПСН, АУСН и НПД. Признак «Платит НДС» ставится бухгалтером и из системы налогообложения не выводится.',
        calculation:
          'Ставки: 22 % — основная; 10 % и 0 % — по перечням ст. 164 НК РФ; 5 % и 7 % — только для УСН. Освобождение по ст. 145 НК РФ — при выручке до 2 млн ₽ за три месяца; в карточке включается признак «Освобождён от НДС» (только для УСН и ЕСХН).',
        dates: [],
      },
    ],
  },
  {
    section: '8.2',
    title: 'Квартальная и годовая отчётность',
    rules: [
      {
        id: 'vat-decl',
        title: 'Декларация по НДС',
        condition: 'vat = true и vatExempt = false',
        calculation: '25-е число месяца, следующего за отчётным кварталом; перенос на ближайший рабочий день по FR-47.',
        match: /^vat-decl:/,
      },
      {
        id: 'ndfl6-quarter',
        title: '6-НДФЛ за квартал',
        condition: 'hasEmployees = true',
        calculation: '25-е число месяца, следующего за отчётным кварталом; перенос по FR-47.',
        match: /^ndfl6-quarter:/,
      },
      {
        id: 'rsv',
        title: 'РСВ',
        condition: 'hasEmployees = true',
        calculation: '25-е число месяца, следующего за отчётным кварталом; перенос по FR-47.',
        match: /^rsv:/,
      },
      {
        id: 'efs1-section2',
        title: 'ЕФС-1 раздел 2',
        condition: 'hasEmployees = true',
        calculation: 'Один раз в год: не позднее 25-го числа месяца, следующего за отчётным годом; перенос по FR-47.',
        match: /^efs1-section2:/,
      },
      {
        id: 'efs1-1.2',
        title: 'ЕФС-1 подраздел 1.2',
        condition: 'hasEmployees = true',
        calculation: 'Один раз в год, 25-е число месяца, следующего за отчётным годом; перенос по FR-47.',
        match: /^efs1-1\.2:/,
      },
      {
        id: 'ndfl6-year',
        title: '6-НДФЛ за 2026',
        condition: 'hasEmployees = true',
        calculation: '25 февраля года, следующего за отчётным; перенос по FR-47.',
        match: /^ndfl6-year:/,
      },
      {
        id: 'profit-decl-9m',
        title: 'Декларация по налогу на прибыль за 9 месяцев 2026',
        condition: 'sno = ОСНО',
        calculation: '25-е число месяца, следующего за отчётным периодом; перенос по FR-47.',
        match: /^profit-decl:2026-9m$/,
      },
      {
        id: 'profit-decl-year',
        title: 'Декларация по налогу на прибыль за 2026',
        condition: 'sno = ОСНО',
        calculation: '25 марта года, следующего за отчётным; перенос по FR-47.',
        match: /^profit-decl:2026$/,
      },
      {
        id: 'profit-decl-q1',
        title: 'Декларация по налогу на прибыль за I квартал 2027',
        condition: 'sno = ОСНО',
        calculation: '25 апреля года, следующего за отчётным периодом; перенос по FR-47.',
        match: /^profit-decl:2027-Q1$/,
      },
      {
        id: 'usn-decl',
        title: 'Декларация по УСН за 2026',
        condition: 'sno = УСН',
        calculation:
          'Организации — 25 марта, ИП — 25 апреля года, следующего за отчётным; перенос по FR-47.',
        match: /^usn-decl:/,
      },
      {
        id: 'eshn-decl',
        title: 'Декларация по ЕСХН за 2026',
        condition: 'sno = ЕСХН',
        calculation: '25 марта года, следующего за отчётным; перенос по FR-47.',
        match: /^eshn-decl:/,
      },
      {
        id: 'ndfl3',
        title: '3-НДФЛ за 2026',
        condition: 'form = ИП и sno = ОСНО',
        calculation: '30 апреля года, следующего за отчётным; перенос по FR-47.',
        match: /^ndfl3:/,
      },
      {
        id: 'accounting',
        title: 'Бухгалтерская отчётность за 2026',
        condition: 'form = ООО',
        calculation:
          'Не позднее трёх месяцев после окончания отчётного года, то есть 31 марта; перенос по FR-47. Уплаты не следует, строка реестра не создаётся.',
        match: /^accounting:/,
      },
    ],
  },
  {
    section: '8.2.1',
    title: 'Персональные сведения о физических лицах',
    rules: [
      {
        id: 'personal',
        title: 'Персональные сведения',
        condition: 'hasEmployees = true',
        calculation:
          'Ежемесячно, не позднее 25-го числа месяца, следующего за отчётным. За последний месяц квартала отдельная подача не нужна: его покрывает квартальная. Перенос по FR-47.',
        match: /^personal:/,
      },
    ],
  },
  {
    section: '8.2.2',
    title: 'АУСН',
    rules: [
      {
        id: 'ausn',
        title: 'Декларация по АУСН',
        condition: 'sno = АУСН',
        calculation:
          'Декларация в разделе 8 не предусмотрена: задач по ней не создаётся. Отчётность по сотрудникам при hasEmployees создаётся по общим правилам.',
        dates: [],
      },
    ],
  },
  {
    section: '8.3',
    title: 'Уведомления по НДФЛ, взносам и налогам',
    rules: [
      {
        id: 'notif-ndfl-first',
        title: 'Уведомление по НДФЛ за период 1–22',
        condition: 'hasEmployees = true',
        calculation:
          'Не позднее 25-го числа того же месяца; перенос по FR-47.',
        match: /^notif-ndfl:.*-1$/,
      },
      {
        id: 'notif-ndfl-second',
        title: 'Уведомление по НДФЛ за период 23–последнее число',
        condition: 'hasEmployees = true',
        calculation:
          'Не позднее 3-го числа следующего месяца; за декабрь — последний рабочий день года; перенос по FR-47.',
        match: /^notif-ndfl:.*-2$/,
      },
      {
        id: 'notif-contrib',
        title: 'Уведомление по страховым взносам',
        condition: 'hasEmployees = true',
        calculation:
          'За первый месяц квартала — 25-е число второго месяца квартала, за второй месяц — 25-е число третьего месяца. За последний месяц квартала уведомление не подаётся. Перенос по FR-47.',
        match: /^notif-contrib:/,
      },
      {
        id: 'notif-usn-eshn',
        title: 'Уведомление по УСН или ЕСХН за 9 месяцев 2026',
        condition: 'sno = УСН или sno = ЕСХН',
        calculation:
          'Не позднее 25-го числа месяца, следующего за отчётным периодом; за год уведомление не требуется. Перенос по FR-47.',
        match: /^notif-(usn|eshn):/,
      },
      {
        id: 'notif-land',
        title: 'Уведомление по земельному налогу',
        condition: 'hasLandTax = true',
        calculation:
          'Ежеквартально по авансам и один раз в год по итоговому налогу: 25-е число месяца, следующего за периодом. Перенос по FR-47.',
        match: /^notif-land:/,
      },
      {
        id: 'notif-property',
        title: 'Уведомление по налогу на имущество',
        condition: 'hasPropertyTax = true',
        calculation:
          'Ежеквартально по авансам и один раз в год по итоговому налогу: 25-е число месяца, следующего за периодом. Перенос по FR-47.',
        match: /^notif-property:/,
      },
    ],
  },
  {
    section: '8.4',
    title: 'Платежи',
    rules: [
      {
        id: 'vat-pay',
        title: 'НДС, три доли',
        condition: 'vat = true и vatExempt = false',
        calculation:
          'Равными долями не позднее 28-го числа каждого из трёх месяцев, следующих за отчётным кварталом. Сумма делится на три, остаток добавляется к третьей доле (FR-66). Перенос по FR-47.',
        match: /^vat-pay:/,
      },
      {
        id: 'profit-advance-monthly',
        title: 'Авансы по налогу на прибыль, ежемесячно',
        condition: 'profitAdvances = monthly',
        calculation:
          '28-е число каждого месяца; аванс за март не создаётся отдельно, его покрывает годовая доплата 29.03.2027 (раздел 8.5). Перенос по FR-47.',
        match: /^profit-advance:/,
      },
      {
        id: 'profit-advance-quarterly',
        title: 'Авансы по налогу на прибыль, поквартально',
        condition: 'profitAdvances = quarterly',
        calculation:
          'Внутри квартала авансы не начисляются и не уплачиваются: задач на 30.11.2026, 28.12.2026, 01.03.2027 и 29.03.2027 нет.',
        dates: [],
      },
      {
        id: 'profit-extra-9m',
        title: 'Доплата налога на прибыль за 9 месяцев 2026',
        condition: 'profitAdvances ≠ none',
        calculation: '28-е число месяца, следующего за отчётным периодом; перенос по FR-47.',
        match: /^profit-extra:2026-9m$/,
      },
      {
        id: 'profit-extra-year',
        title: 'Доплата налога на прибыль за 2026',
        condition: 'profitAdvances ≠ none',
        calculation:
          '28 марта года, следующего за отчётным; 28.03.2027 — воскресенье, срок переносится на 29.03.2027.',
        match: /^profit-extra:2026$/,
      },
      {
        id: 'profit-extra-q1',
        title: 'Доплата налога на прибыль за I квартал 2027',
        condition: 'profitAdvances ≠ none',
        calculation: '28 апреля года, следующего за отчётным периодом; перенос по FR-47.',
        match: /^profit-extra:2027-Q1$/,
      },
      {
        id: 'injury',
        title: 'Взносы на травматизм',
        condition: 'hasEmployees = true',
        calculation:
          '15-е число месяца, следующего за отчётным; запись реестра вносится по задаче. Перенос по FR-47.',
        match: /^injury:/,
      },
      {
        id: 'contrib-pay',
        title: 'Страховые взносы',
        condition: 'hasEmployees = true',
        calculation:
          'Ежемесячно, 28-е число месяца, следующего за истёкшим; перенос по FR-47.',
        match: /^contrib-pay:/,
      },
      {
        id: 'ndfl-pay',
        title: 'НДФЛ',
        condition: 'hasEmployees = true',
        calculation:
          'За период 1–22 — 28-е число того же месяца, за период 23–последнее — 5-е число следующего месяца, за декабрь — последний рабочий день года. Перенос по FR-47.',
        match: /^ndfl-pay:/,
      },
      {
        id: 'land-advance',
        title: 'Земельный налог, авансы',
        condition: 'hasLandTax = true',
        calculation: '30-е число месяца, следующего за отчётным кварталом; перенос по FR-47.',
        match: /^land-advance:/,
      },
      {
        id: 'land-year',
        title: 'Земельный налог за 2026',
        condition: 'hasLandTax = true',
        calculation: '30 марта года, следующего за отчётным; перенос по FR-47.',
        match: /^land-year:/,
      },
      {
        id: 'property-advance',
        title: 'Налог на имущество, авансы',
        condition: 'hasPropertyTax = true',
        calculation: '30-е число месяца, следующего за отчётным кварталом; перенос по FR-47.',
        match: /^property-advance:/,
      },
      {
        id: 'property-year',
        title: 'Налог на имущество за 2026',
        condition: 'hasPropertyTax = true',
        calculation: '30 марта года, следующего за отчётным; перенос по FR-47.',
        match: /^property-year:/,
      },
      {
        id: 'extra-usn-eshn',
        title: 'Доплата по УСН или ЕСХН за 2026',
        condition: 'sno = УСН или sno = ЕСХН',
        calculation: '28 апреля года, следующего за отчётным; перенос по FR-47.',
        match: /^extra-(usn|eshn):/,
      },
      {
        id: 'transport',
        title: 'Транспортный налог',
        condition: 'hasTransportTax = true',
        calculation:
          'В календарных задачах не создаётся: декларации и авансов нет. Срок уплаты — не позднее 1 марта года, следующего за отчётным; запись реестра вносится вручную.',
        fixedDates: ['2027-03-01'],
        fixedDateNote: 'срок уплаты, задачи в календаре нет',
      },
    ],
  },
];

// Все задачи, которые генератор создаёт для набора клиентов.
function buildAllTasks(tools) {
  const all = [];
  for (const client of SAMPLE_CLIENTS) {
    all.push(...rules.buildRawTasks(client, tools));
  }
  return all;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function buildReference(tools) {
  const all = buildAllTasks(tools);

  return {
    horizon: rules.HORIZON,
    groups: GROUPS.map((group) => ({
      section: group.section,
      title: group.title,
      rules: group.rules.map((rule) => {
        const dates = rule.match
          ? uniqueSorted(all.filter((task) => rule.match.test(task.key)).map((task) => task.date))
          : [];

        return {
          id: rule.id,
          title: rule.title,
          condition: rule.condition,
          calculation: rule.calculation,
          dates: rule.fixedDates
            ? uniqueSorted([...dates, ...rule.fixedDates])
            : dates,
          dateNote: rule.dateNote || rule.fixedDateNote || null,
        };
      }),
    })),
  };
}

module.exports = {
  buildReference,
  buildAllTasks,
};
