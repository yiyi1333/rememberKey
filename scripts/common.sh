#!/usr/bin/env bash
# Source from scripts; never source untrusted env files.
set -Eeuo pipefail
umask 077
ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
DEPLOY="$ROOT/deploy"
require_host() {
  [[ $(uname -s) == Linux ]] || { echo 'Linux host required.' >&2; exit 1; }
  [[ $EUID -eq 0 ]] || { echo 'Run with sudo on a trusted checkout.' >&2; exit 1; }
  for tool in docker python3 flock; do command -v "$tool" >/dev/null || { echo "Missing: $tool" >&2; exit 1; }; done
  docker compose version >/dev/null
  exec 9>"$DEPLOY/.operation.lock"
  flock -n 9 || { echo 'Another deployment/backup/restore is running.' >&2; exit 1; }
}
compose() { docker compose --project-directory "$DEPLOY" --env-file "$DEPLOY/.env" -f "$DEPLOY/compose.yaml" "$@"; }
require_config() { [[ -f "$DEPLOY/.env" && ! -L "$DEPLOY/.env" ]] || { echo 'Run deploy.sh first.' >&2; exit 1; }; }
require_running() {
  [[ -n $(compose ps --status running -q app) ]] || { echo 'App must be running before this operation.' >&2; exit 1; }
}
resume_app() { compose up -d --wait --wait-timeout 120 app; }
