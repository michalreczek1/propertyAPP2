'use strict';
const round2 = (n) => Math.round((+n || 0) * 100) / 100;
const fmtPLN = (n) =>
  round2(n).toLocaleString('pl-PL', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
module.exports = { round2, fmtPLN };
