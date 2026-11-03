// End-to-end integration check against a real rememberKey Worker.
// Exercises: bootstrap registration, Ed25519 challenge auth, encrypted record
// sync, idempotent replay, revision conflict, cross-account isolation and
// device revocation. Run with: node scripts/e2e.mjs
// Requires a fresh local D1 (`worker/npm run dev` after `npm run db:migrate:local`).
const BASE = process.env.RK_BASE || 'http://127.0.0.1:8787';
const BOOTSTRAP = process.env.RK_BOOTSTRAP_TOKEN || 'dev-bootstrap-token-for-integration';

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} ${extra}`); }
};
const group = (t) => console.log(`\n== ${t}`);

async function call(path, { method = 'GET', body, token, origin = BASE, raw = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (method !== 'GET') headers.Origin = origin;
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  if (raw) return { status: res.status, json, text, headers: res.headers };
  return json?.data ?? json?.error ?? json;
}

// Minimal Ed25519 via node:crypto for account/device identity keys.
import { generateKeyPairSync, sign as edSign, createHash } from 'node:crypto';
const b64u = (b) => Buffer.from(b).toString('base64url');
function edPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return { publicKey: b64u(rawPub), privateKey, rawPub };
}
const signDetached = (priv, msg) => b64u(edSign(null, Buffer.from(msg, 'utf8'), priv));
const uuid = () => crypto.randomUUID();
const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// A stand-in key bundle: the server validates structure only, not decryptability.
function keyBundle(accountId, saltByte = 7) {
  const wrap = (n) => ({ nonce: b64u(Buffer.alloc(24, n)), ciphertext: b64u(Buffer.alloc(48, n)) });
  return {
    version: 1,
    salt: b64u(Buffer.alloc(16, saltByte)),
    passwordWrap: wrap(1), recoveryWrap: wrap(2), privateWrap: wrap(3),
  };
}

// A structurally valid envelope: 24-byte nonce, >=16-byte ciphertext, 80-byte
// sealed wrapped key. The server validates shape and size, never plaintext.
function envelope(tag) {
  const buf = Buffer.from(String(tag).padEnd(32, '.'), 'utf8');
  return JSON.stringify({
    version: 1,
    nonce: b64u(Buffer.alloc(24, 3)),
    ciphertext: b64u(buf),
    wrappedKey: b64u(Buffer.alloc(80, 4)),
  });
}

async function registerUser(name, token) {
  const accountId = uuid(), ed = edPair(), deviceId = uuid();
  const deviceEd = edPair();
  const proof = signDetached(ed.privateKey, `rememberKey:device:1:${accountId}:${deviceId}:${deviceEd.publicKey}`);
  const res = await call('/registrations', {
    method: 'POST',
    body: {
      inviteToken: token, accountId, username: name,
      signPublicKey: ed.publicKey, boxPublicKey: b64u(Buffer.alloc(32, 9)),
      keyBundle: keyBundle(accountId),
      device: { id: deviceId, name: 'integration', publicKey: deviceEd.publicKey, proof },
    },
  });
  return { accountId, ed, deviceId, deviceEd, res };
}

async function login(user, origin = BASE) {
  const ch = await call('/auth/challenges', { method: 'POST', body: { accountId: user.accountId, deviceId: user.deviceId }, origin });
  if (!ch?.id) throw new Error(`challenge failed: ${JSON.stringify(ch)}`);
  const signature = signDetached(user.deviceEd.privateKey, ch.message);
  const sess = await call('/auth/sessions', { method: 'POST', body: { challengeId: ch.id, signature }, origin, raw: true });
  const token = sess.json?.data?.accessToken;
  return { token, challenge: ch, session: sess };
}

const opMessage = (accountId, op) =>
  `rememberKey:op:1:${accountId}:${op.operationId}:${op.id}:${op.baseRevision}:${op.deleted ? '1' : '0'}:${sha256hex(op.envelope ?? '')}`;

function makeOp(user, { id = uuid(), baseRevision = 0, deleted = false, envelope: env = envelope('v1') } = {}) {
  const op = { operationId: uuid(), id, baseRevision, deleted, envelope: deleted ? null : env };
  op.signature = signDetached(user.ed.privateKey, opMessage(user.accountId, op));
  return op;
}

// ---------------------------------------------------------------- main
const bootstrap = await call('/status');
group('bootstrap');
ok('fresh server reports initialized=false', bootstrap?.initialized === false, JSON.stringify(bootstrap));

const statusHeaders = await call('/status', { raw: true });
ok('API responses are not cacheable', statusHeaders.headers.get('cache-control') === 'no-store', `cache-control=${statusHeaders.headers.get('cache-control')}`);
ok('API responses carry security headers', statusHeaders.headers.get('x-content-type-options') === 'nosniff'
  && statusHeaders.headers.get('referrer-policy') === 'no-referrer', JSON.stringify([statusHeaders.headers.get('x-content-type-options'), statusHeaders.headers.get('referrer-policy')]));

const admin = await registerUser('admin_user', BOOTSTRAP);
ok('bootstrap admin registration succeeds', admin.res?.accountId === admin.accountId, JSON.stringify(admin.res));

const replayed = await call('/registrations', {
  method: 'POST',
  body: { inviteToken: BOOTSTRAP, accountId: uuid(), username: 'second_admin', signPublicKey: admin.ed.publicKey, boxPublicKey: b64u(Buffer.alloc(32, 9)), keyBundle: keyBundle(uuid()), device: { id: uuid(), name: 'x', publicKey: admin.ed.publicKey, proof: 'x' } },
});
ok('bootstrap token cannot be reused once an account exists', !replayed?.accountId, JSON.stringify(replayed));

const after = await call('/status');
ok('server now reports initialized=true', after?.initialized === true, JSON.stringify(after));

// ------------------------------------------------------------------ auth
group('public-key authentication');
const a = await login(admin);
ok('challenge login returns an access token', typeof a.token === 'string' && a.token.length > 20);
ok('challenge message embeds the configured origin', a.challenge.message.includes(BASE), a.challenge.message);

const reused = await call('/auth/sessions', { method: 'POST', body: { challengeId: a.challenge.id, signature: signDetached(admin.deviceEd.privateKey, a.challenge.message) }, raw: true });
ok('challenge is single-use (replay rejected)', reused.status === 401, `status=${reused.status}`);

const badSigCh = await call('/auth/challenges', { method: 'POST', body: { accountId: admin.accountId, deviceId: admin.deviceId } });
const badSig = await call('/auth/sessions', { method: 'POST', body: { challengeId: badSigCh.id, signature: b64u(Buffer.alloc(64, 5)) }, raw: true });
ok('a wrong device signature is rejected', badSig.status === 401, `status=${badSig.status}`);

const noToken = await call('/me');
ok('/me without a bearer token is unauthorized', noToken?.code === 'unauthorized', JSON.stringify(noToken));

const meRes = await call('/me', { token: a.token });
ok('/me returns the authenticated account', meRes?.accountId === admin.accountId && meRes?.role === 'admin', JSON.stringify(meRes));

// ------------------------------------------------------------------ origin
group('origin enforcement');
const badOrigin = await call('/sync/operations', { method: 'POST', body: { operations: [] }, token: a.token, origin: 'https://evil.example', raw: true });
ok('a write from a foreign Origin is rejected', badOrigin.status === 403, `status=${badOrigin.status}`);

// Static paths bypass Functions; Pages rejects non-GET/HEAD requests with 405.
const staticWriteRes = await fetch(`${BASE}/index.html`, { method: 'POST', headers: { Origin: 'https://evil.example' } });
const staticWrite = { status: staticWriteRes.status, json: await staticWriteRes.json().catch(() => undefined) };
ok('Pages rejects a foreign-Origin write to a static path with 405', staticWrite.status === 405, `status=${staticWrite.status}`);

// ------------------------------------------------------------------ sync
group('encrypted sync');
const rec1 = makeOp(admin);
const push1 = await call('/sync/operations', { method: 'POST', body: { operations: [rec1] }, token: a.token });
ok('first create applies', push1?.results?.[0]?.status === 'applied', JSON.stringify(push1));
ok('server assigns revision 1', push1?.results?.[0]?.record?.revision === 1, JSON.stringify(push1?.results?.[0]));

const push1again = await call('/sync/operations', { method: 'POST', body: { operations: [rec1] }, token: a.token });
ok('replaying the same operationId is idempotent, not a double write',
  push1again?.results?.[0]?.status === 'applied' && push1again?.results?.[0]?.record?.revision === 1,
  JSON.stringify(push1again));

const tampered = { ...rec1, envelope: envelope('attacker') };
const tamperRes = await call('/sync/operations', { method: 'POST', body: { operations: [tampered] }, token: a.token, raw: true });
ok('reusing an operationId with a changed body is rejected', tamperRes.status === 409 || tamperRes.json?.error?.code, `status=${tamperRes.status}`);

const stale = makeOp(admin, { id: rec1.id, baseRevision: 0, envelope: envelope('stale-write') });
const staleRes = await call('/sync/operations', { method: 'POST', body: { operations: [stale] }, token: a.token });
ok('a stale baseRevision produces a conflict, not a silent overwrite',
  staleRes?.results?.[0]?.status === 'conflict' && staleRes?.results?.[0]?.record?.revision === 1,
  JSON.stringify(staleRes));

const foreign = makeOp({ ...admin, accountId: uuid() }, { id: rec1.id, baseRevision: 1 });
const foreignRes = await call('/sync/operations', { method: 'POST', body: { operations: [foreign] }, token: a.token, raw: true });
ok('an operation signed for another account is rejected', foreignRes.status !== 200, `status=${foreignRes.status}`);

const changes = await call('/sync/changes?cursor=0&limit=100', { token: a.token });
ok('changes are returned with a cursor', Array.isArray(changes?.changes) && typeof changes?.cursor === 'number', JSON.stringify(changes));
ok('exactly one change was recorded for one applied write', changes.changes.length === 1, `count=${changes.changes.length}`);
ok('logged change carries the opaque ciphertext envelope, not attacker input',
  typeof changes.changes[0]?.envelope === 'string' && changes.changes[0].envelope.includes('c3RhbGU') === false, changes.changes[0]?.envelope);

const strictCursor = await call('/sync/changes?cursor=0x10', { token: a.token, raw: true });
ok('non-decimal cursor spelling is rejected', strictCursor.status === 400 && strictCursor.json?.error?.code === 'invalid_cursor', `status=${strictCursor.status} body=${strictCursor.text}`);

const snap = await call('/sync/snapshot', { token: a.token });
ok('snapshot returns the record set', Array.isArray(snap?.records) && snap.records.length === 1, JSON.stringify(snap));

// ------------------------------------------------------- account isolation
group('multi-user isolation');
const invite = await call('/admin/invitations', { method: 'POST', token: a.token });
ok('admin can mint a single-use invitation', typeof invite?.token === 'string', JSON.stringify(invite));

const bob = await registerUser('bob_user', invite.token);
ok('invited user registers successfully', bob.res?.accountId === bob.accountId, JSON.stringify(bob.res));

const inviteAgain = await registerUser('carol_user', invite.token);
ok('invitation cannot be reused', !inviteAgain.res?.accountId, JSON.stringify(inviteAgain.res));

const b = await login(bob);
ok('second user can authenticate independently', typeof b.token === 'string');

// MySQL treated usernames case-insensitively; D1 mirrors that with NOCASE.
const inviteCase = await call('/admin/invitations', { method: 'POST', token: a.token });
const dupCase = await registerUser('BOB_USER', inviteCase.token);
ok('usernames are unique case-insensitively', dupCase.res?.code === 'account_exists', JSON.stringify(dupCase.res));
const lookupCase = await call('/accounts/lookup?username=BOB_USER');
ok('account lookup is case-insensitive', lookupCase?.accountId === bob.accountId, JSON.stringify(lookupCase));

const bobChanges = await call('/sync/changes?cursor=0&limit=100', { token: b.token });
ok('new account sees an empty change stream (no cross-account leakage)', bobChanges?.changes?.length === 0, JSON.stringify(bobChanges));

const bobSnap = await call('/sync/snapshot', { token: b.token });
ok('new account snapshot is empty', bobSnap?.records?.length === 0, JSON.stringify(bobSnap));

// bob has no record with this id, so a baseRevision of 1 must conflict rather
// than silently borrow admin's revision; the isolation check is that admin's
// own record is untouched afterwards.
const bobSteal = makeOp(bob, { id: rec1.id, baseRevision: 1, envelope: envelope('stolen') });
const stealRes = await call('/sync/operations', { method: 'POST', body: { operations: [bobSteal] }, token: b.token });
ok('a user cannot claim a revision that exists only in another account',
  stealRes?.results?.[0]?.status === 'conflict' && stealRes?.results?.[0]?.record === null,
  JSON.stringify(stealRes));

const bobOwn = makeOp(bob, { id: rec1.id, baseRevision: 0, envelope: envelope('bob-own') });
const bobOwnRes = await call('/sync/operations', { method: 'POST', body: { operations: [bobOwn] }, token: b.token });
ok('the same record id in a different account is an independent record',
  bobOwnRes?.results?.[0]?.status === 'applied' && bobOwnRes?.results?.[0]?.record?.revision === 1,
  JSON.stringify(bobOwnRes));

const adminSnapAfter = await call('/sync/snapshot', { token: a.token });
ok("cross-account write did not alter the first user's record",
  adminSnapAfter?.records?.[0]?.envelope === rec1.envelope, JSON.stringify(adminSnapAfter?.records?.[0]));

const nonAdmin = await call('/admin/users', { token: b.token, raw: true });
ok('a non-admin cannot read the admin API', nonAdmin.status === 403, `status=${nonAdmin.status}`);

// ------------------------------------------------------ admin management
group('admin account management');
const users = await call('/admin/users', { token: a.token });
ok('admin can list accounts', Array.isArray(users) && users.length === 2
  && users.every((u) => typeof u.accountId === 'string' && typeof u.role === 'string'), JSON.stringify(users));

const disableBob = await call(`/admin/users/${bob.accountId}`, { method: 'PATCH', body: { disabled: true }, token: a.token });
ok('admin can disable an account', disableBob?.disabled === true, JSON.stringify(disableBob));

const disabledMe = await call('/me', { token: b.token, raw: true });
ok('disabling an account immediately revokes its access tokens', disabledMe.status === 401, `status=${disabledMe.status}`);

const disabledChallenge = await call('/auth/challenges', { method: 'POST', body: { accountId: bob.accountId, deviceId: bob.deviceId } });
ok('a disabled account cannot start a new login', disabledChallenge?.code === 'device_unavailable', JSON.stringify(disabledChallenge));

const enableBob = await call(`/admin/users/${bob.accountId}`, { method: 'PATCH', body: { disabled: false }, token: a.token });
ok('admin can re-enable an account', enableBob?.disabled === false, JSON.stringify(enableBob));

const b2 = await login(bob);
const b2me = await call('/me', { token: b2.token });
ok('a re-enabled account can log in again as a normal user', b2me?.accountId === bob.accountId && b2me?.role === 'user', JSON.stringify(b2me));

const disableSelf = await call(`/admin/users/${admin.accountId}`, { method: 'PATCH', body: { disabled: true }, token: a.token, raw: true });
ok('an admin cannot disable their own account', disableSelf.status === 409 && disableSelf.json?.error?.code === 'cannot_disable_self', `status=${disableSelf.status}`);

const missingDisabled = await call(`/admin/users/${bob.accountId}`, { method: 'PATCH', body: {}, token: a.token, raw: true });
ok('PATCH requires the disabled field', missingDisabled.status === 400 && missingDisabled.json?.error?.code === 'disabled_required', `status=${missingDisabled.status}`);

const unknownUser = await call(`/admin/users/${uuid()}`, { method: 'PATCH', body: { disabled: true }, token: a.token, raw: true });
ok('disabling an unknown account is a 404', unknownUser.status === 404 && unknownUser.json?.error?.code === 'account_not_found', `status=${unknownUser.status}`);

const audit = await call('/admin/audit?cursor=0&limit=100', { token: a.token });
ok('admin audit log records the disable and enable actions', Array.isArray(audit?.events)
  && audit.events.some((e) => e.action === 'account.disabled.change' && e.targetId === bob.accountId), JSON.stringify(audit));

// ------------------------------------------- invitation race hardening
// Two registrations race on one invitation while one of them names an existing
// account (the admin). The loser's batch must not enroll its device there: that
// would hand an invite holder a session (and admin role) for someone else.
group('invitation race hardening');
const devicesBeforeRace = await call('/devices', { token: a.token });
let raceEnrolled = 0;
for (let i = 0; i < 8; i++) {
  const raceInvite = await call('/admin/invitations', { method: 'POST', token: a.token });
  if (typeof raceInvite?.token !== 'string') { raceEnrolled++; continue; }
  const evil = edPair();
  const evilDeviceId = uuid();
  const evilProof = signDetached(evil.privateKey, `rememberKey:device:1:${admin.accountId}:${evilDeviceId}:${evil.publicKey}`);
  const honest = registerUser(`race_a_${i}_${uuid().slice(0, 8)}`, raceInvite.token);
  const evilRes = call('/registrations', {
    method: 'POST',
    body: {
      inviteToken: raceInvite.token,
      accountId: admin.accountId,
      username: `race_b_${i}_${uuid().slice(0, 8)}`,
      signPublicKey: evil.publicKey,
      boxPublicKey: b64u(Buffer.alloc(32, 9)),
      keyBundle: keyBundle(admin.accountId),
      device: { id: evilDeviceId, name: 'attacker', publicKey: evil.publicKey, proof: evilProof },
    },
    raw: true,
  });
  const outcome = await Promise.all([honest, evilRes]);
  if (outcome[1].status === 201 || outcome[1].status === 204) raceEnrolled++;
}
const devicesAfterRace = await call('/devices', { token: a.token });
ok('a racing invitation cannot enroll a device into another account',
  raceEnrolled === 0 && Array.isArray(devicesAfterRace) && devicesAfterRace.length === devicesBeforeRace.length,
  `enrolled=${raceEnrolled} before=${devicesBeforeRace?.length} after=${devicesAfterRace?.length}`);

// ------------------------------------------------------------ revocation
group('device revocation');
const devices = await call('/devices', { token: a.token });
ok('device list includes the registered device', Array.isArray(devices) && devices.length === 1, JSON.stringify(devices));

const selfRevoke = await call(`/devices/${admin.deviceId}`, { method: 'DELETE', token: a.token, raw: true });
ok('revoking a device succeeds', selfRevoke.status === 204, `status=${selfRevoke.status}`);

const afterRevoke = await call('/me', { token: a.token, raw: true });
ok('the revoked device access token stops working', afterRevoke.status === 401, `status=${afterRevoke.status}`);

const reregister = await call('/devices', {
  method: 'POST',
  body: {
    accountId: admin.accountId, id: admin.deviceId, name: 'integration', publicKey: admin.deviceEd.publicKey,
    proof: signDetached(admin.ed.privateKey, `rememberKey:device:1:${admin.accountId}:${admin.deviceId}:${admin.deviceEd.publicKey}`),
  },
});
ok('a revoked device id cannot be re-enrolled', !reregister?.id || reregister?.code, JSON.stringify(reregister));

// --------------------------------------------------------------- summary
console.log(`\n${'='.repeat(52)}`);
console.log(`E2E RESULT: ${passed} passed, ${failed} failed`);
console.log('='.repeat(52));
process.exitCode = failed === 0 ? 0 : 1;
