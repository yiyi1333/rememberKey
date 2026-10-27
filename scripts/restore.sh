#!/usr/bin/env bash
# Usage: sudo bash scripts/restore.sh /absolute/trusted-backup.tar.gz --confirm-restore
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
require_host
require_config
[[ $# -eq 2 && $1 == /* && $2 == --confirm-restore ]] || { echo 'Usage: sudo bash scripts/restore.sh /absolute/trusted-backup.tar.gz --confirm-restore' >&2; exit 1; }
require_running
compose stop app
trap resume_app EXIT
# Never overwrite a deployment without first saving its current database.
python3 "$ROOT/scripts/snapshot.py" backup "$DEPLOY/data" "$DEPLOY/backups/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
python3 "$ROOT/scripts/snapshot.py" restore "$DEPLOY/data" "$1"
