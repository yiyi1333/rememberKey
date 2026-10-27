#!/usr/bin/env bash
# Usage: sudo bash scripts/deploy.sh vault.example.com admin@example.com
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
require_host
if [[ ! -e "$DEPLOY/.env" ]]; then
  [[ $# -eq 2 ]] || { echo 'Usage: sudo bash scripts/deploy.sh DOMAIN ACME_EMAIL' >&2; exit 1; }
  python3 - "$DEPLOY" "$1" "$2" <<'PY'
import os, re, secrets, sys
from pathlib import Path
path, domain, email = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
if not re.fullmatch(r'(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?', domain):
    raise SystemExit('Use a public DNS hostname, without scheme/port/path/wildcards.')
if not re.fullmatch(r'[A-Za-z0-9.!+_-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}', email):
    raise SystemExit('Invalid ACME email (only conservative unquoted addresses supported).')
domain = domain.lower()
with (path / '.env').open('x') as f:
    os.chmod(f.name, 0o600)
    f.write(f'RK_DOMAIN={domain}\nRK_ORIGIN=https://{domain}\nACME_EMAIL={email}\nRK_BOOTSTRAP_TOKEN={secrets.token_urlsafe(32)}\n')
PY
else
  [[ $# -eq 0 ]] || { echo 'Configuration exists. Re-run without arguments; review deploy/.env manually to change domain.' >&2; exit 1; }
fi
require_config
python3 - "$DEPLOY" <<'PY'
import os, sys
from pathlib import Path
p = Path(sys.argv[1])
for name in ('data', 'caddy-data', 'caddy-config'):
    d = p / name
    if d.is_symlink(): raise SystemExit(f'Refusing symlink: {d}')
    d.mkdir(mode=0o700, exist_ok=True)
    os.chown(d, 10001, 10001)
    os.chmod(d, 0o700)
os.chmod(p / '.env', 0o600)
PY
compose config --quiet
compose build --pull app
compose up -d --wait --wait-timeout 180
printf '\nDeployment started. DNS must point here; allow inbound TCP 80/443.\n'
printf 'Read the single-use RK_BOOTSTRAP_TOKEN privately from deploy/.env to register the initial admin.\nNever paste it into logs or a public issue. It is not printed by this script.\n'
