import { describe, expect, it, vi } from "vitest";
// This suite isolates idempotency race branches. Signature/envelope acceptance
// has separate crypto tests; arbitrary opaque edge text exposes both hashes.
vi.mock("../src/crypto", async (original) => ({
  ...(await original<typeof import("../src/crypto")>()),
  verify: async () => true,
  parseEnvelope: (envelope: string | null) => ({ envelope }),
}));
import {
  compatibleOperationHashes,
  operationHash,
  syncRoutes,
} from "../src/sync";
import fixtures from "./fixtures/legacy-operations.json";
import type { Identity, RouteContext } from "../src/types";

const op = fixtures.find((f) => f.name === "html-unicode-escapes")!.operation;
const identity: Identity = {
  account: "a",
  device: "d",
  family: "f",
  role: "admin",
  signKey: "test",
  tokenHash: "token",
};
const result = { operationId: op.operationId, status: "applied", record: null };
const storedRecord = {
  id: op.id,
  revision: 4,
  deleted: 0,
  envelope: op.envelope,
  signature: op.signature,
  operation: op.operationId,
  base: 3,
};
function context(firsts: unknown[], writes = 0) {
  const sqls: { sql: string; params: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        bind(...params: unknown[]) {
          sqls.push({ sql, params });
          return statement;
        },
        async first() {
          if (!firsts.length) throw Error("unexpected query");
          return firsts.shift();
        },
        async run() {
          return { success: true, meta: { changes: 0 } };
        },
      };
      return statement;
    },
    async batch() {
      return [
        { meta: { changes: writes } },
        { meta: { changes: writes } },
        { meta: { changes: writes } },
      ];
    },
  };
  const request = new Request("https://example.test/api/v1/sync/operations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operations: [op] }),
  });
  return {
    ctx: {
      env: { DB: db },
      request,
      url: new URL(request.url),
      path: "/sync/operations",
      method: "POST",
    } as unknown as RouteContext,
    sqls,
  };
}
const active = { account: "a", device: "d" };
describe("dual Go/Worker idempotency hashes in every branch", () => {
  it("returns only the two deterministic algorithms, with Go used for new writes", async () => {
    const hashes = await compatibleOperationHashes(op);
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).toBe(await operationHash(op));
    expect(hashes[0]).toBe(
      fixtures.find((f) => f.name === "html-unicode-escapes")!.hash,
    );
    expect(
      await compatibleOperationHashes(fixtures[0]!.operation),
    ).toHaveLength(1);
  });
  it.each(["go", "worker"] as const)(
    "replays a stored %s hash without a write",
    async (kind) => {
      const hashes = await compatibleOperationHashes(op);
      const { ctx, sqls } = context([
        active,
        { hash: hashes[kind === "go" ? 0 : 1], result: JSON.stringify(result) },
      ]);
      const response = await syncRoutes(ctx, identity);
      expect(await response!.json()).toEqual({ data: { results: [result] } });
      expect(sqls.some((q) => q.sql.includes("INSERT"))).toBe(false);
    },
  );
  it("rejects changed contents under a stored ID", async () => {
    const { ctx } = context([
      active,
      { hash: "not-an-allowed-hash", result: JSON.stringify(result) },
    ]);
    await expect(syncRoutes(ctx, identity)).rejects.toMatchObject({
      status: 409,
      code: "operation_id_reused",
    });
  });
  it.each([
    "winner-after-write",
    "winner-after-lost-race",
    "persist-conflict",
    "persist-applied",
    "persist-lost-conflict",
  ] as const)("accepts old Worker hash in %s", async (branch) => {
    const hashes = await compatibleOperationHashes(op);
    const winner = { hash: hashes[1], result: JSON.stringify(result) };
    const current = { ...storedRecord, revision: op.baseRevision };
    const queue =
      branch === "winner-after-write"
        ? [active, null, current, winner]
        : branch === "winner-after-lost-race"
          ? [active, null, current, active, storedRecord, winner]
          : branch === "persist-conflict"
            ? [active, null, { ...storedRecord, revision: 9 }, winner]
            : branch === "persist-applied"
              ? [active, null, current, active, storedRecord, null, winner]
              : [
                  active,
                  null,
                  current,
                  active,
                  { ...storedRecord, operation: "other" },
                  winner,
                ];
    const { ctx, sqls } = context(
      queue,
      branch === "winner-after-write" ? 1 : 0,
    );
    expect(await (await syncRoutes(ctx, identity))!.json()).toEqual({
      data: { results: [result] },
    });
    const guard = sqls.find((q) => q.sql.includes("INSERT INTO records"));
    if (guard) {
      expect(guard.sql).toContain("o.hash NOT IN (?,?)");
      expect(guard.params).toContain(hashes[0]);
      expect(guard.params).toContain(hashes[1]);
    }
    for (const insert of sqls.filter((q) =>
      q.sql.includes("INSERT INTO operations"),
    ))
      expect(insert.params).toContain(hashes[0]);
  });
  it.each([
    "winner-after-write",
    "winner-after-lost-race",
    "persist-conflict",
    "persist-applied",
    "persist-lost-conflict",
  ] as const)("rejects a differing winner in %s", async (branch) => {
    const winner = { hash: "changed-body", result: JSON.stringify(result) };
    const current = { ...storedRecord, revision: op.baseRevision };
    const queue =
      branch === "winner-after-write"
        ? [active, null, current, winner]
        : branch === "winner-after-lost-race"
          ? [active, null, current, active, storedRecord, winner]
          : branch === "persist-conflict"
            ? [active, null, { ...storedRecord, revision: 9 }, winner]
            : branch === "persist-applied"
              ? [active, null, current, active, storedRecord, null, winner]
              : [
                  active,
                  null,
                  current,
                  active,
                  { ...storedRecord, operation: "other" },
                  winner,
                ];
    const { ctx } = context(queue, branch === "winner-after-write" ? 1 : 0);
    await expect(syncRoutes(ctx, identity)).rejects.toMatchObject({
      status: 409,
      code: "operation_id_reused",
    });
  });
});
