param(
  [string]$SshHost = "proxmox",
  [int]$ContainerId = 109,
  [string]$AppDir = "/opt/propertyapp/app",
  [string]$DbFile = "/opt/propertyapp/data/property.db",
  [string]$UploadsDir = "/opt/propertyapp/data/uploads",
  [string]$ServiceName = "propertyapp.service",
  [string]$EnvFile = "/etc/propertyapp/auth.env",
  [int]$SnapshotKeep = 3,
  [int]$AppBackupKeep = 5,
  [string]$GroqApiKey = $env:GROQ_API_KEY,
  [switch]$SkipTests,
  [switch]$SkipSnapshot,
  [switch]$SkipCleanCheck,
  [switch]$RequireGroqKey,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Run([string]$Description, [scriptblock]$Action, [switch]$Secret) {
  if ($Secret) {
    Write-Host ">> [secret command hidden]"
  } else {
    Write-Host ">> $Description"
  }
  if (-not $DryRun) {
    & $Action
    if ($LASTEXITCODE -ne 0) {
      throw "Command failed ($LASTEXITCODE): $Description"
    }
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
  Run "npm run lint" { & npm run lint }
  Run "npm run format:check" { & npm run format:check }
  Run "npm run smoke" { & npm run smoke }
  Run "npm run test:auth" { & npm run test:auth }
  Run "npm run test:rental-model" { & npm run test:rental-model }
  Run "npm run test:seed-safety" { & npm run test:seed-safety }
  Run "npm run test:finance" { & npm run test:finance }
  Run "npm run test:development" { & npm run test:development }
  Run "npm run test:ui" { & npm run test:ui }
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
$appBackupDir = "/opt/propertyapp/backups/app-predeploy-$timestamp"

Write-Host ""
Write-Host "Deploy target: CT $ContainerId via $SshHost"
Write-Host "Branch/commit: $branch $commit"
Write-Host "Snapshot: $snapshotName"
Write-Host ""

$keyPath = $null
$localRemoteScript = $null
try {
Run "git archive --format=tar --output `"$archivePath`" HEAD" { & git archive --format=tar --output $archivePath HEAD }
Run "scp application archive" { & scp $archivePath "${SshHost}:$remoteArchive" }

if (-not [string]::IsNullOrWhiteSpace($GroqApiKey)) {
  $keyPath = Join-Path $env:TEMP "propertyapp-groq-key-$timestamp.txt"
  [System.IO.File]::WriteAllText($keyPath, $GroqApiKey, [System.Text.UTF8Encoding]::new($false))
  Run "scp Groq key" { & scp $keyPath "${SshHost}:$remoteKey" } -Secret
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
REMOTE_SCRIPT="$remoteScript"
APP_BACKUP_DIR="$appBackupDir"

cleanup() { rm -rf "`$STAGE" "`$ARCHIVE" "`$REMOTE_KEY" "`$REMOTE_SCRIPT"; }
trap cleanup EXIT

echo "== preflight =="
pct status "`$CT_ID"
pct exec "`$CT_ID" -- bash -lc "test -d '`$APP_DIR' && test -f '`$DB_FILE'"

echo "== backups =="
pct exec "`$CT_ID" -- bash -lc "mkdir -p /opt/propertyapp/data/backups /opt/propertyapp/backups '`$APP_BACKUP_DIR'"
pct exec "`$CT_ID" -- bash -lc "cd '`$APP_DIR' && DB_FILE='`$DB_FILE' UPLOADS_DIR='`$UPLOADS_DIR' BACKUP_INCLUDE_FILES=1 BACKUP_CONFIG_FILE='`$ENV_FILE' node scripts/backup.js /opt/propertyapp/data/backups"
pct exec "`$CT_ID" -- bash -lc "tar --exclude='./node_modules' --exclude='./data' -cf '`$APP_BACKUP_DIR/app.tar' -C '`$APP_DIR' ."

echo "== snapshot =="
$snapshotBlock
if [ "$SnapshotKeep" -gt 0 ]; then
  pct listsnapshot "`$CT_ID" | awk '/predeploy-propertyapp-/ {for (i = 1; i <= NF; i++) if (`$i ~ /^predeploy-propertyapp-/) print `$i}' | sort -r | awk 'NR > $SnapshotKeep' | while IFS= read -r old; do
    [ -z "`$old" ] || pct delsnapshot "`$CT_ID" "`$old"
  done
fi
if [ "$AppBackupKeep" -gt 0 ]; then
  pct exec "`$CT_ID" -- bash -lc "find /opt/propertyapp/backups -mindepth 1 -maxdepth 1 -type d -name 'app-predeploy-*' -printf '%f\\n' | sort -r | awk 'NR > $AppBackupKeep' | while IFS= read -r old; do
    case \"\`$old\" in
      app-predeploy-*) rm -rf -- \"/opt/propertyapp/backups/\`$old\" ;;
      *) echo \"Refusing to remove unexpected backup path: \`$old\" >&2; exit 1 ;;
    esac
  done"
fi

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

echo "== install offsite backup helpers (not enabled until configured) =="
install -d -m 0700 /etc/propertyapp-offsite /var/lib/propertyapp-offsite/staging /mnt/propertyapp-nas
sed -i 's/\r`$//' "`$STAGE/deploy/propertyapp-offsite-backup.sh" "`$STAGE/deploy/propertyapp-offsite-backup.service" "`$STAGE/deploy/propertyapp-offsite-backup.timer" "`$STAGE/deploy/propertyapp-offsite-verify.service" "`$STAGE/deploy/propertyapp-offsite-verify.timer"
install -m 0750 "`$STAGE/deploy/propertyapp-offsite-backup.sh" /usr/local/sbin/propertyapp-offsite-backup
install -m 0644 "`$STAGE/deploy/propertyapp-offsite-backup.service" /etc/systemd/system/propertyapp-offsite-backup.service
install -m 0644 "`$STAGE/deploy/propertyapp-offsite-backup.timer" /etc/systemd/system/propertyapp-offsite-backup.timer
install -m 0644 "`$STAGE/deploy/propertyapp-offsite-verify.service" /etc/systemd/system/propertyapp-offsite-verify.service
install -m 0644 "`$STAGE/deploy/propertyapp-offsite-verify.timer" /etc/systemd/system/propertyapp-offsite-verify.timer
systemctl daemon-reload
if command -v restic >/dev/null 2>&1 && [ -f /etc/propertyapp-offsite/nas.env ] && [ -f /etc/propertyapp-offsite/b2.env ] && mountpoint -q /mnt/propertyapp-nas; then
  systemctl enable --now propertyapp-offsite-backup.timer propertyapp-offsite-verify.timer
else
  echo "Offsite backup awaits restic, NAS mount and /etc/propertyapp-offsite/{nas,b2}.env"
fi

echo "== restart and verify =="
pct exec "`$CT_ID" -- systemctl restart "`$SERVICE_NAME"
pct exec "`$CT_ID" -- systemctl is-active --quiet "`$SERVICE_NAME"
pct exec "`$CT_ID" -- curl -fsS http://127.0.0.1:8090/health

echo "== cleanup =="

echo "Deploy OK: $commit"
echo "DB backups: /opt/propertyapp/data/backups (online snapshot, integrity-checked)"
echo "App backup: `$APP_BACKUP_DIR/app.tar"
"@

$localRemoteScript = Join-Path $env:TEMP "propertyapp-deploy-$commit-$timestamp.sh"
[System.IO.File]::WriteAllText($localRemoteScript, $remoteScriptContent, [System.Text.UTF8Encoding]::new($false))
Run "scp deployment script" { & scp $localRemoteScript "${SshHost}:$remoteScript" }

Run "run deployment on Proxmox" { & ssh $SshHost "bash $remoteScript" }
}
finally {
  foreach ($file in @($archivePath, $keyPath, $localRemoteScript)) {
    if ($file -and (Test-Path -LiteralPath $file)) {
      Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    }
  }
}

Write-Host ""
Write-Host "Public smoke:"
Run "curl.exe -I https://propertyapp.familyos.pl" { & curl.exe -I https://propertyapp.familyos.pl }
