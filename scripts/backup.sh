#!/usr/bin/env bash
# Optional argument: absolute path for a NEW archive outside the data directory.
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
require_host
require_config
require_running
[[ $# -le 1 ]] || { echo 'Usage: sudo bash scripts/backup.sh [ARCHIVE]' >&2; exit 1; }
archive=${1:-"$DEPLOY/backups/rememberkey-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"}
[[ $archive == /* ]] || { echo 'Archive must be an absolute path.' >&2; exit 1; }
compose stop app
trap resume_app EXIT
python3 "$ROOT/scripts/snapshot.py" backup "$DEPLOY/data" "$archive"
