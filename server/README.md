# rememberKey Go backend

Requires Go 1.23+; `modernc.org/sqlite` is pure Go (CGO disabled supported).

```sh
go mod tidy
go test ./...
go test -race ./... # requires race-supported platform and C compiler
go vet ./...
go build -trimpath -o rememberkey .
```

Run behind the approved HTTPS reverse proxy:

```sh
RK_ORIGIN=https://vault.example.com RK_DATA_DIR=/data RK_WEB_DIR=/app/web RK_BOOTSTRAP_TOKEN='<random-bootstrap-token>' ./rememberkey
```

Development is explicit: `RK_DEV=true RK_ORIGIN=http://localhost:8080`; only loopback origins are allowed. Listen address defaults to `:8080` and can be changed with `RK_ADDR` (for example `RK_ADDR=127.0.0.1:8099`); an unbindable address fails fast at startup and the logged address is the one actually bound. Development operators should bind/publish the port only on loopback. Production refuses HTTP origins. The Go service itself is plain HTTP for the internal proxy hop; do **not** expose it directly to the Internet. Origin must be present and exact for every API write, including CLI/native clients. Cross-origin access and CORS are not enabled. Trust neither forwarded Origin nor X-Forwarded-For; rate limiting uses the connection address (behind a proxy this intentionally shares a quota unless a future trusted-proxy policy is implemented).

## Storage and authorization

One SQLite database (`rememberkey.sqlite`) with per-account composite keys isolates each user's encrypted logical vault. No per-user physical database is claimed. Account/device/session state is checked in the same transaction as every protected write. A process-level mutex serializes transactions; this favors correctness over throughput for a small self-hosted deployment. WAL, busy timeout and one SQL connection avoid write-upgrade races within this process. Deploy only one application replica. Multiple replicas and horizontal throughput are not validated.

Opaque access and refresh tokens and invitations are SHA-256 hashed at rest. Refresh rotations retain used tokens to detect reuse and revoke the entire family. Failed signatures consume challenges; used challenges are retained. Logs, tombstones, idempotency results and token history are not pruned in v1. Back up the database using SQLite's backup tooling or stop the server before copying the database and WAL together; encrypted data still needs access control and reliable backups.

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
