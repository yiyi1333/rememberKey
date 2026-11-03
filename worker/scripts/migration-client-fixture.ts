// Synthetic, real-client crypto input for the offline rehearsal; never production data.
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  createAccount,
  makeOperation,
  newDevice,
  decryptRecord,
  unlock,
} from "../../web/src/crypto";
import { schema, root } from "./migration-common.mjs";

Object.defineProperty(globalThis, "navigator", {
  value: { platform: "synthetic-migration" },
  configurable: true,
});
const base = process.argv[2];
if (!base) throw Error("provide a NEW output base directory");
const directory = path.resolve(base);
await fs.mkdir(directory, { recursive: false });
const password = "synthetic-only migration test password";
const client = await createAccount("SyntheticAdmin", password);
const local = client.local;
const second = newDevice(local, client.keys.root, client.keys.signPrivate);
const value = {
  name: "Migration vault",
  provider: "synthetic",
  secret: "only-synthetic-<>&中文",
  url: "https://example.invalid",
  notes: "e\u0301 / é / \u2028\u2029",
  expiresAt: "",
  tags: ["migration"],
};
const recordId = crypto.randomUUID();
const create = makeOperation(local, client.keys, recordId, 0, value);
const deleted = makeOperation(local, client.keys, crypto.randomUUID(), 1, null);
const conflict = makeOperation(local, client.keys, recordId, 0, {
  ...value,
  secret: "conflicting-value",
});
const record = (op, revision) => ({
  id: op.id,
  revision,
  deleted: op.deleted,
  envelope: op.envelope,
  signature: op.signature,
  operationId: op.operationId,
  baseRevision: op.baseRevision,
});
const live = record(create, 1),
  tombstone = record(deleted, 2);
// Use independent Go encoder command rather than copying Worker hash logic.
const operations = [create, deleted, conflict];
const input = path.join(directory, "operations.json");
await fs.writeFile(input, JSON.stringify(operations));
const digestRows = JSON.parse(
  execFileSync("go", ["run", "./cmd/hashoperations", "--input", input], {
    cwd: path.join(root, "tools/migrate"),
    env: {
      ...process.env,
      TEMP: path.join(root, ".tools/migration-tmp"),
      TMP: path.join(root, ".tools/migration-tmp"),
      GOTMPDIR: path.join(root, ".tools/migration-tmp"),
      GOCACHE: path.join(root, ".tools/go-cache"),
      GOMODCACHE: path.join(root, ".tools/go-modcache"),
    },
    encoding: "utf8",
  }),
);
const tables = Object.fromEntries(schema.map((t) => [t.name, []]));
tables.accounts.push([
  local.accountId,
  local.username,
  local.signPublicKey,
  local.boxPublicKey,
  JSON.stringify(local.keyBundle),
  "1",
  "admin",
  "0",
  "2026-11-03T00:00:00Z",
]);
for (const [device, revoked] of [
  [client, null],
  [second, "2026-11-03T01:00:00Z"],
])
  tables.devices.push([
    local.accountId,
    device.local.deviceId,
    device.local.deviceName,
    device.local.devicePublicKey,
    device.registration.proof,
    "2026-11-03T00:00:00Z",
    revoked,
  ]);
for (const r of [live, tombstone])
  tables.records.push([
    local.accountId,
    r.id,
    String(r.revision),
    r.deleted ? "1" : "0",
    r.envelope,
    r.signature,
    r.operationId,
    String(r.baseRevision),
  ]);
tables.changes.push(
  ["4", local.accountId, JSON.stringify(live)],
  ["9", local.accountId, JSON.stringify(tombstone)],
);
for (const [i, op] of operations.entries())
  tables.operations.push([
    local.accountId,
    op.operationId,
    digestRows[i].hash,
    JSON.stringify({
      operationId: op.operationId,
      status: i === 2 ? "conflict" : "applied",
      record: i === 1 ? tombstone : live,
    }),
  ]);
tables.audit.push([
  "3",
  local.accountId,
  "synthetic",
  "vault",
  "2026-11-03T00:00:00Z",
]);
tables.invitations.push(["used-synthetic-invitation", "1893456000", "1", null]);
for (const t of schema)
  tables[t.name].sort((a, b) => {
    for (const key of t.primaryKey) {
      const i = t.columns.findIndex((c) => c.name === key);
      const diff =
        t.columns[i].type === "integer"
          ? Number(BigInt(a[i]) - BigInt(b[i]))
          : Buffer.compare(Buffer.from(a[i]), Buffer.from(b[i]));
      if (diff) return diff;
    }
    return 0;
  });
const unlocked = await unlock(local, password);
const decrypted = decryptRecord(
  local,
  { ...unlocked, devicePrivate: client.keys.devicePrivate },
  recordId,
  create.envelope!,
);
if (JSON.stringify(decrypted) !== JSON.stringify(value))
  throw Error("real client decrypt fixture failed");
await fs.writeFile(
  path.join(directory, "source.json"),
  JSON.stringify({ tables, autoIncrement: 42 }, null, 2),
);
await fs.writeFile(
  path.join(directory, "client.json"),
  JSON.stringify(
    {
      local,
      password,
      keys: Object.fromEntries(
        Object.entries(client.keys).map(([k, v]) => [k, Array.from(v)]),
      ),
      create,
      deleted,
      conflict,
      value,
      live,
      tombstone,
      revokedDevice: second.local.deviceId,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    ok: true,
    source: path.join(directory, "source.json"),
    clientCryptoDecrypted: true,
  }),
);
