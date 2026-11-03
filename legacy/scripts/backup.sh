#!/usr/bin/env bash
# Optional argument: absolute path for a NEW archive outside the data directory.
# A logical mysqldump is used rather than copying the data directory, so the
# backup is consistent while the database keeps running and is portable
# across MySQL patch versions.
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
require_host
require_config
require_running
[[ $# -le 1 ]] || { echo 'Usage: sudo bash scripts/backup.sh [ARCHIVE]' >&2; exit 1; }
archive=${1:-"$DEPLOY/backups/rememberkey-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"}
[[ $archive == /* ]] || { echo 'Archive must be an absolute path.' >&2; exit 1; }
mkdir -p -- "$(dirname -- "$archive")"
# shellcheck disable=SC1090
set -a; . "$DEPLOY/.env"; set +a
: "${RK_DB_NAME:?}" "${RK_DB_USER:?}" "${RK_DB_PASSWORD:?}"

# --single-transaction gives a consistent snapshot of InnoDB tables without
# locking writers, so the application stays available during the backup.
compose exec -T -e MYSQL_PWD="$RK_DB_PASSWORD" db \
  mysqldump --single-transaction --routines --triggers --no-tablespaces \
  -u "$RK_DB_USER" "$RK_DB_NAME" | gzip -9 > "$archive"
chmod 600 "$archive"
printf 'Backup written to %s\n' "$archive"
printf 'This archive holds encrypted vault ciphertext plus account metadata.\n'
printf 'Restoring it does NOT restore user passwords or keys: users still need\n'
printf 'their own master password or recovery code to decrypt anything.\n'