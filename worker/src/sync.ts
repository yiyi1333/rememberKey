/**
 * Encrypted record sync routes: POST /sync/operations, GET /sync/changes and
 * GET /sync/snapshot. Port of the former Go server's sync.go to Cloudflare D1.
 *
 * Go used one MySQL transaction per operation with SELECT ... FOR UPDATE for
 * the revision compare-and-set. D1 has no interactive transactions, so every
 * operation is applied by a single atomic db.batch():
 *
 *   0. upsert the record only while its current revision still equals the
 *      operation's baseRevision (compare-and-set via `WHERE records.revision`),
 *   1. append the change-log row only when statement 0 wrote a row
 *      (`changes() = 1`), and
 *   2. persist the idempotency result only when statement 0 wrote a row
 *      (`changes()` still refers to statement 1, which inserted one row
 *      exactly when statement 0 did). `ON CONFLICT DO NOTHING` lets a
 *      concurrent writer's result row win instead of aborting the batch, in
 *      which case the stored row is re-read and returned.
 *
 * A batch that changes nothing means the operation lost a race: the current
 * record and/or the winner's stored result is returned as a conflict. The
 * envelope is always stored as the exact JSON text the client signed; it is
 * never re-serialized.
 */

import { all, batch, changed, one, run, stmt, unixNow } from './db';
import { ensureSessionActive } from './auth';
import { digest, isUuid, opMessage, parseEnvelope, verify } from './crypto';
import type { OperationLike } from './crypto';
import { arrayField, fail, json, pageParams, readBody, strictObject } from './http';
import type { Identity, RecordRow, RouteContext } from './types';

/** One operation as it appears on the wire (request body item). */
export interface WireOperation {
  operationId: string;
  id: string;
  baseRevision: number;
  deleted: boolean;
  envelope?: string;
  signature: string;
}

/** A record exactly as serialized in the protocol (Go's Record struct). */
export interface RecordPayload {
  id: string;
  revision: number;
  deleted: boolean;
  envelope: string | null;
  signature: string;
  operationId: string;
  baseRevision: number;
}

/** One entry of a POST /sync/operations response (Go's Result struct). */
export interface SyncResult {
  operationId: string;
  status: 'applied' | 'conflict';
  record: RecordPayload | null;
}

/** Request item shape: unknown fields are rejected like Go's DisallowUnknownFields. */
const OPERATION_SHAPE = {
  operationId: 'string',
  id: 'string',
  baseRevision: 'number',
  deleted: 'boolean',
  envelope: 'string?',
  signature: 'string',
} as const;

const RECORD_COLUMNS = 'id,revision,deleted,envelope,signature,operation,base';
const SELECT_RECORD = `SELECT ${RECORD_COLUMNS} FROM records WHERE account=? AND id=?`;
const SELECT_ALL_RECORDS = `SELECT ${RECORD_COLUMNS} FROM records WHERE account=? ORDER BY id LIMIT 10001`;
const SELECT_LATEST_SEQ = 'SELECT COALESCE(MAX(seq),0) AS latest FROM changes WHERE account=?';
const SELECT_OPERATION =
  'SELECT hash,result FROM operations WHERE account=? AND id=?';

/**
 * Canonical JSON of an operation, byte-compatible with Go's `json.Marshal` of
 * the Operation struct (fixed field order, envelope null when absent). The
 * idempotency hash is sha256 of this string.
 */
export function canonicalOperation(op: OperationLike): string {
  const json = JSON.stringify({
    operationId: op.operationId,
    id: op.id,
    baseRevision: op.baseRevision,
    deleted: op.deleted,
    envelope: op.envelope,
    signature: op.signature,
  });
  // encoding/json escapes HTML-sensitive bytes and U+2028/U+2029 by default.
  return json.replace(/[<>&\u2028\u2029]/g, (c) =>
    c === '<' ? '\\u003c' : c === '>' ? '\\u003e' : c === '&' ? '\\u0026' : c === '\u2028' ? '\\u2028' : '\\u2029',
  );
}

/** Idempotency key of an operation: sha256 hex of its canonical JSON. */
export function operationHash(op: OperationLike): Promise<string> {
  return digest(canonicalOperation(op));
}

/** Both hashes accepted when reading legacy idempotency rows. */
export async function compatibleOperationHashes(op: OperationLike): Promise<string[]> {
  const go = await operationHash(op);
  const legacy = await digest(JSON.stringify({
    operationId: op.operationId, id: op.id, baseRevision: op.baseRevision,
    deleted: op.deleted, envelope: op.envelope, signature: op.signature,
  }));
  return go === legacy ? [go] : [go, legacy];
}

/** Canonical operation signature message (shared helper, re-exported for tests). */
export function operationMessage(accountId: string, op: OperationLike): Promise<string> {
  return opMessage(accountId, op);
}

/** Normalize a parsed wire operation: an absent envelope is null (Go's nil). */
export function normalizeOperation(wire: WireOperation): OperationLike {
  return {
    operationId: wire.operationId,
    id: wire.id,
    baseRevision: wire.baseRevision,
    deleted: wire.deleted,
    envelope: wire.envelope ?? null,
    signature: wire.signature,
  };
}

/** Serialize a record with Go's field order and boolean/null representation. */
export function recordJson(record: RecordPayload): string {
  return JSON.stringify({
    id: record.id,
    revision: record.revision,
    deleted: record.deleted,
    envelope: record.envelope,
    signature: record.signature,
    operationId: record.operationId,
    baseRevision: record.baseRevision,
  });
}

/** Serialize an operation result with Go's field order. */
export function resultJson(result: SyncResult): string {
  return JSON.stringify({
    operationId: result.operationId,
    status: result.status,
    record:
      result.record === null
        ? null
        : {
            id: result.record.id,
            revision: result.record.revision,
            deleted: result.record.deleted,
            envelope: result.record.envelope,
            signature: result.record.signature,
            operationId: result.record.operationId,
            baseRevision: result.record.baseRevision,
          },
  });
}

/** Parse a result previously persisted in the operations idempotency table. */
export function parseResult(raw: string): SyncResult {
  return JSON.parse(raw) as SyncResult;
}

/** Convert a stored records row into the protocol record representation. */
export function payloadOf(row: RecordRow): RecordPayload {
  return {
    id: row.id,
    revision: row.revision,
    deleted: row.deleted !== 0,
    envelope: row.envelope,
    signature: row.signature,
    operationId: row.operation,
    baseRevision: row.base,
  };
}

/** Route entry point; returns null when the path does not belong to sync. */
export async function syncRoutes(
  ctx: RouteContext,
  identity: Identity,
): Promise<Response | null> {
  if (ctx.path === '/sync/operations' && ctx.method === 'POST') {
    return operations(ctx, identity);
  }
  if (ctx.path === '/sync/changes' && ctx.method === 'GET') {
    return changes(ctx, identity);
  }
  if (ctx.path === '/sync/snapshot' && ctx.method === 'GET') {
    return snapshot(ctx, identity);
  }
  return null;
}

async function operations(ctx: RouteContext, identity: Identity): Promise<Response> {
  const body = await readBody(ctx.request, { operations: 'raw' });
  // An absent (or null) operations field decodes to a nil slice in Go and is
  // therefore an empty batch rather than malformed JSON.
  const rawOperations = body.operations;
  // Go strict-decodes the whole body -- including every operation item --
  // before the batch-length check, so an unknown field anywhere rejects the
  // request before any operation is applied.
  const items = (rawOperations === null ? [] : arrayField(rawOperations)).map((item) =>
    normalizeOperation(strictObject(item, OPERATION_SHAPE)),
  );
  if (items.length === 0 || items.length > 100) throw fail(400, 'invalid_batch');

  const results: SyncResult[] = [];
  for (const op of items) {
    // Each operation commits independently (as in Go): an error aborts the
    // request but leaves earlier, already committed operations in place.
    results.push(await applyOperation(ctx, identity, op));
  }
  return json({ results });
}

async function applyOperation(
  ctx: RouteContext,
  identity: Identity,
  op: OperationLike,
): Promise<SyncResult> {
  const db = ctx.env.DB;

  // Go re-authenticated inside every per-operation transaction; do the same so
  // a device revoked or account disabled mid-batch stops the remaining ops.
  await ensureSessionActive(db, identity);

  // Field validation, then signature verification (Go order: a replay only
  // reaches the idempotency table with a valid signature).
  const parsedEnvelope = parseEnvelope(op.envelope, op.deleted);
  if (
    !isUuid(op.operationId) ||
    !isUuid(op.id) ||
    !Number.isSafeInteger(op.baseRevision) ||
    op.baseRevision < 0 ||
    parsedEnvelope === null
  ) {
    throw fail(400, 'invalid_operation');
  }
  const envelope = parsedEnvelope.envelope;
  if (!(await verify(identity.signKey, await opMessage(identity.account, op), op.signature))) {
    throw fail(403, 'invalid_signature');
  }

  const hashes = await compatibleOperationHashes(op);
  const hash = hashes[0]!;
  const legacyHash = hashes[1] ?? hash;

  // Replay of an already processed operation: identical body -> stored result,
  // different body under the same operationId -> 409.
  const previous = await one<{ hash: string; result: string }>(
    db,
    SELECT_OPERATION,
    identity.account,
    op.operationId,
  );
  if (previous !== null) {
    if (previous.hash !== hash && previous.hash !== legacyHash) throw fail(409, 'operation_id_reused');
    return parseResult(previous.result);
  }

  const current = await one<RecordRow>(db, SELECT_RECORD, identity.account, op.id);
  const revision = current?.revision ?? 0;

  if (revision !== op.baseRevision) {
    // Stale baseRevision: report the current record as a conflict. Conflicts are
    // persisted too, so a retry cannot turn into an unintended overwrite.
    const conflict: SyncResult = {
      operationId: op.operationId,
      status: 'conflict',
      record: current === null ? null : payloadOf(current),
    };
    return persistResult(db, identity.account, op.operationId, hash, legacyHash, conflict);
  }

  return applyWrite(ctx, identity, op, envelope, hash, legacyHash);
}

/** Current revision matches the operation's base: run the atomic compare-and-set. */
async function applyWrite(
  ctx: RouteContext,
  identity: Identity,
  op: OperationLike,
  envelope: string | null,
  hash: string,
  legacyHash: string,
): Promise<SyncResult> {
  const db = ctx.env.DB;
  const nextRevision = op.baseRevision + 1;
  const record: RecordPayload = {
    id: op.id,
    revision: nextRevision,
    deleted: op.deleted,
    envelope,
    signature: op.signature,
    operationId: op.operationId,
    baseRevision: op.baseRevision,
  };
  const applied: SyncResult = {
    operationId: op.operationId,
    status: 'applied',
    record,
  };
  const appliedResult = resultJson(applied);

  // One batch = one atomic transaction:
  //   0. CREATE/UPDATE the record iff its stored revision is still baseRevision
  //      (the create case is the INSERT half of the upsert) AND the caller's
  //      session is still active AND the same operationId is not already
  //      recorded with a different body (a reused id must not leave a write
  //      behind its 409),
  //   1. append the change log iff statement 0 wrote,
  //   2. store the idempotency result iff statement 1 wrote (i.e. statement 0
  //      wrote, since statement 1 then inserts exactly one row). DO NOTHING
  //      keeps a concurrent writer's row instead of aborting the whole batch.
  const batchResult = await batch(db, [
    stmt(
      db,
      `INSERT INTO records(account,id,revision,deleted,envelope,signature,operation,base)
       SELECT ?,?,?,?,?,?,?,?
       WHERE EXISTS (
         SELECT 1 FROM access_tokens t
         JOIN families f ON f.id = t.family
         JOIN accounts a ON a.id = f.account
         JOIN devices d ON d.account = f.account AND d.id = f.device
         WHERE t.hash = ? AND t.expires > ? AND f.revoked = 0 AND a.disabled = 0 AND d.revoked IS NULL
       )
         AND NOT EXISTS (
           SELECT 1 FROM operations o WHERE o.account = ? AND o.id = ? AND o.hash NOT IN (?,?)
         )
       ON CONFLICT(account,id) DO UPDATE SET
         revision=excluded.revision,
         deleted=excluded.deleted,
         envelope=excluded.envelope,
         signature=excluded.signature,
         operation=excluded.operation,
         base=excluded.base
       WHERE records.revision=?`,
      identity.account,
      op.id,
      nextRevision,
      op.deleted ? 1 : 0,
      envelope,
      op.signature,
      op.operationId,
      op.baseRevision,
      identity.tokenHash,
      unixNow(),
      identity.account,
      op.operationId,
      hash,
      legacyHash,
      op.baseRevision,
    ),
    stmt(
      db,
      `INSERT INTO changes(account,record) SELECT ?,? WHERE changes()=1`,
      identity.account,
      recordJson(record),
    ),
    stmt(
      db,
      `INSERT INTO operations(account,id,hash,result) SELECT ?,?,?,? WHERE changes()=1
       ON CONFLICT(account,id) DO NOTHING`,
      identity.account,
      op.operationId,
      hash,
      appliedResult,
    ),
  ]);

  if (changed(batchResult[0]) > 0) {
    // The compare-and-set won. The idempotency row is now either ours or, after
    // a stale read, a concurrent writer's; the stored row is authoritative for
    // the response (a swallowed insert must not hide a differing hash -> 409).
    const winner = await one<{ hash: string; result: string }>(
      db,
      SELECT_OPERATION,
      identity.account,
      op.operationId,
    );
    if (winner === null) return parseResult(appliedResult);
    if (winner.hash !== hash && winner.hash !== legacyHash) throw fail(409, 'operation_id_reused');
    return parseResult(winner.result);
  }

  // Lost the compare-and-set: another operation wrote this record first, or
  // the guarded statement was suppressed because the session went away. Go's
  // per-transaction auth check makes that case a 401 rather than a conflict.
  await ensureSessionActive(db, identity);
  const stored = await one<RecordRow>(db, SELECT_RECORD, identity.account, op.id);
  if (stored !== null && stored.operation === op.operationId) {
    // A concurrent request replaying this exact signed operation won; return
    // its stored result (or persist the applied result if it is not visible).
    const winner = await one<{ hash: string; result: string }>(
      db,
      SELECT_OPERATION,
      identity.account,
      op.operationId,
    );
    if (winner !== null) {
      if (winner.hash !== hash && winner.hash !== legacyHash) throw fail(409, 'operation_id_reused');
      return parseResult(winner.result);
    }
    return persistResult(db, identity.account, op.operationId, hash, legacyHash, {
      operationId: op.operationId,
      status: 'applied',
      record: payloadOf(stored),
    });
  }
  const conflict: SyncResult = {
    operationId: op.operationId,
    status: 'conflict',
    record: stored === null ? null : payloadOf(stored),
  };
  return persistResult(db, identity.account, op.operationId, hash, legacyHash, conflict);
}

/**
 * Persist an operation result at most once (a concurrent request that already
 * stored a result for this operationId keeps its row) and return the stored
 * result. Reusing an operationId with a different signed body is a 409.
 */
async function persistResult(
  db: D1Database,
  account: string,
  operationId: string,
  hash: string,
  legacyHash: string,
  result: SyncResult,
): Promise<SyncResult> {
  await run(
    db,
    `INSERT INTO operations(account,id,hash,result) VALUES(?,?,?,?)
     ON CONFLICT(account,id) DO NOTHING`,
    account,
    operationId,
    hash,
    resultJson(result),
  );
  const stored = await one<{ hash: string; result: string }>(
    db,
    SELECT_OPERATION,
    account,
    operationId,
  );
  if (stored === null) return result;
  if (stored.hash !== hash && stored.hash !== legacyHash) throw fail(409, 'operation_id_reused');
  return parseResult(stored.result);
}

async function changes(ctx: RouteContext, identity: Identity): Promise<Response> {
  const db = ctx.env.DB;
  const { cursor, limit } = pageParams(ctx.url);

  const latest = await one<{ latest: number }>(db, SELECT_LATEST_SEQ, identity.account);
  const upper = latest?.latest ?? 0;
  if (cursor > upper) throw fail(400, 'invalid_cursor');

  // Fetch one extra row to learn whether another page remains.
  const rows = await all<{ seq: number; record: string }>(
    db,
    `SELECT seq,record FROM changes WHERE account=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?`,
    identity.account,
    cursor,
    upper,
    limit + 1,
  );

  const out: unknown[] = [];
  let next = cursor;
  let hasMore = false;
  for (const row of rows) {
    if (out.length === limit) {
      hasMore = true;
      break;
    }
    const item = JSON.parse(row.record) as Record<string, unknown>;
    item.seq = row.seq;
    out.push(item);
    next = row.seq;
  }
  // Without a further page the cursor jumps to the account's latest sequence.
  if (!hasMore) next = upper;
  return json({ changes: out, cursor: next, hasMore });
}

async function snapshot(ctx: RouteContext, identity: Identity): Promise<Response> {
  const db = ctx.env.DB;
  // Both reads run in one D1 batch (one transaction), so the cursor can never
  // advance past a change whose record is missing from the returned snapshot.
  const [recordsResult, latestResult] = await batch(db, [
    stmt(db, SELECT_ALL_RECORDS, identity.account),
    stmt(db, SELECT_LATEST_SEQ, identity.account),
  ]);
  const rows = (recordsResult?.results ?? []) as RecordRow[];
  if (rows.length > 10000) throw fail(409, 'snapshot_too_large');
  const latest = ((latestResult?.results ?? []) as { latest: number }[])[0];
  return json({
    records: rows.map(payloadOf),
    cursor: latest?.latest ?? 0,
  });
}
