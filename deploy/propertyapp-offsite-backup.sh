#!/usr/bin/env bash
# Szyfrowany backup poza CT: lokalny NAS i/lub S3 (np. Backblaze B2).
set -euo pipefail
umask 077

CT_ID="${PROPERTYAPP_CT_ID:-109}"
APP_DIR="${PROPERTYAPP_APP_DIR:-/opt/propertyapp/app}"
DB_FILE="${PROPERTYAPP_DB_FILE:-/opt/propertyapp/data/property.db}"
UPLOADS_DIR="${PROPERTYAPP_UPLOADS_DIR:-/opt/propertyapp/data/uploads}"
ENV_FILE="${PROPERTYAPP_ENV_FILE:-/etc/propertyapp/auth.env}"
CT_STAGE="${PROPERTYAPP_CT_STAGE:-/opt/propertyapp/data/offsite-staging}"
HOST_STAGE="${PROPERTYAPP_HOST_STAGE:-/var/lib/propertyapp-offsite/staging}"
CONFIG_DIR="${PROPERTYAPP_OFFSITE_CONFIG_DIR:-/etc/propertyapp-offsite}"
LOCK_FILE="/run/lock/propertyapp-offsite-backup.lock"

log() { printf '[propertyapp-offsite] %s\n' "$*"; }
fail() { log "ERROR: $*" >&2; exit 1; }

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "brak wymaganego polecenia: $1"
}

for cmd in pct restic flock find sqlite3; do require_command "$cmd"; done

mode="${1:-backup}"
case "$mode" in backup|verify) ;; *) fail "użycie: $0 [backup|verify]" ;; esac

mkdir -p "$(dirname "$LOCK_FILE")" "$HOST_STAGE"
exec 9>"$LOCK_FILE"
flock -n 9 || fail "backup już działa"

load_repository() {
  local config="$1"
  [ -f "$config" ] || fail "brak konfiguracji repozytorium: $config"
  # Pliki konfiguracji są własnością root i mają tryb 0600.
  # shellcheck disable=SC1090
  set -a
  source "$config"
  set +a
  : "${RESTIC_REPOSITORY:?brak RESTIC_REPOSITORY w $config}"
  : "${RESTIC_PASSWORD_FILE:?brak RESTIC_PASSWORD_FILE w $config}"
  [ -r "$RESTIC_PASSWORD_FILE" ] || fail "brak pliku hasła restic: $RESTIC_PASSWORD_FILE"
}

run_restic() {
  local target="$1" config="$2"
  log "repozytorium: $target"
  load_repository "$config"
  if ! restic cat config >/dev/null 2>&1; then
    log "inicjalizacja repozytorium $target"
    restic init
  fi
  if [ "$mode" = "backup" ]; then
    restic backup --tag propertyapp --tag "$target" "$HOST_STAGE"
    restic forget --prune --keep-daily 14 --keep-weekly 8 --keep-monthly 12
    return
  fi

  restic check --read-data-subset=5%
  local restore_dir="$HOST_STAGE/restore-$target"
  rm -rf -- "$restore_dir"
  mkdir -p "$restore_dir"
  restic restore latest --target "$restore_dir"
  local restored_db
  restored_db="$(find "$restore_dir" -type f -name 'property-*.db' -print -quit)"
  [ -n "$restored_db" ] || fail "test odtworzenia $target nie zawiera bazy"
  [ "$(sqlite3 "$restored_db" 'PRAGMA integrity_check;')" = "ok" ] || fail "odtworzona baza $target nie przeszła integrity_check"
  rm -rf -- "$restore_dir"
  log "test odtworzenia $target: OK"
}

prepare_online_snapshot() {
  rm -rf -- "$HOST_STAGE"/*
  pct exec "$CT_ID" -- bash -lc "set -euo pipefail
    rm -rf '$CT_STAGE'
    mkdir -p '$CT_STAGE'
    cd '$APP_DIR'
    DB_FILE='$DB_FILE' UPLOADS_DIR='$UPLOADS_DIR' BACKUP_INCLUDE_FILES=1 BACKUP_CONFIG_FILE='$ENV_FILE' BACKUP_KEEP=1 node scripts/backup.js '$CT_STAGE'
  "
  local db_name files_name
  db_name="$(pct exec "$CT_ID" -- bash -lc "find '$CT_STAGE' -maxdepth 1 -type f -name 'property-*.db' -printf '%f\\n'")"
  files_name="$(pct exec "$CT_ID" -- bash -lc "find '$CT_STAGE' -maxdepth 1 -type f -name 'property-*-recovery-files.tar.gz' -printf '%f\\n'")"
  [ "$(printf '%s\n' "$db_name" | sed '/^$/d' | wc -l)" -eq 1 ] || fail "niejednoznaczny plik bazy w CT"
  [ "$(printf '%s\n' "$files_name" | sed '/^$/d' | wc -l)" -eq 1 ] || fail "brak archiwum odtworzeniowego w CT"
  pct pull "$CT_ID" "$CT_STAGE/$db_name" "$HOST_STAGE/$db_name" --perms 0600
  pct pull "$CT_ID" "$CT_STAGE/$files_name" "$HOST_STAGE/$files_name" --perms 0600
  pct exec "$CT_ID" -- rm -rf "$CT_STAGE"
}

if [ "$mode" = "backup" ]; then
  prepare_online_snapshot
fi

run_restic nas "$CONFIG_DIR/nas.env"
run_restic b2 "$CONFIG_DIR/b2.env"
log "zakończono: $mode"
