# PropertyApp2

Private rental property management app.

## Core workflows

- Bank reconciliation imports CSV statements, skips duplicates, scores payment matches and requires confirmation before updating a payment. Confirmed matches can be undone.
- Contract workflow covers draft, document collection, signature, activation, ending and archive stages. Document versions, approval/signature state and expiry dates are tracked separately.
- The owner statement summarizes 12 months of collection, revenue, costs, tax, net result, property performance and operational risks.
- Guarded automations create an approval queue from deterministic signals. Financial actions always require explicit confirmation and every mutation is included in the audit log.

Bank CSV files must contain a date and amount column. Recognized optional columns include title/description, counterparty, account and currency. Polish and English column names, semicolon/comma/tab separators and common Polish date/amount formats are supported.

This repository intentionally excludes business data, imported spreadsheets,
server credentials, deployment notes, local plans, generated files, and uploaded
documents. Keep operational/infrastructure documentation outside git or in an
ignored private note.

## Development

```bash
npm install
npm run migrate
npm run dev
```

## Checks

```bash
npm run smoke
npm run test:finance
npm run test:auth
npm run test:rental-model
npm run test:ui
```
