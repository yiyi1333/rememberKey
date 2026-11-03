# rememberKey Go backend

Requires Go 1.23+ and a MySQL 8.0+ server. The driver is `github.com/go-sql-driver/mysql` (pure Go; CGO is not required).

```sh
go mod tidy
go vet ./...
go build -trimpath -o rememberkey .
# Unit/integration tests need a disposable MySQL database (see below).
RK_TEST_DSN='user:pass@tcp(127.0.0.1:3306)/rememberkey' go test ./...
```

Tests create and drop their own uniquely named `rk_test_*` databases, so the test account needs rights on that prefix. Without `RK_TEST_DSN` the suite skips loudly rather than reporting a false pass.

```sql
CREATE DATABASE rememberkey CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'rk'@'%' IDENTIFIED BY '<password>';
GRANT ALL PRIVILEGES ON `rememberkey`.* TO 'rk'@'%';
GRANT ALL PRIVILEGES ON `rk_test_%`.* TO 'rk'@'%';  -- test databases only
```

Run behind the approved HTTPS reverse proxy:

```sh
RK_ORIGIN=https://vault.example.com \
RK_DB_DSN='rk:<password>@tcp(db:3306)/rememberkey?parseTime=true&charset=utf8mb4&loc=UTC' \
RK_WEB_DIR=/app/web RK_BOOTSTRAP_TOKEN='<random-bootstrap-token>' ./rememberkey
```

`RK_DB_DSN` is required; startup fails fast if it is missing or unreachable. Do not enable `multiStatements` — the schema is applied one statement at a time precisely so that protection stays on.

Development is explicit: `RK_DEV=true RK_ORIGIN=http://localhost:8080`; only loopback origins are allowed. Listen address defaults to `:8080` and can be changed with `RK_ADDR` (for example `RK_ADDR=127.0.0.1:8099`); an unbindable address fails fast at startup and the logged address is the one actually bound. Development operators should bind/publish the port only on loopback. Production refuses HTTP origins. The Go service itself is plain HTTP for the internal proxy hop; do **not** expose it directly to the Internet. Origin must be present and exact for every API write, including CLI/native clients. Cross-origin access and CORS are not enabled. Trust neither forwarded Origin nor X-Forwarded-For; rate limiting uses the connection address (behind a proxy this intentionally shares a quota unless a future trusted-proxy policy is implemented).

## Storage and authorization

One MySQL schema with per-account composite keys isolates each user's encrypted logical vault. No per-user physical database is claimed. Account/device/session state is revalidated in the same transaction as every protected write. Pool size is bounded (16 open / 8 idle) and per-request transactions use READ COMMITTED.

**Concurrency.** Correctness no longer relies on a process-wide mutex or a single connection. Serialization comes from `SELECT ... FOR UPDATE` on the rows a request depends on:

- **Record writes** lock the record row and only apply when the stored revision still equals the operation's base revision; a lost insert race surfaces as a normal conflict via duplicate-key detection.
- **Challenge consumption** locks the challenge row, so a replayed challenge cannot mint two sessions.
- **Refresh rotation** locks the refresh row, so two concurrent uses cannot both rotate; the loser is treated as replay and revokes the family.
- **First-admin bootstrap** serializes on a `bootstrap_lock` row, so two concurrent first registrations cannot both become admin.

Because atomicity is now per-row rather than process-wide, **multiple application replicas can serve traffic**. Horizontal throughput beyond a few instances is still untested, and there is no migration tooling yet: `CREATE TABLE IF NOT EXISTS` is idempotent, but future column changes need explicit versioned migrations before upgrades.

Opaque access and refresh tokens and invitations are SHA-256 hashed at rest. Refresh rotations retain used tokens to detect reuse and revoke the entire family. Failed signatures consume challenges; used challenges are retained. Logs, tombstones, idempotency results and token history are not pruned in v1. Back up with `mysqldump --single-transaction`; encrypted data still needs access control and reliable backups.

Public lookup deliberately returns encrypted key bundles so that clients can unlock locally. **This enables account enumeration and offline password guessing against passwordWrap.** Fixed Argon2id parameters slow but do not eliminate guessing; users need strong passwords. Server rate limiting cannot protect a bundle once downloaded. The server has no recovery plaintext, root keys, private keys or password-reset capability. Structural validation and signatures do not prove ciphertext decryptability; clients must authenticate/decrypt and pin identity keys.

## Wire behavior

See `openapi.yaml` and the root protocol. All writes require Origin, JSON is strict (unknown fields rejected), request bodies are capped at 2 MiB, envelopes at 128 KiB, batches at 100. Replayed exact operation IDs return the persisted result; changed bodies return 409. Conflict results are persisted too so later retries cannot become silent overwrites. Earlier operations can commit before a later invalid operation aborts a batch request; retry the exact batch safely.

The initial key-bundle version is 1. `/me` includes `bundleVersion` for optimistic updates. Bundle updates preserve `privateWrap`; full key rotation is not implemented. Exact device-proof duplicates succeed but revoked IDs are permanent. Snapshot bounds include tombstones: maximum 10000 records; larger snapshots return `snapshot_too_large` and need a future paginated snapshot implementation. Administrative lists are also intended for small installations.

## Security/deployment limits

- HTTPS certificates, proxy headers/HSTS, request timeouts on the reverse proxy, volume permissions and secure bootstrap-token provisioning are deployment responsibilities.
- Static files are served only from configured `RK_WEB_DIR`; no SPA history fallback is added. The frontend should use hash routing or static routes.
- Process-local rate limits are 30 requests/minute per remote address and sensitive endpoint. They are not distributed, and proxy deployments share their proxy address quota.
- No automated key rotation, public release signing, retention pruning, hardware-backed device keys, multi-region replication or native OS credential refresh implementation is claimed.
- Existing schema initialization is idempotent. Future schema migrations need explicit versioned migration tooling before upgrades.
- This is a working v1 implementation, not a claim of independent cryptographic/security audit.
