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

## User accounts

An administrator can already create users in the app. Self-registration is available when
`APP_REGISTRATION_ENABLED=1` is set on the server. It is disabled by default. New accounts
receive the regular `user` role. The registration form asks for a name, login, email and
password of at least 12 characters. New accounts remain inactive until an administrator
opens the account panel and clicks **Aktywuj**. They can log in after approval.

The [user data access audit](docs/USER-DATA-ACCESS-AUDIT.md) describes the ownership
rules and remaining limitations. The current administrator role can see all users' data.
Regular accounts cannot use the server SMSPlanet or Groq credentials. There is no email
verification, password reset, account deletion or invitation workflow yet.

Regular users who want SMS must [register with SMSPlanet](https://panel.smsplanet.pl/register),
fund their SMSPlanet account, and generate a Bearer API token in the
[SMSPlanet API panel](https://panel.smsplanet.pl/s/api). In PropertyApp, open Settings →
SMS notifications, save the token, choose the sender, and send a test SMS. The token is
encrypted in the database using `APP_SESSION_SECRET` and never returned by the API.
Keep that secret stable and include it in recovery backups; rotating it requires users
to add their SMS tokens again. Automated scheduled SMS currently runs only for the
server owner account; regular users can trigger a scan manually.

## Development

The public dashboard image is captured from the real UI with a fresh, isolated database
containing only synthetic properties, tenants, payments, and expenses. Regenerate it with
`node scripts/generate-landing-dashboard.js`, then review the screenshot before committing.

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
