# User data access audit (2026-09-23)

## Access model

- Regular database users own properties, tenants, payments, expenses, tasks, documents, bank transactions, notification logs, settings and SMS credentials.
- The administrator role intentionally has access to all business records and user management. The original environment based administrator remains the server owner. Anyone given the administrator role must be trusted with all users' data.
- User SMSPlanet credentials are stored per account, encrypted with a key derived from `APP_SESSION_SECRET`. API responses expose only whether a credential exists.
- Regular accounts never receive the server SMSPlanet token. SMS sending and delivery checks use the account's own token. The scheduled scan uses only legacy server owner records.
- Regular accounts cannot invoke Groq with the server key. Local assistant functions remain available.

## Reviewed and corrected

- Record access checks now use the primary owner (or the owning property for contracts) rather than accepting ownership of any joined row.
- Core lists and bulk actions for payments, tenants, contracts, tasks, expenses, reports, exports and dashboard use owner filters.
- Bank matching checks the payment owner. Notification scans and retries use the payment or log owner.
- Settings and notification defaults no longer reveal the server owner's business details or test phone to regular users.
- Assistant and automation queries use owner filters; Excel import and user administration stay administrator only.

## Verification

`npm run test:auth` creates two regular accounts plus the server owner in an isolated database. It checks private records through lists, individual endpoints, exports and a bulk mutation; verifies settings isolation; confirms no fallback to server SMS/AI credentials; and checks that a user token is not returned or stored in plaintext. Smoke, finance, rental model, development, seed safety, lint, format and Playwright checks also pass.

## Remaining limitations

- Administrator access to all records is by design and is not a private tenant boundary.
- Account creation has no email verification, password reset, user deletion or invitation workflow. Registration is rate limited.
- Property names remain globally unique in the current schema, so two owners cannot use an identical name.
- User SMS scans are manual; the background schedule runs only for the original server owner.
- Encryption depends on the stable `APP_SESSION_SECRET`; rotating it requires users to enter their SMS tokens again.
