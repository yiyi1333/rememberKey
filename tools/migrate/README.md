# Offline MySQL → D1 migration

Run from `tools/migrate`: `go run ./cmd/migrate export --out NEW_DIRECTORY`.
Only `RK_MIGRATION_MYSQL_DSN` supplies connection details. Never put a DSN on
the command line. Freeze **all** source writes before the final export; MySQL
AUTO_INCREMENT metadata is not transaction-versioned. The tool starts a read-only
repeatable-read transaction, requires seven InnoDB tables, streams rows in binary
primary-key order, and publishes `manifest.json` only after successful validation.
It never decrypts or rewrites signed opaque JSON. No old-server source changes.

Manifest v1: `format=rememberKey-mysql-d1`, `version=1`,
`digestEncoding=typed-tuples-ascii-json-lf-v1`. Each JSONL row is a compact array
of `[type,value]` tuples in the manifest's fixed column order. Type is `text` or
`integer`; text values are canonical RFC4648 base64 of **valid UTF-8 bytes**,
integers are canonical nonnegative decimal strings, NULL is JSON null. Each row
ends with LF. SHA-256 hashes the exact concatenation, including each LF. All
hashed values are ASCII, preventing Go/JavaScript JSON escaping differences.
Empty text is base64 `""`, distinct from null. No Unicode normalization occurs.
Binary key order matches SQLite BINARY, and ASCII NOCASE username collisions
are rejected. MySQL Unicode/accent collation behavior is not reproduced by D1;
source table collations are recorded for operator review before cutover.

SQL is generated only from fixed mapped tables and columns. Text becomes
`CAST(X'hex' AS TEXT)`, never a quoted data string. Every row uses a plain INSERT.
SQL statement size is conservatively capped at 90 KiB (below D1's 100KB SQL
statement limit), each chunk at 512 KiB. This is a conservative local bound, not
proof of current remote account limits: check the actual plan and platform
limits before a real migration. Oversized rows abort; no truncation occurs.
Source `changes/audit` high water is max(max(seq), AUTO_INCREMENT-1), and target
sqlite_sequence is explicitly initialized, retaining deleted sequence holes.

Apply the checked-in D1 schema to a **new** isolated local database, then from
the repository root:

```
node worker/scripts/migrate-d1.mjs --source EXPORT --env preview --local --persist-to ISOLATED_STATE
node worker/scripts/verify-d1.mjs --source EXPORT --env preview --local --persist-to ISOLATED_STATE
```

Both scripts require explicit environment and local/remote mode. Production is
remote-only and requires a configured nonzero database ID. Local defaults to
`.tools/migration/d1-local`; always choose a fresh `--persist-to` for rehearsals.
Wrangler is invoked as Node plus argument arrays, without a shell. Its installed
version must match the lockfile. The importer revalidates every JSONL row,
reconstructs all allowed SQL and verifies ordered chunk content, counts and
hashes. It checks target column types, primary keys, username NOCASE and sequence
schema, and refuses any persistent/session/challenge data. D1 migration/system
records are permitted. Extra directory files are never executed.

A failed chunk import leaves a partial **private** database. There is no resume,
merge or REPLACE mode. Keep the Pages entry closed and retry into a fresh empty
database. The importer does not publish an endpoint or open a maintenance gate.
Run full verification before opening the entry: keyset scans cast integers to
TEXT, compare every row/count/byte digest, check transient tables, active admin,
and sequence high water. Used invitations and revoked devices are covered by
these exact comparisons. Reports show counts and hashes, not account contents.

Export files contain sensitive account metadata and encrypted vault material.
Store them in access-controlled encrypted backup storage; do not upload them as
public CI artifacts. `.tools/migration/` is ignored, but external paths must be
protected separately. A failed export directory is intentionally retained for
diagnosis and cannot be overwritten. Remove it manually only after review.

`go run ./cmd/fixtures` regenerates the independently encoded Go operation hash
fixture. `go test ./...` runs exporter/preflight tests. Optional synthetic export:
set `RK_SYNTHETIC_EXPORT_OUT` to a new path and run `go test -run TestWriteRehearsal`.
This fixture proves data transport, not real MySQL or real-account decryption.
