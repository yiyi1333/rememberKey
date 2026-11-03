import { describe, expect, it } from 'vitest';
import legacyFixtures from './fixtures/legacy-operations.json';
import {
  canonicalOperation,
  normalizeOperation,
  operationHash,
  operationMessage,
  parseResult,
  payloadOf,
  recordJson,
  resultJson,
  syncRoutes,
} from '../src/sync';
import type { RecordPayload } from '../src/sync';
import type { OperationLike } from '../src/crypto';
import type { Env, Identity, RecordRow, RouteContext } from '../src/types';

// Fixtures shared with the hash constants below; kept stable so that the
// expected digests are hard-coded (independent of the implementation).
const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const OPERATION_ID = '20000000-0000-4000-8000-000000000002';
const RECORD_ID = '30000000-0000-4000-8000-000000000003';
const ENVELOPE =
  '{"version":1,"nonce":"nonce","ciphertext":"ciphertext","wrappedKey":"wrapped"}';
const SIGNATURE = 'c2lnbmF0dXJl';

const CREATE_OP: OperationLike = {
  operationId: OPERATION_ID,
  id: RECORD_ID,
  baseRevision: 3,
  deleted: false,
  envelope: ENVELOPE,
  signature: SIGNATURE,
};

const DELETE_OP: OperationLike = {
  operationId: OPERATION_ID,
  id: RECORD_ID,
  baseRevision: 1,
  deleted: true,
  envelope: null,
  signature: SIGNATURE,
};

const CANONICAL_CREATE =
  '{"operationId":"20000000-0000-4000-8000-000000000002",' +
  '"id":"30000000-0000-4000-8000-000000000003",' +
  '"baseRevision":3,"deleted":false,' +
  '"envelope":"{\\"version\\":1,\\"nonce\\":\\"nonce\\",\\"ciphertext\\":\\"ciphertext\\",\\"wrappedKey\\":\\"wrapped\\"}",' +
  '"signature":"c2lnbmF0dXJl"}';

const CANONICAL_DELETE =
  '{"operationId":"20000000-0000-4000-8000-000000000002",' +
  '"id":"30000000-0000-4000-8000-000000000003",' +
  '"baseRevision":1,"deleted":true,"envelope":null,"signature":"c2lnbmF0dXJl"}';

describe('canonicalOperation (Go Operation json.Marshal parity)', () => {
  it('serializes fields in Go struct order with boolean and envelope text verbatim', () => {
    expect(canonicalOperation(CREATE_OP)).toBe(CANONICAL_CREATE);
  });

  it('serializes a deleted operation with a null envelope and true boolean', () => {
    expect(canonicalOperation(DELETE_OP)).toBe(CANONICAL_DELETE);
  });

  it('does not reshape the opaque envelope JSON text', () => {
    const padded: OperationLike = {
      ...CREATE_OP,
      envelope: '{ "version" : 1,  "nonce" : "nonce" }',
    };
    expect(canonicalOperation(padded)).toContain('{ \\"version\\" : 1,  \\"nonce\\" : \\"nonce\\" }');
  });
});

describe('operationHash', () => {
  it.each(legacyFixtures)('accepts independent Go hash: $name', async fixture => {
    expect(canonicalOperation(fixture.operation)).toBe(fixture.canonical);
    expect(await operationHash(fixture.operation)).toBe(fixture.hash);
  });
  it('is sha256 hex of the canonical operation JSON', async () => {
    await expect(operationHash(CREATE_OP)).resolves.toBe(
      'ca5b877776bd21daeb3540bc8f39c005bc7bb102cfd914f3cddf4bd43058d293',
    );
  });

  it('covers the envelope text and signature, so bodies hash differently', async () => {
    const other = await operationHash({ ...CREATE_OP, signature: 'b3RoZXI=' });
    await expect(other).not.toBe(
      await operationHash(CREATE_OP),
    );
  });
});

describe('operationMessage (signature domain separation parity with Go)', () => {
  it('builds the exact rememberKey:op:1 message using the envelope digest', async () => {
    await expect(operationMessage(ACCOUNT, CREATE_OP)).resolves.toBe(
      'rememberKey:op:1:00000000-0000-4000-8000-000000000001:' +
        '20000000-0000-4000-8000-000000000002:' +
        '30000000-0000-4000-8000-000000000003:' +
        '3:0:' +
        'e250e7b9ff2f90407fe8b75cff9567ecd18d78382995a620c1d5c3bedaf24ae5',
    );
  });

  it('uses the empty-envelope digest and deleted flag "1" for delete operations', async () => {
    await expect(operationMessage(ACCOUNT, DELETE_OP)).resolves.toBe(
      'rememberKey:op:1:00000000-0000-4000-8000-000000000001:' +
        '20000000-0000-4000-8000-000000000002:' +
        '30000000-0000-4000-8000-000000000003:' +
        '1:1:' +
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('normalizeOperation', () => {
  it('maps an absent envelope to null', () => {
    const normalized = normalizeOperation({
      operationId: OPERATION_ID,
      id: RECORD_ID,
      baseRevision: 0,
      deleted: false,
      signature: SIGNATURE,
    });
    expect(normalized.envelope).toBeNull();
    expect(normalized).toEqual({
      operationId: OPERATION_ID,
      id: RECORD_ID,
      baseRevision: 0,
      deleted: false,
      envelope: null,
      signature: SIGNATURE,
    });
  });

  it('keeps a provided envelope and drops nothing else', () => {
    expect(
      normalizeOperation({
        operationId: OPERATION_ID,
        id: RECORD_ID,
        baseRevision: 3,
        deleted: false,
        envelope: ENVELOPE,
        signature: SIGNATURE,
      }),
    ).toEqual(CREATE_OP);
  });
});

describe('payloadOf (records row -> protocol record)', () => {
  it('maps deleted 0 to false and keeps the envelope string untouched', () => {
    const row: RecordRow = {
      id: RECORD_ID,
      revision: 1,
      deleted: 0,
      envelope: ENVELOPE,
      signature: SIGNATURE,
      operation: OPERATION_ID,
      base: 0,
    };
    expect(payloadOf(row)).toEqual({
      id: RECORD_ID,
      revision: 1,
      deleted: false,
      envelope: ENVELOPE,
      signature: SIGNATURE,
      operationId: OPERATION_ID,
      baseRevision: 0,
    });
  });

  it('maps deleted 1 to true and keeps a null envelope', () => {
    const row: RecordRow = {
      id: RECORD_ID,
      revision: 2,
      deleted: 1,
      envelope: null,
      signature: SIGNATURE,
      operation: OPERATION_ID,
      base: 1,
    };
    expect(payloadOf(row)).toMatchObject({ deleted: true, envelope: null, baseRevision: 1 });
  });
});

describe('response serialization', () => {
  const record: RecordPayload = {
    id: RECORD_ID,
    revision: 4,
    deleted: false,
    envelope: ENVELOPE,
    signature: SIGNATURE,
    operationId: OPERATION_ID,
    baseRevision: 3,
  };

  it('recordJson uses Go Record field order and keeps envelope text verbatim', () => {
    expect(recordJson(record)).toBe(
      '{"id":"30000000-0000-4000-8000-000000000003","revision":4,"deleted":false,' +
        '"envelope":"{\\"version\\":1,\\"nonce\\":\\"nonce\\",\\"ciphertext\\":\\"ciphertext\\",\\"wrappedKey\\":\\"wrapped\\"}",' +
        '"signature":"c2lnbmF0dXJl",' +
        '"operationId":"20000000-0000-4000-8000-000000000002","baseRevision":3}',
    );
  });

  it('resultJson serializes operationId, status, record in Go Result order', () => {
    const json = resultJson({ operationId: OPERATION_ID, status: 'applied', record });
    expect(json.startsWith('{"operationId":"20000000-0000-4000-8000-000000000002","status":"applied","record":{')).toBe(
      true,
    );
    // A conflict can reference no record at all.
    expect(
      resultJson({ operationId: OPERATION_ID, status: 'conflict', record: null }),
    ).toBe(
      '{"operationId":"20000000-0000-4000-8000-000000000002","status":"conflict","record":null}',
    );
  });

  it('parseResult round-trips every serialized result byte for byte', () => {
    for (const result of [
      { operationId: OPERATION_ID, status: 'applied' as const, record },
      { operationId: OPERATION_ID, status: 'applied' as const, record: { ...record, revision: 2, deleted: true, envelope: null, baseRevision: 1 } },
      { operationId: OPERATION_ID, status: 'conflict' as const, record },
      { operationId: OPERATION_ID, status: 'conflict' as const, record: null },
    ]) {
      expect(parseResult(resultJson(result))).toEqual(result);
    }
  });

  it('parseResult accepts results persisted by an earlier worker version', () => {
    const persisted =
      '{"operationId":"20000000-0000-4000-8000-000000000002","status":"conflict","record":null}';
    expect(parseResult(persisted)).toEqual({
      operationId: OPERATION_ID,
      status: 'conflict',
      record: null,
    });
  });
});

// Dispatch and batch validation: these paths reject the request before any op
// is applied, so they run without a live D1 binding.
function syncContext(path: string, method: string, body?: unknown): RouteContext {
  const hasBody = body !== undefined;
  const request = new Request(`http://worker.test/api/v1${path}`, {
    method,
    body: hasBody ? JSON.stringify(body) : undefined,
    headers: hasBody ? { 'content-type': 'application/json' } : undefined,
  });
  return {
    // Deliberately no DB: touching it would throw a TypeError instead of the
    // expected HttpError, which is what these tests assert against.
    env: {} as unknown as Env,
    request,
    url: new URL(request.url),
    path,
    method,
  };
}

const IDENTITY: Identity = {
  account: ACCOUNT,
  device: '40000000-0000-4000-8000-000000000004',
  family: '50000000-0000-4000-8000-000000000005',
  role: 'member',
  signKey: 'a2ln',
  tokenHash: 'a'.repeat(64),
};

describe('syncRoutes dispatch', () => {
  it('returns null for paths it does not own', async () => {
    await expect(syncRoutes(syncContext('/records', 'GET'), IDENTITY)).resolves.toBeNull();
    await expect(syncRoutes(syncContext('/admin/records', 'GET'), IDENTITY)).resolves.toBeNull();
    await expect(syncRoutes(syncContext('/sync/changes', 'POST'), IDENTITY)).resolves.toBeNull();
    await expect(syncRoutes(syncContext('/sync/operations', 'GET'), IDENTITY)).resolves.toBeNull();
  });

  it('rejects an empty batch before touching the database', async () => {
    await expect(
      syncRoutes(syncContext('/sync/operations', 'POST', { operations: [] }), IDENTITY),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_batch' });
  });

  it('treats a missing or null operations field as an empty batch (Go nil slice)', async () => {
    await expect(
      syncRoutes(syncContext('/sync/operations', 'POST', {}), IDENTITY),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_batch' });
    await expect(
      syncRoutes(syncContext('/sync/operations', 'POST', { operations: null }), IDENTITY),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_batch' });
  });

  it('rejects a non-array operations field as malformed JSON', async () => {
    await expect(
      syncRoutes(syncContext('/sync/operations', 'POST', { operations: {} }), IDENTITY),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_json' });
  });

  it('strict-validates every item before applying any of them', async () => {
    // A valid first item plus a bad second item must reject the whole batch
    // with invalid_json, proving no operation was applied first (the context
    // has no DB, so applying would throw a TypeError instead).
    await expect(
      syncRoutes(
        syncContext('/sync/operations', 'POST', {
          operations: [
            { operationId: OPERATION_ID, id: RECORD_ID, baseRevision: 0, deleted: false, signature: SIGNATURE },
            { operationId: OPERATION_ID, unexpectedField: true },
          ],
        }),
        IDENTITY,
      ),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_json' });
  });

  it('rejects an unknown field on the single operation item', async () => {
    await expect(
      syncRoutes(
        syncContext('/sync/operations', 'POST', {
          operations: [
            { operationId: OPERATION_ID, id: RECORD_ID, baseRevision: 0, deleted: false, signature: SIGNATURE, extra: 1 },
          ],
        }),
        IDENTITY,
      ),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_json' });
  });

  it('rejects non-integer baseRevision as malformed JSON', async () => {
    await expect(
      syncRoutes(
        syncContext('/sync/operations', 'POST', {
          operations: [
            { operationId: OPERATION_ID, id: RECORD_ID, baseRevision: 1.5, deleted: false, signature: SIGNATURE },
          ],
        }),
        IDENTITY,
      ),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_json' });
  });
});
