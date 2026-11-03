/**
 * rememberKey account, device, session and key-bundle routes.
 *
 * Ported from the Go server (server/routes.go + server/main.go): PROTOCOL.md v1
 * clients must observe identical statuses, error codes and payload shapes.
 *
 * D1 has no interactive transactions, so every multi-row write is issued as a
 * single `db.batch(...)` call (executed atomically by D1) and the affected-row
 * counts are used to detect lost races, mirroring the Go transaction logic.
 */

import {
  bundleMessage,
  bundleValid,
  decode64,
  digest,
  isUuid,
  now,
  parseDevice,
  token,
  validDevice,
  verify,
} from './crypto';
import { all, batch, changed, one, run, stmt, unixNow } from './db';
import {
  REFRESH_COOKIE,
  clearRefreshCookie,
  cookieValue,
  errorResponse,
  fail,
  json,
  noContent,
  readBody,
  refreshCookie,
  rfc3339,
} from './http';
import type { Identity, RouteContext } from './types';

const BEARER_PREFIX = 'Bearer ';
/** Go: `15 * time.Minute` for access tokens. */
const ACCESS_TTL_SECONDS = 15 * 60;
/** Go: `30 * 24 * time.Hour` for refresh tokens. */
const REFRESH_TTL_SECONDS = 30 * 24 * 3600;
/** Go: `2 * time.Minute` challenge lifetime. */
const CHALLENGE_TTL_SECONDS = 2 * 60;

interface CountRow {
  n: number;
}

interface AuthRow {
  account: string;
  device: string;
  family: string;
  role: string;
  sign_key: string;
}

interface LookupRow {
  id: string;
  username: string;
  sign_key: string;
  box_key: string;
  bundle: string;
}

interface MeRow {
  username: string;
  sign_key: string;
  box_key: string;
  bundle: string;
  role: string;
  bundle_version: number;
}

interface SignKeyRow {
  sign_key: string;
}

interface DeviceRow {
  pub: string;
  proof: string;
  revoked: string | null;
}

interface DeviceListRow {
  id: string;
  name: string;
  created: string;
  revoked: string | null;
}

interface ChallengeRow {
  account: string;
  device: string;
  message: string;
  expires: number;
  used: number;
}

interface PubRow {
  pub: string;
}

interface InvitationRow {
  used: number;
  expires: number;
}

interface RefreshRow {
  family: string;
  account: string;
  used: number;
  expires: number;
  revoked: number;
}

interface BundleRow {
  bundle: string;
  bundle_version: number;
}

interface SessionPayload {
  accessToken: string;
  accountId: string;
  expiresAt: string;
}

interface IssuedSession {
  session: SessionPayload;
  cookie: string;
}

const AUTH_LOOKUP_SQL = `SELECT a.id AS account, d.id AS device, f.id AS family, a.role AS role, a.sign_key AS sign_key
  FROM access_tokens t
  JOIN families f ON f.id = t.family
  JOIN accounts a ON a.id = f.account
  JOIN devices d ON d.account = f.account AND d.id = f.device
  WHERE t.hash = ? AND t.expires > ? AND f.revoked = 0 AND a.disabled = 0 AND d.revoked IS NULL`;

const ACCOUNT_SELECT_COLUMNS = 'id, username, sign_key, box_key, bundle, role, created';

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint failed/i.test(message);
}

/**
 * Runs a registration batch. Go maps *any* account insert failure to
 * `409 account_exists`; duplicate ids/usernames are the only realistic cause,
 * so only SQLite UNIQUE violations are translated and everything else is
 * allowed to bubble up as `500 internal_error`.
 */
async function registrationBatch(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<D1Result[]> {
  try {
    return await batch(db, statements);
  } catch (error) {
    if (isUniqueViolation(error)) throw fail(409, 'account_exists');
    throw error;
  }
}

interface IssuedStatements {
  statements: D1PreparedStatement[];
  session: SessionPayload;
  cookie: string;
}

/**
 * Builds the statements that mint an access/refresh token pair for `family`.
 * With `gated: true` both inserts only fire when the preceding statement in the
 * same batch changed a row (`changes() = 1`), which lets the refresh rotation
 * compare-and-set and the new token inserts commit atomically.
 */
async function buildSession(
  db: D1Database,
  family: string,
  account: string,
  origin: string,
  options: { prelude?: D1PreparedStatement[]; gated?: boolean } = {},
): Promise<IssuedStatements> {
  const accessToken = token();
  const refreshToken = token();
  const issuedAt = unixNow();
  const accessExpires = issuedAt + ACCESS_TTL_SECONDS;
  const refreshExpires = issuedAt + REFRESH_TTL_SECONDS;
  const [accessHash, refreshHash] = await Promise.all([digest(accessToken), digest(refreshToken)]);
  const accessGate = options.gated === true ? ' SELECT ?, ?, ? WHERE changes() = 1' : ' VALUES(?, ?, ?)';
  const refreshGate =
    options.gated === true ? ' SELECT ?, ?, ?, 0 WHERE changes() = 1' : ' VALUES(?, ?, ?, 0)';
  return {
    statements: [
      ...(options.prelude ?? []),
      stmt(db, `INSERT INTO access_tokens(hash, family, expires)${accessGate}`, accessHash, family, accessExpires),
      stmt(
        db,
        `INSERT INTO refresh_tokens(hash, family, expires, used)${refreshGate}`,
        refreshHash,
        family,
        refreshExpires,
      ),
    ],
    session: {
      accessToken,
      accountId: account,
      expiresAt: rfc3339(new Date(accessExpires * 1000)),
    },
    cookie: refreshCookie(refreshToken, REFRESH_TTL_SECONDS, origin),
  };
}

/** Issues an access/refresh token pair for `family`, optionally with extra statements. */
async function issue(
  db: D1Database,
  family: string,
  account: string,
  origin: string,
  prelude: D1PreparedStatement[] = [],
): Promise<IssuedSession> {
  const built = await buildSession(db, family, account, origin, { prelude });
  await batch(db, built.statements);
  return { session: built.session, cookie: built.cookie };
}

/**
 * Resolves the `Authorization: Bearer <token>` header to an active session.
 * Any failure (missing header, wrong scheme, unknown/expired token, revoked
 * family/device or disabled account) is `401 unauthorized`.
 */
export async function authenticate(ctx: RouteContext): Promise<Identity> {
  const authorization = ctx.request.headers.get('authorization') ?? '';
  const candidate = authorization.startsWith(BEARER_PREFIX)
    ? authorization.slice(BEARER_PREFIX.length)
    : authorization;
  // Go: `if token == "" || token == header { unauthorized }`.
  if (candidate === '' || candidate === authorization) throw fail(401, 'unauthorized');

  const tokenHash = await digest(candidate);
  const row = await one<AuthRow>(ctx.env.DB, AUTH_LOOKUP_SQL, tokenHash, unixNow());
  if (row === null) throw fail(401, 'unauthorized');
  return {
    account: row.account,
    device: row.device,
    family: row.family,
    role: row.role,
    signKey: row.sign_key,
    tokenHash,
  };
}

/**
 * Re-checks that the session behind `identity` is still active: the same
 * predicates as `authenticate` (token not expired, family/device not revoked,
 * account not disabled). Sync calls this once per operation, like the Go
 * server's `auth()` inside every write transaction, so a device revoked in the
 * middle of a batch stops the remaining operations.
 */
export async function ensureSessionActive(
  db: D1Database,
  identity: Identity,
): Promise<void> {
  const row = await one<AuthRow>(db, AUTH_LOOKUP_SQL, identity.tokenHash, unixNow());
  if (row === null || row.account !== identity.account || row.device !== identity.device) {
    throw fail(401, 'unauthorized');
  }
}

export async function authPublicRoutes(ctx: RouteContext): Promise<Response | null> {
  const { path, method } = ctx;
  if (path === '/status' && method === 'GET') return status(ctx);
  if (path === '/registrations' && method === 'POST') return register(ctx);
  if (path === '/accounts/lookup' && method === 'GET') return lookup(ctx);
  if (path === '/auth/challenges' && method === 'POST') return challenge(ctx);
  if (path === '/auth/sessions' && method === 'POST') return session(ctx);
  if (path === '/auth/refresh' && method === 'POST') return refresh(ctx);
  if (path === '/devices' && method === 'POST') return enroll(ctx);
  return null;
}

export async function authProtectedRoutes(
  ctx: RouteContext,
  identity: Identity,
): Promise<Response | null> {
  const { path, method } = ctx;
  if (path === '/auth/sessions' && method === 'DELETE') return logout(ctx, identity);
  if (path === '/me' && method === 'GET') return me(ctx, identity);
  if (path === '/devices' && method === 'GET') return devices(ctx, identity);
  if (path.startsWith('/devices/') && method === 'DELETE') {
    return revokeDevice(ctx, identity, path.slice('/devices/'.length));
  }
  if (path === '/key-bundle' && method === 'PUT') return updateBundle(ctx, identity);
  return null;
}

/** GET /status — whether the deployment has been bootstrapped yet. */
async function status(ctx: RouteContext): Promise<Response> {
  const row = await one<CountRow>(ctx.env.DB, 'SELECT count(*) AS n FROM accounts');
  return json({ initialized: (row?.n ?? 0) > 0 });
}

/**
 * POST /registrations.
 *
 * The very first registration is gated by `RK_BOOTSTRAP_TOKEN` and creates the
 * single `admin` account; every later one must consume a stored invitation and
 * creates a `user` account. The account insert is the race gate: it only fires
 * while the bootstrap condition holds (or the invitation was claimed), so a
 * concurrent duplicate loses with `403 invalid_invitation`.
 */
async function register(ctx: RouteContext): Promise<Response> {
  const db = ctx.env.DB;
  const body = await readBody(ctx.request, {
    inviteToken: 'string',
    accountId: 'string',
    username: 'string',
    signPublicKey: 'string',
    boxPublicKey: 'string',
    keyBundle: 'raw',
    device: 'raw',
  });

  const username = body.username.trim();
  const device = parseDevice(body.device);
  // Go's len() counts UTF-8 bytes; the protocol limit is 3..64 bytes.
  const usernameBytes = new TextEncoder().encode(username).length;
  if (
    !isUuid(body.accountId) ||
    usernameBytes < 3 ||
    usernameBytes > 64 ||
    decode64(body.signPublicKey, 32) === null ||
    decode64(body.boxPublicKey, 32) === null ||
    device === null
  ) {
    throw fail(400, 'invalid_registration');
  }
  if (!(await validDevice(body.accountId, body.signPublicKey, device))) {
    throw fail(400, 'invalid_registration');
  }

  // The Go server persists the raw request bytes; we canonicalise instead.
  const bundleJson = JSON.stringify(body.keyBundle ?? null) ?? 'null';
  if (bundleValid(bundleJson) === null) throw fail(400, 'invalid_bundle');

  const created = now();
  const count = await one<CountRow>(db, 'SELECT count(*) AS n FROM accounts');

  if ((count?.n ?? 0) === 0) {
    const bootstrapToken = ctx.env.RK_BOOTSTRAP_TOKEN;
    if (
      bootstrapToken === undefined ||
      bootstrapToken === '' ||
      (await digest(body.inviteToken)) !== (await digest(bootstrapToken))
    ) {
      throw fail(403, 'invalid_invitation');
    }
    const results = await registrationBatch(db, [
      stmt(
        db,
        `INSERT INTO accounts (${ACCOUNT_SELECT_COLUMNS})
         SELECT ?, ?, ?, ?, ?, 'admin', ?
         WHERE NOT EXISTS (SELECT 1 FROM accounts)`,
        body.accountId,
        username,
        body.signPublicKey,
        body.boxPublicKey,
        bundleJson,
        created,
      ),
      stmt(
        db,
        `INSERT INTO devices (account, id, name, pub, proof, created)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE changes() = 1`,
        body.accountId,
        device.id,
        device.name,
        device.publicKey,
        device.proof,
        created,
      ),
      stmt(
        db,
        `INSERT INTO audit (actor, action, target, created)
         SELECT ?, 'account.register', ?, ?
         WHERE changes() = 1`,
        body.accountId,
        body.accountId,
        created,
      ),
    ]);
    if (changed(results[0]) !== 1) throw fail(403, 'invalid_invitation');
    return json({ accountId: body.accountId }, 201);
  }

  const inviteHash = await digest(body.inviteToken);
  // Go claims the invitation before touching accounts/devices; a D1 batch
  // cannot branch on a statement result, so reject stale invitations up front.
  // This keeps replay behaviour identical to Go (403 invalid_invitation
  // instead of a UNIQUE violation surfacing as 409 account_exists).
  const invitation = await one<InvitationRow>(
    db,
    'SELECT used, expires FROM invitations WHERE hash = ?',
    inviteHash,
  );
  if (invitation === null || invitation.used !== 0 || invitation.expires <= unixNow()) {
    throw fail(403, 'invalid_invitation');
  }
  let results: D1Result[];
  try {
    results = await batch(db, [
    stmt(
      db,
      'UPDATE invitations SET used = 1, used_by = ? WHERE hash = ? AND used = 0 AND expires > ?',
      body.accountId,
      inviteHash,
      unixNow(),
    ),
    stmt(
      db,
      `INSERT INTO accounts (${ACCOUNT_SELECT_COLUMNS})
       SELECT ?, ?, ?, ?, ?, 'user', ?
       WHERE EXISTS (SELECT 1 FROM invitations WHERE hash = ? AND used_by = ?)`,
      body.accountId,
      username,
      body.signPublicKey,
      body.boxPublicKey,
      bundleJson,
      created,
      inviteHash,
      body.accountId,
    ),
    stmt(
      db,
      `INSERT INTO devices (account, id, name, pub, proof, created)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE changes() = 1`,
      body.accountId,
      device.id,
      device.name,
      device.publicKey,
      device.proof,
      created,
    ),
    stmt(
      db,
      `INSERT INTO audit (actor, action, target, created)
       SELECT ?, 'account.register', ?, ?
       WHERE changes() = 1`,
      body.accountId,
      body.accountId,
      created,
    ),
    ]);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Concurrent redemption of the same invitation: the loser's authoritative
    // outcome is decided by the winner's claimed token. Go serialised on the
    // invitation row and answered 403; if the winner used a different accountId
    // the collision is an account/username takeover attempt (409).
    const replay = await one<{ used_by: string | null }>(
      db,
      'SELECT used_by FROM invitations WHERE hash = ?',
      inviteHash,
    );
    if (replay?.used_by === body.accountId) throw fail(403, 'invalid_invitation');
    throw fail(409, 'account_exists');
  }
  if (changed(results[0]) !== 1 || changed(results[1]) !== 1) {
    throw fail(403, 'invalid_invitation');
  }
  return json({ accountId: body.accountId }, 201);
}

/** GET /accounts/lookup?username= — public key material discovery for login. */
async function lookup(ctx: RouteContext): Promise<Response> {
  const username = (ctx.url.searchParams.get('username') ?? '').trim();
  const row = await one<LookupRow>(
    ctx.env.DB,
    'SELECT id, username, sign_key, box_key, bundle FROM accounts WHERE username = ? AND disabled = 0',
    username,
  );
  if (row === null) throw fail(404, 'account_not_found');
  return json({
    accountId: row.id,
    username: row.username,
    signPublicKey: row.sign_key,
    boxPublicKey: row.box_key,
    keyBundle: JSON.parse(row.bundle) as unknown,
  });
}

/** POST /auth/challenges — server-issued challenge for a device login. */
async function challenge(ctx: RouteContext): Promise<Response> {
  const db = ctx.env.DB;
  const body = await readBody(ctx.request, { accountId: 'string', deviceId: 'string' });
  const owner = await one<CountRow>(
    db,
    `SELECT count(*) AS n
     FROM devices d
     JOIN accounts a ON a.id = d.account
     WHERE d.account = ? AND d.id = ? AND d.revoked IS NULL AND a.disabled = 0`,
    body.accountId,
    body.deviceId,
  );
  if ((owner?.n ?? 0) !== 1) throw fail(403, 'device_unavailable');

  const id = token();
  const expires = unixNow() + CHALLENGE_TTL_SECONDS;
  const message = `rememberKey:challenge:1:${ctx.env.RK_ORIGIN}:${body.accountId}:${body.deviceId}:${token()}`;
  await run(
    db,
    'INSERT INTO challenges (id, account, device, message, expires, used) VALUES(?, ?, ?, ?, ?, 0)',
    id,
    body.accountId,
    body.deviceId,
    message,
    expires,
  );
  return json({ id, message, expiresAt: rfc3339(new Date(expires * 1000)) });
}

/** POST /auth/sessions — verifies the signed challenge and opens a token family. */
async function session(ctx: RouteContext): Promise<Response> {
  const db = ctx.env.DB;
  const body = await readBody(ctx.request, { challengeId: 'string', signature: 'string' });
  const challengeRow = await one<ChallengeRow>(
    db,
    'SELECT account, device, message, expires, used FROM challenges WHERE id = ?',
    body.challengeId,
  );
  if (challengeRow === null) throw fail(401, 'invalid_challenge');

  // Burn first, exactly like Go: a challenge is single-use even if a later
  // signature check fails, and only the winner of the CAS may consume it.
  const burned = await run(db, 'UPDATE challenges SET used = 1 WHERE id = ? AND used = 0', body.challengeId);
  if (changed(burned) !== 1) throw fail(401, 'invalid_challenge');
  if (challengeRow.used !== 0 || challengeRow.expires <= unixNow()) {
    throw fail(401, 'invalid_challenge');
  }

  const owner = await one<PubRow>(
    db,
    `SELECT d.pub AS pub
     FROM devices d
     JOIN accounts a ON a.id = d.account
     WHERE d.account = ? AND d.id = ? AND d.revoked IS NULL AND a.disabled = 0`,
    challengeRow.account,
    challengeRow.device,
  );
  if (owner === null || !(await verify(owner.pub, challengeRow.message, body.signature))) {
    throw fail(401, 'invalid_signature');
  }

  const family = token();
  const issued = await issue(db, family, challengeRow.account, ctx.env.RK_ORIGIN, [
    stmt(
      db,
      'INSERT INTO families(id, account, device, revoked) VALUES(?, ?, ?, 0)',
      family,
      challengeRow.account,
      challengeRow.device,
    ),
  ]);
  return json(issued.session, 200, { 'Set-Cookie': issued.cookie });
}

/**
 * POST /auth/refresh — rotates the refresh token inside the current family.
 * Reuse of an already-rotated token revokes the whole family (theft response).
 */
async function refresh(ctx: RouteContext): Promise<Response> {
  const db = ctx.env.DB;
  const origin = ctx.env.RK_ORIGIN;
  const presented = cookieValue(ctx.request, REFRESH_COOKIE);
  if (presented === null) throw fail(401, 'unauthorized');

  const hash = await digest(presented);
  const row = await one<RefreshRow>(
    db,
    `SELECT t.family AS family, f.account AS account, t.used AS used, t.expires AS expires, f.revoked AS revoked
     FROM refresh_tokens t
     JOIN families f ON f.id = t.family
     WHERE t.hash = ?`,
    hash,
  );
  if (row === null) throw fail(401, 'unauthorized');

  if (row.used !== 0) {
    await run(db, 'UPDATE families SET revoked = 1 WHERE id = ?', row.family);
    return errorResponse(fail(401, 'refresh_reuse'), {
      'Set-Cookie': clearRefreshCookie(origin),
    });
  }

  const active = await one<CountRow>(
    db,
    `SELECT count(*) AS n
     FROM families f
     JOIN accounts a ON a.id = f.account
     JOIN devices d ON d.account = f.account AND d.id = f.device
     WHERE f.id = ? AND a.disabled = 0 AND d.revoked IS NULL`,
    row.family,
  );
  if ((active?.n ?? 0) !== 1 || row.revoked !== 0 || row.expires <= unixNow()) {
    throw fail(401, 'unauthorized');
  }

  // Rotation and re-issuance are one atomic batch: the compare-and-set on the
  // presented token gates both inserts (`WHERE changes() = 1`), so a losing
  // racer never mints replacement tokens. Commit order follows Go's single
  // transaction: rotate, then issue.
  const built = await buildSession(db, row.family, row.account, origin, {
    prelude: [stmt(db, 'UPDATE refresh_tokens SET used = 1 WHERE hash = ? AND used = 0', hash)],
    gated: true,
  });
  const rotated = await batch(db, built.statements);
  if (changed(rotated[0]) !== 1) {
    await run(db, 'UPDATE families SET revoked = 1 WHERE id = ?', row.family);
    return errorResponse(fail(401, 'refresh_reuse'), {
      'Set-Cookie': clearRefreshCookie(origin),
    });
  }
  return json(built.session, 200, { 'Set-Cookie': built.cookie });
}

/** DELETE /auth/sessions — logout: revoke the current token family, clear the cookie. */
async function logout(ctx: RouteContext, identity: Identity): Promise<Response> {
  await run(ctx.env.DB, 'UPDATE families SET revoked = 1 WHERE id = ?', identity.family);
  return noContent({ 'Set-Cookie': clearRefreshCookie(ctx.env.RK_ORIGIN) });
}

/**
 * POST /devices — enrolls (or re-proves) a device for an existing account.
 * Replaying the exact same enrollment is idempotent; any mismatch is a conflict.
 */
async function enroll(ctx: RouteContext): Promise<Response> {
  const db = ctx.env.DB;
  const body = await readBody(ctx.request, {
    accountId: 'string',
    id: 'string',
    name: 'string',
    publicKey: 'string',
    proof: 'string',
  });
  const account = await one<SignKeyRow>(
    db,
    'SELECT sign_key FROM accounts WHERE id = ? AND disabled = 0',
    body.accountId,
  );
  if (account === null) throw fail(403, 'forbidden');

  const device = { id: body.id, name: body.name, publicKey: body.publicKey, proof: body.proof };
  if (!(await validDevice(body.accountId, account.sign_key, device))) {
    throw fail(400, 'invalid_device_proof');
  }

  const existing = await one<DeviceRow>(
    db,
    'SELECT pub, proof, revoked FROM devices WHERE account = ? AND id = ?',
    body.accountId,
    body.id,
  );
  if (existing !== null) {
    if (existing.revoked !== null || existing.pub !== body.publicKey || existing.proof !== body.proof) {
      throw fail(409, 'device_conflict');
    }
    // Go's route forces 201 for POST /devices, including this idempotent replay.
    return json({ id: body.id }, 201);
  }

  const created = now();
  await batch(db, [
    stmt(
      db,
      'INSERT INTO devices(account, id, name, pub, proof, created) VALUES(?, ?, ?, ?, ?, ?)',
      body.accountId,
      device.id,
      device.name,
      device.publicKey,
      device.proof,
      created,
    ),
    stmt(
      db,
      'INSERT INTO audit(actor, action, target, created) VALUES(?, ?, ?, ?)',
      body.accountId,
      'device.enroll',
      device.id,
      created,
    ),
  ]);
  return json({ id: body.id }, 201);
}

/** GET /devices — devices of the authenticated account. */
async function devices(ctx: RouteContext, identity: Identity): Promise<Response> {
  const rows = await all<DeviceListRow>(
    ctx.env.DB,
    'SELECT id, name, created, revoked FROM devices WHERE account = ? ORDER BY created, id',
    identity.account,
  );
  return json(
    rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created,
      revokedAt: row.revoked,
    })),
  );
}

/** DELETE /devices/:id — revoke one device plus every session family it owns. */
async function revokeDevice(
  ctx: RouteContext,
  identity: Identity,
  deviceId: string,
): Promise<Response> {
  const db = ctx.env.DB;
  // `AND revoked IS NULL` matches MySQL's changed-row semantics for an already
  // revoked device (Go reports 0 affected rows in that case too).
  const revoked = await run(
    db,
    'UPDATE devices SET revoked = COALESCE(revoked, ?) WHERE account = ? AND id = ? AND revoked IS NULL',
    now(),
    identity.account,
    deviceId,
  );
  if (changed(revoked) === 0) throw fail(404, 'device_not_found');

  await batch(db, [
    stmt(
      db,
      'UPDATE families SET revoked = 1 WHERE account = ? AND device = ?',
      identity.account,
      deviceId,
    ),
    stmt(
      db,
      'INSERT INTO audit(actor, action, target, created) VALUES(?, ?, ?, ?)',
      identity.account,
      'device.revoke',
      deviceId,
      now(),
    ),
  ]);
  return noContent();
}

/** GET /me — profile and current key bundle of the authenticated account. */
async function me(ctx: RouteContext, identity: Identity): Promise<Response> {
  const row = await one<MeRow>(
    ctx.env.DB,
    'SELECT username, sign_key, box_key, bundle, role, bundle_version FROM accounts WHERE id = ?',
    identity.account,
  );
  if (row === null) throw new Error('authenticated account is missing');
  return json({
    accountId: identity.account,
    username: row.username,
    signPublicKey: row.sign_key,
    boxPublicKey: row.box_key,
    keyBundle: JSON.parse(row.bundle) as unknown,
    role: row.role,
    bundleVersion: row.bundle_version,
  });
}

/** PUT /key-bundle — signed, versioned key-bundle rotation (compare-and-swap). */
async function updateBundle(ctx: RouteContext, identity: Identity): Promise<Response> {
  const db = ctx.env.DB;
  const body = await readBody(ctx.request, {
    bundleJson: 'string',
    expectedVersion: 'number',
    signature: 'string',
  });

  const parsed = bundleValid(body.bundleJson);
  if (parsed === null) throw fail(400, 'invalid_bundle');

  const message = await bundleMessage(identity.account, body.expectedVersion, body.bundleJson);
  if (!(await verify(identity.signKey, message, body.signature))) {
    throw fail(403, 'invalid_signature');
  }

  const row = await one<BundleRow>(
    db,
    'SELECT bundle, bundle_version FROM accounts WHERE id = ?',
    identity.account,
  );
  if (row === null) throw new Error('authenticated account is missing');
  const previous = bundleValid(row.bundle);
  if (previous === null) throw new Error('stored key bundle is not a valid v1 bundle');

  // The wrapped private key may never change across bundle rotations.
  if (
    parsed.privateWrap.nonce !== previous.privateWrap.nonce ||
    parsed.privateWrap.ciphertext !== previous.privateWrap.ciphertext
  ) {
    throw fail(400, 'private_wrap_immutable');
  }
  if (row.bundle_version !== body.expectedVersion) throw fail(409, 'bundle_conflict');

  const updated = await run(
    db,
    'UPDATE accounts SET bundle = ?, bundle_version = bundle_version + 1 WHERE id = ? AND bundle_version = ?',
    body.bundleJson,
    identity.account,
    body.expectedVersion,
  );
  if (changed(updated) !== 1) throw fail(409, 'bundle_conflict');
  return json({ version: body.expectedVersion + 1 });
}
