'use strict';

function computeTaxAmounts(rentPaid, rate = 8.5, additionalMonthlyTax = 0) {
  const safeRate = Number.isFinite(Number(rate)) ? Number(rate) : 8.5;
  const safeAdditional = Number.isFinite(Number(additionalMonthlyTax)) ? Number(additionalMonthlyTax) : 0;
  const base = Math.round(Number(rentPaid) || 0);
  const podatek = Math.round(base * safeRate / 100);
  const podatek_koscielna = base > 0 ? Math.round(safeAdditional) : 0;

  return {
    podatek,
    podatek_koscielna,
    podatek_suma: podatek + podatek_koscielna,
    rate: safeRate,
    base,
  };
}

module.exports = { computeTaxAmounts };
