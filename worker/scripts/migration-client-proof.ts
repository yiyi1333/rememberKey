import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import handler from "../src/index";
import {
  unlock,
  decryptRecord,
  signMessage,
  makeOperation,
} from "../../web/src/crypto";
import { root } from "./migration-common.mjs";
import type { Env } from "../src/types";

const require = createRequire(path.join(root, "worker/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const base = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw Error("provide synthetic rehearsal directory");
const f = JSON.parse(await fs.readFile(path.join(base, "client.json"), "utf8"));
const local = f.local,
  keys = Object.fromEntries(
    Object.entries(f.keys).map(([k, v]) => [k, new Uint8Array(v as number[])]),
  );
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: "export default {}",
    d1Databases: { DB: "00000000-0000-0000-0000-000000000000" },
    resourcePersistencePath: path.join(base, "d1/v3"),
    compatibilityDate: "2026-10-01",
  }),
);
try {
  const DB = await mf.getD1Database("DB");
  const origin = "https://staging.rememberkey-web.pages.dev";
  const env = { DB, RK_ORIGIN: origin } as Env;
  let token = "";
  const call = async (route: string, body?: unknown) => {
    const response = await handler.fetch(
      new Request(origin + "/api/v1" + route, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          origin,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(token ? { authorization: "Bearer " + token } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
    const data = (await response.json()) as any;
    return { response, data: data.data ?? data };
  };
  const lookup = await call(
    "/accounts/lookup?username=" + encodeURIComponent(local.username),
  );
  assert.equal(lookup.response.status, 200);
  assert.equal(lookup.data.accountId, local.accountId);
  const unlocked = await unlock(lookup.data, f.password);
  assert.equal(
    Buffer.from(unlocked.root).toString("hex"),
    Buffer.from(keys.root).toString("hex"),
  );
  const challenge = await call("/auth/challenges", {
    accountId: local.accountId,
    deviceId: local.deviceId,
  });
  assert.equal(challenge.response.status, 200);
  const login = await call("/auth/sessions", {
    challengeId: challenge.data.id,
    signature: signMessage(challenge.data.message, keys.devicePrivate),
  });
  assert.equal(login.response.status, 200);
  token = login.data.accessToken;
  assert.ok(token);
  const revoked = await call("/auth/challenges", {
    accountId: local.accountId,
    deviceId: f.revokedDevice,
  });
  assert.equal(revoked.response.status, 403);
  const before = await DB.prepare("SELECT COUNT(*) AS n FROM changes").first();
  const replay = await call("/sync/operations", {
    operations: [f.create, f.deleted, f.conflict],
  });
  assert.equal(replay.response.status, 200);
  assert.deepEqual(
    replay.data.results.map((r) => r.status),
    ["applied", "applied", "conflict"],
  );
  const after = await DB.prepare("SELECT COUNT(*) AS n FROM changes").first();
  assert.equal(after.n, before.n);
  const pull = await call("/sync/changes?cursor=4&limit=100");
  assert.equal(pull.response.status, 200);
  assert.equal(pull.data.cursor, 9);
  assert.deepEqual(pull.data.changes, [{ ...f.tombstone, seq: 9 }]);
  const snapshot = await call("/sync/snapshot");
  assert.equal(snapshot.response.status, 200);
  assert.equal(snapshot.data.cursor, 9);
  const live = snapshot.data.records.find((r) => r.id === f.create.id);
  assert.equal(live.revision, 1);
  const value = decryptRecord(
    lookup.data,
    { ...unlocked, devicePrivate: keys.devicePrivate },
    live.id,
    live.envelope,
  );
  assert.deepEqual(value, f.value);
  const invitation = await DB.prepare(
    "SELECT used,used_by FROM invitations WHERE hash='used-synthetic-invitation'",
  ).first();
  assert.equal(invitation.used, 1);
  assert.equal(invitation.used_by, null);
  // API writes use source high-water 41, even though max imported seq is 9.
  const updated = makeOperation(
    lookup.data,
    { ...unlocked, devicePrivate: keys.devicePrivate },
    live.id,
    1,
    { ...f.value, notes: "after migration" },
  );
  const applied = await call("/sync/operations", { operations: [updated] });
  assert.equal(applied.response.status, 200);
  assert.equal(applied.data.results[0].record.revision, 2);
  const next = await DB.prepare("SELECT MAX(seq) AS seq FROM changes").first();
  assert.equal(next.seq, 42);
  await DB.prepare(
    "INSERT INTO audit(actor,action,target,created) VALUES('synthetic','test','high-water','now')",
  ).run();
  const auditNext = await DB.prepare(
    "SELECT MAX(seq) AS seq FROM audit",
  ).first();
  assert.equal(auditNext.seq, 42);
  console.log(
    JSON.stringify({
      ok: true,
      realClientUnlock: true,
      originalAccountId: true,
      challengeLogin: true,
      revokedDeviceRejected: true,
      goOperationReplayWithoutNewRevision: true,
      conflictReplay: true,
      legacyCursor: 9,
      clientRecordDecrypted: true,
      usedInvitationPreserved: true,
      nextChangeSeq: next.seq,
      nextAuditSeq: auditNext.seq,
    }),
  );
} finally {
  await mf.dispose();
}
