#!/usr/bin/env bash
# Usage: sudo bash scripts/restore.sh /absolute/trusted-backup.sql.gz --confirm-restore
# Restores a logical dump produced by backup.sh. The current database is dumped
# aside first, so a mistaken restore can be reversed.
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
require_host
require_config
[[ $# -eq 2 && $1 == /* && $2 == --confirm-restore ]] || { echo 'Usage: sudo bash scripts/restore.sh /absolute/trusted-backup.sql.gz --confirm-restore' >&2; exit 1; }
[[ -f $1 && ! -L $1 ]] || { echo 'Backup must be a regular, non-symlink file.' >&2; exit 1; }
require_running
# shellcheck disable=SC1090
set -a; . "$DEPLOY/.env"; set +a
: "${RK_DB_NAME:?}" "${RK_DB_USER:?}" "${RK_DB_PASSWORD:?}"

mkdir -p -- "$DEPLOY/backups"
pre="$DEPLOY/backups/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
compose exec -T -e MYSQL_PWD="$RK_DB_PASSWORD" db \
  mysqldump --single-transaction --routines --triggers --no-tablespaces \
  -u "$RK_DB_USER" "$RK_DB_NAME" | gzip -9 > "$pre"
chmod 600 "$pre"
printf 'Current database saved to %s\n' "$pre"

# Stop the app so no writes land during the reload, then drop and recreate the
# schema so leftover tables cannot survive a partial restore.
compose stop app
trap resume_app EXIT
compose exec -T -e MYSQL_PWD="$RK_DB_PASSWORD" db \
  mysql -u "$RK_DB_USER" -e "DROP DATABASE IF EXISTS \`$RK_DB_NAME\`; CREATE DATABASE \`$RK_DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
gunzip -c "$1" | compose exec -T -e MYSQL_PWD="$RK_DB_PASSWORD" db \
  mysql -u "$RK_DB_USER" "$RK_DB_NAME"
printf 'Restore complete. Users still need their own master password or recovery code.\n'