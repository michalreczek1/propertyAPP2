# Deploy PropertyApp na Proxmox

Ten repozytoryjny skrypt wykonuje powtarzalny deploy do `CT 109 propertyapp`.

## Wymagania lokalne

- Windows PowerShell
- `git`, `ssh`, `scp`, `npm`
- alias SSH `proxmox` skonfigurowany w `C:\Users\micha\.ssh\config`
- czysty working tree przed deployem

## Standardowy deploy

Z katalogu repo:

```powershell
$env:GROQ_API_KEY="gsk_..."
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-proxmox.ps1
```

Domyślnie skrypt:

- sprawdza czystość repozytorium,
- uruchamia `npm run smoke`, `npm run test:ui`, `npm run test:finance`,
- tworzy `git archive` aktualnego commita,
- kopiuje archiwum na host `proxmox`,
- robi backup SQLite i backup katalogu aplikacji,
- robi snapshot kontenera,
- aktualizuje `/etc/propertyapp/auth.env`, jeśli podano `GROQ_API_KEY`,
- wdraża pliki do `/opt/propertyapp/app`,
- wykonuje `npm ci --omit=dev`,
- uruchamia migrację na właściwej bazie `DB_FILE=/opt/propertyapp/data/property.db`,
- restartuje `propertyapp.service`,
- sprawdza `/health` i publiczny endpoint.

## Przydatne warianty

Deploy bez ponownego ustawiania Groq key:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-proxmox.ps1
```

Deploy wymagający obecności klucza:

```powershell
$env:GROQ_API_KEY="gsk_..."
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-proxmox.ps1 -RequireGroqKey
```

Szybki deploy bez lokalnych testów, tylko gdy testy były już uruchomione:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-proxmox.ps1 -SkipTests
```

Podgląd komend bez wykonania:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-proxmox.ps1 -DryRun
```

## Rollback

Skrypt wypisuje nazwy backupów po deployu. Typowe ścieżki:

- baza: `/opt/propertyapp/data/backups/property-YYYYMMDD-HHMMSS-predeploy.db`
- app: `/opt/propertyapp/backups/app-predeploy-YYYYMMDD-HHMMSS/app.tar`
- snapshot: `predeploy-propertyapp-YYYYMMDD-HHMMSS`

Rollback całego CT z hosta Proxmox:

```bash
pct listsnapshot 109
pct rollback 109 predeploy-propertyapp-YYYYMMDD-HHMMSS
pct start 109
```

Rollback samego katalogu aplikacji:

```bash
pct exec 109 -- bash -lc "cd /opt/propertyapp/app && tar -xf /opt/propertyapp/backups/app-predeploy-YYYYMMDD-HHMMSS/app.tar -C /opt/propertyapp/app && chown -R propertyapp:propertyapp /opt/propertyapp/app && systemctl restart propertyapp.service"
```

Rollback samej bazy:

```bash
pct exec 109 -- bash -lc "systemctl stop propertyapp.service && cp /opt/propertyapp/data/backups/property-YYYYMMDD-HHMMSS-predeploy.db /opt/propertyapp/data/property.db && chown propertyapp:propertyapp /opt/propertyapp/data/property.db && systemctl start propertyapp.service"
```

## Diagnostyka po deployu

```bash
pct exec 109 -- systemctl status propertyapp.service --no-pager
pct exec 109 -- journalctl -u propertyapp.service -n 120 --no-pager
pct exec 109 -- curl http://127.0.0.1:8090/health
pct exec 101 -- caddy validate --config /etc/caddy/Caddyfile
curl -I https://propertyapp.familyos.pl
```
