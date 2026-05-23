'use strict';

const { includesAny, normalizeText } = require('./ai-preprocess');

const METRICS = {
  net_income: {
    label_pl: 'Dochód netto właściciela',
    aliases: ['dochód', 'dochod', 'zysk', 'netto', 'do kieszeni', 'czysty zarobek', 'zarobek', 'zarobki', 'zarobiłem', 'zarobilem', 'zarobiłam', 'zarobilam'],
    default_for: ['dochód', 'dochod', 'zysk'],
    formula: 'revenue_paid - expenses - tax',
    methodology_pl: 'Dochód netto właściciela to zatwierdzone wpłaty pomniejszone o koszty bezpośrednie, alokowane koszty właściciela i podatek ryczałtowy.',
  },
  revenue_paid: {
    label_pl: 'Przychód brutto z wpłat',
    aliases: ['przychód', 'przychod', 'wpłaty', 'wplaty', 'wpływy', 'wplywy', 'co wpłynęło', 'co wplynelo'],
    default_for: ['przychód', 'przychod', 'wpłaty', 'wplaty', 'wpływy', 'wplywy'],
    formula: 'SUM(total_paid for paid/partial payments)',
    methodology_pl: 'Przychód z wpłat obejmuje faktyczne total_paid dla płatności opłaconych i częściowych. Płatności oczekujące i zaległe nie są przychodem zrealizowanym.',
  },
  revenue_expected: {
    label_pl: 'Przychód oczekiwany',
    aliases: ['oczekiwany przychód', 'oczekiwany przychod', 'należności', 'naleznosci', 'co powinno wpłynąć', 'co powinno wplynac'],
    default_for: ['należności', 'naleznosci'],
    formula: 'SUM(expected rent + media + other)',
    methodology_pl: 'Przychód oczekiwany to suma należnych płatności bez względu na status zapłaty.',
  },
  expenses: {
    label_pl: 'Koszty',
    aliases: ['koszt', 'koszty', 'wydatki', 'obciążenia', 'obciazenia'],
    formula: 'direct expenses + allocated owner/property costs',
    methodology_pl: 'Koszty obejmują koszty bezpośrednie oraz alokowane koszty właściciela zgodnie z warstwą finance-summary.',
  },
  tax_total: {
    label_pl: 'Podatek',
    aliases: ['podatek', 'podatku', 'ryczałt', 'ryczalt'],
    formula: 'monthly rounded tax total',
    methodology_pl: 'Podatek liczony jest miesięcznie od zatwierdzonego czynszu, z zaokrągleniem do złotówki i podatkiem stałym, jeśli skonfigurowany.',
  },
  margin: {
    label_pl: 'Marża netto',
    aliases: ['marża', 'marza', 'rentowność', 'rentownosc'],
    formula: 'net_income / revenue_paid',
    methodology_pl: 'Marża netto to dochód netto podzielony przez przychód zrealizowany. Gdy przychód wynosi 0, marża wynosi 0.',
  },
  tenant_paid_total: {
    label_pl: 'Wpłaty najemcy',
    aliases: ['ile zapłacił', 'ile zaplacil', 'wpłaty najemcy', 'wplaty najemcy'],
    formula: 'SUM(total_paid by tenant and period range)',
    methodology_pl: 'Suma wpłat najemcy obejmuje faktyczne total_paid dla płatności opłaconych i częściowych w wybranym zakresie.',
  },
  tenant_balance: {
    label_pl: 'Saldo najemcy',
    aliases: ['ile zalega', 'ile winien', 'saldo najemcy', 'zaległość', 'zaleglosc'],
    formula: 'SUM expected - paid for pending/overdue/partial',
    methodology_pl: 'Saldo to suma niezapłaconych części płatności oczekujących, zaległych i częściowych.',
  },
  tenant_count: {
    label_pl: 'Liczba najemców',
    aliases: ['ilu najemców', 'ilu najemcow', 'liczba najemców', 'liczba najemcow'],
    formula: 'COUNT DISTINCT tenants with payments/contracts in range',
    methodology_pl: 'Liczba najemców to unikalni najemcy powiązani z płatnościami lub umowami w danym zakresie.',
  },
};

function metricListForPrompt() {
  return Object.entries(METRICS).map(([key, value]) => ({
    key,
    label_pl: value.label_pl,
    aliases: value.aliases,
    formula: value.formula,
  }));
}

function inferMetric(question) {
  const text = normalizeText(question);
  const hits = [];
  for (const [key, metric] of Object.entries(METRICS)) {
    const matched = metric.aliases.filter(alias => text.includes(normalizeText(alias)));
    if (matched.length) hits.push({ key, metric, score: matched.length, matched });
  }

  if (includesAny(text, ['ile zaplacil', 'ile zaplacila', 'wplaty najemcy'])) {
    return { key: 'tenant_paid_total', metric: METRICS.tenant_paid_total, ambiguous: false, source: 'rule' };
  }
  if (includesAny(text, ['czy zaplacil', 'status platnosci'])) {
    return { key: 'payment_status', metric: { label_pl: 'Status płatności' }, ambiguous: false, source: 'rule' };
  }
  if (includesAny(text, ['ilu najemcow', 'liczba najemcow'])) {
    return { key: 'tenant_count', metric: METRICS.tenant_count, ambiguous: false, source: 'rule' };
  }

  if (!hits.length) return null;
  hits.sort((a, b) => b.score - a.score);
  const top = hits[0];
  const sameScore = hits.filter(hit => hit.score === top.score);
  if (sameScore.length > 1 && sameScore.some(hit => hit.key !== top.key)) {
    const defaultHit = sameScore.find(hit => hit.metric.default_for && hit.matched.some(alias => hit.metric.default_for.map(normalizeText).includes(normalizeText(alias))));
    if (defaultHit) return { key: defaultHit.key, metric: defaultHit.metric, ambiguous: false, source: 'default_alias' };
    return { key: top.key, metric: top.metric, ambiguous: true, options: sameScore.map(hit => ({ key: hit.key, label: hit.metric.label_pl })) };
  }
  return { key: top.key, metric: top.metric, ambiguous: false, source: 'alias' };
}

function valueFromPropertyTotals(metricKey, totals) {
  if (metricKey === 'net_income') return totals.net;
  if (metricKey === 'revenue_expected') return totals.expected;
  if (metricKey === 'expenses') return totals.expenses;
  if (metricKey === 'tax_total') return totals.tax;
  if (metricKey === 'margin') return totals.revenue ? totals.net / totals.revenue : 0;
  return totals.revenue;
}

module.exports = {
  METRICS,
  inferMetric,
  metricListForPrompt,
  valueFromPropertyTotals,
};
