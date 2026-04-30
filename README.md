# PropertyApp2

Private rental property management app.

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
