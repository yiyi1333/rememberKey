# rememberKey v1 contract

Implementation baseline. JSON field names are camelCase. Base URL `/api/v1`. Responses `{data: ...}`; errors `{error:{code,message}}`. All binary is base64url **without padding**. UUIDs generated client side. Account IDs server generated. Dates RFC3339 UTC. No plaintext secret fields accepted by server.

## Crypto v1
libsodium: Argon2id13 (opslimit=3, memlimit=67108864; salt=16 bytes), Ed25519 detached signatures, X25519 sealed boxes, XChaCha20-Poly1305-IETF. Envelope fields validated exactly. Password wrapping KDF parameters fixed in v1 to prevent attacker-supplied resource exhaustion. All encryption uses fresh 24-byte random nonce.

User chooses username and password, client generates `accountId` UUID (server validates uniqueness). Client generates rootKey=32 bytes, identity signing and box keypairs. `keyBundle` is JSON object:
`{version:1,salt,passwordWrap:{nonce,ciphertext},recoveryWrap:{nonce,ciphertext},privateWrap:{nonce,ciphertext}}`.
passwordWrap AEAD encrypts rootKey under Argon2id(password,salt), AAD=`rememberKey:root:1:${accountId}`. Recovery code is random 32-byte base64url; recoveryWrap encrypts rootKey directly under decoded recovery code with same AAD. privateWrap encrypts UTF-8 JSON `{signPrivateKey,boxPrivateKey}` under rootKey, AAD=`rememberKey:private:1:${accountId}`.
Account public keys are `signPublicKey` (32 bytes), `boxPublicKey` (32 bytes).
Device Ed25519 keypair generated locally. Device private key encrypted by rootKey with AAD=`rememberKey:device:1:${accountId}:${deviceId}`. Device registration proof signed by account key over UTF-8 `rememberKey:device:1:${accountId}:${deviceId}:${devicePublicKey}`.
Record plaintext `{name,provider,secret,url,tags,notes,expiresAt}` UTF-8 JSON. Envelope `{version:1,nonce,ciphertext,wrappedKey}`. DataKey 32 bytes; ciphertext AEAD encrypted with AAD=`rememberKey:record:1:${accountId}:${recordId}`; wrappedKey=sealed box(dataKey, account box public key). Records signed as described below. Key version is 1 (no full rotation UI in first implementation).

## Bootstrapping and accounts
- GET `/status` -> `{initialized:boolean}` (public)
- POST `/registrations` body `{inviteToken,accountId,username,signPublicKey,boxPublicKey,keyBundle,device:{id,name,publicKey,proof}}` -> 201 `{accountId}`. `inviteToken` is RK_BOOTSTRAP_TOKEN for initial admin, single transaction ensures only one bootstrap. Afterwards admin-created invitation is required. Does not implicitly authenticate. Server never generates account secrets.
- GET `/accounts/lookup?username=...` -> `{accountId,username,signPublicKey,boxPublicKey,keyBundle}` public for local unlock; rate limited; account enumeration an acknowledged tradeoff v1. No server password reset. Disabled account rejected. Account signPublicKey is pinned against cached local value to detect change.
- POST `/auth/challenges` `{accountId,deviceId}` -> `{id,message,expiresAt}`. `message` opaque server-generated text includes configured RK_ORIGIN, IDs and random nonce. Stored hashed or random nonce, expires 2 min, consumed atomically even on bad signature. Rate limited. Only registered active devices.
- POST `/auth/sessions` `{challengeId,signature}` -> `{accessToken,expiresAt,accountId}`; sets refresh cookie. Access token opaque random, DB hashed, 15 min. Browser requests credentials include. Desktop also uses same-origin local bridge unless secure native refresh is implemented; no localStorage bearer persistence.
- POST `/auth/refresh` -> new access response; rotate Secure HttpOnly SameSite=Strict cookie path `/api/v1/auth`; track family and detect reuse. Development localhost HTTP cookie may omit Secure only with explicit RK_DEV=true. Origin checking against RK_ORIGIN required for writes (same origin browser; desktop allowed origin must be explicit).
- DELETE `/auth/sessions` revoke current family, clear cookie -> 204.
- POST `/devices` `{accountId,id,name,publicKey,proof}` public but account-authorized via proof -> 201. Disabled accounts cannot enroll. Duplicate same-device proof registration idempotent, revoked IDs cannot reenroll.
- GET `/devices` authenticated -> list `{id,name,createdAt,revokedAt}`.
- DELETE `/devices/:id` authenticated, own -> 204; revoke device sessions.
- GET `/me` -> `{accountId,username,role,signPublicKey,boxPublicKey,keyBundle}`.
- PUT `/key-bundle` `{keyBundle,expectedVersion,signature}` sign `rememberKey:bundle:1:${accountId}:${expectedVersion}:${sha256hex(JSON.stringify(keyBundle))}` -> `{version}`. JSON.stringify order preserved by raw server decoding or canonical order; use a wire `bundleJson` string instead of object for this endpoint: body `{bundleJson,expectedVersion,signature}`; signature digest over exact UTF8 bundleJson. Initial bundleVersion=1. Password change rewrap only; privateWrap immutable unless future protocol.

## Sync
- GET `/sync/changes?cursor=0&limit=100` -> `{changes:[{seq,id,revision,deleted,envelope,signature,operationId,baseRevision}],cursor,hasMore}` ordered monotonically per account (global SQLite seq gaps acceptable); stable snapshot upper bound per page. `cursor` advances to last returned seq or account latest seq if none. Retain tombstones and logs in v1 (no pruning); future expired cursors 410 require snapshot resync.
- GET `/sync/snapshot` -> `{records:[{id,revision,deleted,envelope,signature,operationId,baseRevision}],cursor}` transaction-consistent. Initial version bounded maximum records; pagination explicitly TODO before large scale.
- POST `/sync/operations` `{operations:[{operationId,id,baseRevision,deleted,envelope,signature}]}` max 100. Envelope null on delete. Account signature UTF8 `rememberKey:op:1:${accountId}:${operationId}:${id}:${baseRevision}:${deleted ? '1':'0'}:${sha256hex(envelopeJson or '')}`. To avoid JSON canonicalization ambiguity envelope wire representation is a **JSON string** (or null); client preserves exact string and server stores opaque validated JSON string. Signature via account identity key, so clients can verify operation after server sync.
Response `{results:[{operationId,status:'applied'|'conflict',record:{id,revision,deleted,envelope,signature,operationId,baseRevision}}]}`. Batch processes per-op atomic transactions, preserves ordering; conflict gives current record or null. Applied results persisted per account + operationId; reused ID with different body -> 409. Revision 0 means not yet created; delete increments revision; update after tombstone must explicitly match current revision. Server computes revision. Queue client retains exact signed ops for retry; client never auto-overwrites conflict. Request auth checked inside write transaction against current account and device revocation.

## Admin
- GET `/admin/users` -> list `{accountId,username,role,disabled,createdAt}`.
- PATCH `/admin/users/:id` `{disabled:boolean}` -> updated safe account. Cannot disable self or last admin. Disabling atomically revokes sessions.
- POST `/admin/invitations` -> 201 `{token,expiresAt}` 24h, single use hashed at rest.
- GET `/admin/audit?cursor=0&limit=100` -> `{events:[{seq,actorId,action,targetId,createdAt}],cursor,hasMore}` no secrets.
- GET `/healthz`, `/readyz` outside API. Requests body max 2 MiB; max envelope 128 KiB; usernames trimmed 3-64 chars; no secret logging.

## Deployment
Go server embedded frontend via Docker copy at `/app/web`; RK_WEB_DIR path. RK_DATA_DIR writable SQLite. RK_ORIGIN required production, exact origin (https://...). RK_BOOTSTRAP_TOKEN generated by init script, stored protected env; single use initial admin. Bind :8080 internally; nonroot container uid=10001 with volume initialized safely. Reverse proxy Caddy. RK_DEV=true localhost-only development.

## Local storage
A single account per browser profile/server origin; switching requires explicit clearing pending changes confirmation. Persist only encrypted record envelopes, encrypted keyBundle, public keys, encrypted device private key, signed encrypted outbox, revision/cursor metadata. No decrypted form data in localStorage, IndexedDB or SW. Persist record + outbox in one IndexedDB/SQLite transaction. Password and recovery code only memory. Offline unlock via cached bundle then private key validation. Auto-lock clears secret UI and in-memory key references. Recovery code displayed once and encrypted export optional; not stored plaintext.

## Scope truth
Full rotation, retention/pruning, large snapshot pagination, independently signed release distribution, hardware key support, team sharing are NOT v1. Desktop native credential refresh may require followup; desktop must not claim completed native security storage until implemented/tested.
