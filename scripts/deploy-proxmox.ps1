param(
  [string]$SshHost = "proxmox",
  [int]$ContainerId = 109,
  [string]$AppDir = "/opt/propertyapp/app",
  [string]$DbFile = "/opt/propertyapp/data/property.db",
  [string]$UploadsDir = "/opt/propertyapp/data/uploads",
  [string]$ServiceName = "propertyapp.service",
  [string]$EnvFile = "/etc/propertyapp/auth.env",
  [string]$GroqApiKey = $env:GROQ_API_KEY,
  [switch]$SkipTests,
  [switch]$SkipSnapshot,
  [switch]$SkipCleanCheck,
  [switch]$RequireGroqKey,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Run($Command, [switch]$Secret) {
  if ($Secret) {
    Write-Host ">> [secret command hidden]"
  } else {
    Write-Host ">> $Command"
  }
  if (-not $DryRun) {
    Invoke-Expression $Command
  }
}

function Require-Tool($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required tool: $Name"
  }
}

Require-Tool git
Require-Tool ssh
Require-Tool scp
Require-Tool npm

$repoRoot = (& git rev-parse --show-toplevel).Trim()
Set-Location $repoRoot

if (-not $SkipCleanCheck) {
  $dirty = (& git status --porcelain)
  if ($dirty) {
    throw "Working tree is not clean. Commit or stash changes before deploying, or pass -SkipCleanCheck intentionally."
  }
}

if ($RequireGroqKey -and [string]::IsNullOrWhiteSpace($GroqApiKey)) {
  throw "GROQ_API_KEY is required but was not provided. Set `$env:GROQ_API_KEY or pass -GroqApiKey."
}

if (-not $SkipTests) {
  Run "npm run smoke"
  Run "npm run test:auth"
  Run "npm run test:rental-model"
  Run "npm run test:seed-safety"
  Run "npm run test:finance"
  Run "npm run test:ui"
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$commit = (& git rev-parse --short=12 HEAD).Trim()
$branch = (& git branch --show-current).Trim()
$archiveName = "propertyapp-$commit-$timestamp.tar"
$archivePath = Join-Path $env:TEMP $archiveName
$remoteArchive = "/tmp/$archiveName"
$remoteStage = "/tmp/propertyapp-deploy-$commit-$timestamp"
$remoteScript = "/tmp/propertyapp-deploy-$commit-$timestamp.sh"
$remoteKey = "/tmp/propertyapp-groq-key-$timestamp.txt"
$snapshotName = "predeploy-propertyapp-$timestamp"
$dbBackup = "/opt/propertyapp/data/backups/property-$timestamp-predeploy.db"
$appBackupDir = "/opt/propertyapp/backups/app-predeploy-$timestamp"

Write-Host ""
Write-Host "Deploy target: CT $ContainerId via $SshHost"
Write-Host "Branch/commit: $branch $commit"
Write-Host "Snapshot: $snapshotName"
Write-Host ""

Run "git archive --format=tar --output `"$archivePath`" HEAD"
Run "scp `"$archivePath`" ${SshHost}:$remoteArchive"

if (-not [string]::IsNullOrWhiteSpace($GroqApiKey)) {
  $keyPath = Join-Path $env:TEMP "propertyapp-groq-key-$timestamp.txt"
  [System.IO.File]::WriteAllText($keyPath, $GroqApiKey, [System.Text.UTF8Encoding]::new($false))
  Run "scp `"$keyPath`" ${SshHost}:$remoteKey" -Secret
  Remove-Item $keyPath -Force
}

$snapshotBlock = if ($SkipSnapshot) {
  "echo 'snapshot skipped'"
} else {
  "pct snapshot $ContainerId $snapshotName"
}

$remoteScriptContent = @"
set -euo pipefail

CT_ID=$ContainerId
APP_DIR="$AppDir"
DB_FILE="$DbFile"
UPLOADS_DIR="$UploadsDir"
SERVICE_NAME="$ServiceName"
ENV_FILE="$EnvFile"
ARCHIVE="$remoteArchive"
STAGE="$remoteStage"
REMOTE_KEY="$remoteKey"
APP_BACKUP_DIR="$appBackupDir"
DB_BACKUP="$dbBackup"

echo "== preflight =="
pct status "`$CT_ID"
pct exec "`$CT_ID" -- bash -lc "test -d '`$APP_DIR' && test -f '`$DB_FILE'"

echo "== backups =="
pct exec "`$CT_ID" -- bash -lc "mkdir -p /opt/propertyapp/data/backups /opt/propertyapp/backups '`$APP_BACKUP_DIR'"
pct exec "`$CT_ID" -- bash -lc "cd '`$APP_DIR' && DB_FILE='`$DB_FILE' UPLOADS_DIR='`$UPLOADS_DIR' BACKUP_INCLUDE_FILES=1 BACKUP_CONFIG_FILE='`$ENV_FILE' node scripts/backup.js /opt/propertyapp/data/backups"
pct exec "`$CT_ID" -- bash -lc "tar --exclude='./node_modules' --exclude='./data' -cf '`$APP_BACKUP_DIR/app.tar' -C '`$APP_DIR' ."

echo "== snapshot =="
$snapshotBlock

echo "== stage archive =="
rm -rf "`$STAGE"
mkdir -p "`$STAGE"
tar -xf "`$ARCHIVE" -C "`$STAGE"
tar -tf "`$ARCHIVE" | sed 's#^\./##' | grep -v '/$' > "`$STAGE/.deploy-manifest"

echo "== update Groq config if provided =="
if [ -f "`$REMOTE_KEY" ]; then
  pct push "`$CT_ID" "`$REMOTE_KEY" /tmp/propertyapp-groq-key.txt -perms 0600
  cat > "`$STAGE/set-groq.sh" <<'GROQ_SCRIPT'
set -eu
env_file="`$1"
key=`$(tr -d '\r\n' < /tmp/propertyapp-groq-key.txt)
touch "`$env_file"
chmod 600 "`$env_file"
tmp=`$(mktemp)
grep -v -E '^(GROQ_API_KEY|GROQ_BASE_URL|GROQ_MODEL)=' "`$env_file" > "`$tmp" || true
cat >> "`$tmp" <<EOF
GROQ_API_KEY=`$key
GROQ_BASE_URL=https://api.groq.com/openai/v1
GROQ_MODEL=openai/gpt-oss-120b
EOF
cat "`$tmp" > "`$env_file"
rm -f "`$tmp" /tmp/propertyapp-groq-key.txt
chown root:root "`$env_file"
GROQ_SCRIPT
  pct push "`$CT_ID" "`$STAGE/set-groq.sh" /tmp/propertyapp-set-groq.sh -perms 0700
  pct exec "`$CT_ID" -- bash /tmp/propertyapp-set-groq.sh "`$ENV_FILE"
  pct exec "`$CT_ID" -- rm -f /tmp/propertyapp-set-groq.sh
  rm -f "`$REMOTE_KEY"
fi

echo "== deploy files =="
pct exec "`$CT_ID" -- bash -lc "set -e
  cd '`$APP_DIR'
  if [ -f .deploy-manifest ]; then
    while IFS= read -r rel; do
      case \"\`$rel\" in ''|/*|*'..'*) continue ;; esac
      rm -f -- \"\`$rel\"
    done < .deploy-manifest
  else
    rm -rf public src scripts tests
    rm -f .env.example .gitignore README.md package.json package-lock.json playwright.config.js AUDIT-FIX-PLAN.md plans.md
  fi
"
tar -cf - -C "`$STAGE" . | pct exec "`$CT_ID" -- tar -xf - -C "`$APP_DIR"
pct exec "`$CT_ID" -- bash -lc "chown -R propertyapp:propertyapp '`$APP_DIR'"

echo "== install and migrate =="
pct exec "`$CT_ID" -- bash -lc "cd '`$APP_DIR' && npm ci --omit=dev"
pct exec "`$CT_ID" -- bash -lc "cd '`$APP_DIR' && DB_FILE='`$DB_FILE' UPLOADS_DIR='`$UPLOADS_DIR' npm run migrate"
pct exec "`$CT_ID" -- bash -lc "rm -rf '`$APP_DIR/data'"

echo "== install daily backup timer =="
pct exec "`$CT_ID" -- install -m 0644 "`$APP_DIR/deploy/propertyapp-backup.service" /etc/systemd/system/propertyapp-backup.service
pct exec "`$CT_ID" -- install -m 0644 "`$APP_DIR/deploy/propertyapp-backup.timer" /etc/systemd/system/propertyapp-backup.timer
pct exec "`$CT_ID" -- systemctl daemon-reload
pct exec "`$CT_ID" -- systemctl enable --now propertyapp-backup.timer

echo "== restart and verify =="
pct exec "`$CT_ID" -- systemctl restart "`$SERVICE_NAME"
pct exec "`$CT_ID" -- systemctl is-active --quiet "`$SERVICE_NAME"
pct exec "`$CT_ID" -- curl -fsS http://127.0.0.1:8090/health

echo "== cleanup =="
rm -rf "`$STAGE" "`$ARCHIVE" "$remoteScript"

echo "Deploy OK: $commit"
echo "DB backup: `$DB_BACKUP"
echo "App backup: `$APP_BACKUP_DIR/app.tar"
"@

$localRemoteScript = Join-Path $env:TEMP "propertyapp-deploy-$commit-$timestamp.sh"
[System.IO.File]::WriteAllText($localRemoteScript, $remoteScriptContent, [System.Text.UTF8Encoding]::new($false))
Run "scp `"$localRemoteScript`" ${SshHost}:$remoteScript"
Remove-Item $localRemoteScript -Force

Run "ssh $SshHost 'bash $remoteScript'"

if (Test-Path $archivePath) {
  Remove-Item $archivePath -Force
}

Write-Host ""
Write-Host "Public smoke:"
Run "curl.exe -I https://propertyapp.familyos.pl"
