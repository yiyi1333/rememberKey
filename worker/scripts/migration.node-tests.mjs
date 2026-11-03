import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  root,
  schema,
  sha,
  parseArgs,
  loadSource,
  makeRunner,
  assertEmpty,
  decodeRow,
  encodeRow,
  integer,
  textBytes,
  validDatabaseId,
} from "./migration-common.mjs";
import { migrate } from "./migrate-d1.mjs";
import { verify } from "./verify-d1.mjs";

let base, source;
before(async () => {
  await mkdir(path.join(root, ".tools/migration"), { recursive: true });
  base = await mkdtemp(path.join(root, ".tools/migration/script-tests-"));
  source = path.join(base, "export");
  execFileSync("go", ["test", "-count=1", "-run", "^TestWriteRehearsal$"], {
    cwd: path.join(root, "tools/migrate"),
    env: {
      ...process.env,
      RK_SYNTHETIC_EXPORT_OUT: source,
      TEMP: path.join(root, ".tools/migration-tmp"),
      TMP: path.join(root, ".tools/migration-tmp"),
      GOTMPDIR: path.join(root, ".tools/migration-tmp"),
      GOCACHE: path.join(root, ".tools/go-cache"),
      GOMODCACHE: path.join(root, ".tools/go-modcache"),
    },
    stdio: "pipe",
  });
});
async function copySource() {
  const dir = await mkdtemp(path.join(base, "case-"));
  await cp(source, dir, { recursive: true });
  return dir;
}
async function editManifest(dir, edit) {
  const p = path.join(dir, "manifest.json"),
    m = JSON.parse(await readFile(p, "utf8"));
  await edit(m);
  await writeFile(p, JSON.stringify(m));
}

test("explicit targeting arguments and production local rejection", () => {
  for (const args of [
    [],
    ["--source", "x", "--env", "preview"],
    ["--source", "x", "--env", "preview", "--local", "--remote"],
    ["--source", "x", "--env", "production", "--local"],
    ["--source", "x", "--env", "production", "--remote", "--persist-to", "x"],
  ])
    assert.throws(() => parseArgs(args));
  const o = parseArgs([
    "--source",
    "folder with spaces;$(ignored)",
    "--env",
    "preview",
    "--local",
  ]);
  assert.equal(o.mode, "local");
  assert.match(o.source, /folder with spaces/);
});
test("remote placeholder blocked before spawning Wrangler", async () => {
  await assert.rejects(
    makeRunner(
      parseArgs(["--source", source, "--env", "production", "--remote"]),
    ),
    /nonzero/,
  );
});
test("remote IDs require exact UUID grouping and nonzero value", () => {
  for (const value of [
    "------------------------------------",
    "12345678-1234-1234-1234-12345678901z",
    "00000000-0000-0000-0000-000000000000",
    "1234567-81234-1234-1234-123456789012",
  ])
    assert.equal(validDatabaseId(value), false);
  assert.equal(validDatabaseId("12345678-1234-1234-1234-123456789012"), true);
});
test("Go export is accepted and extra directory SQL is ignored", async () => {
  const dir = await copySource();
  await writeFile(path.join(dir, "never-run.sql"), "DROP TABLE accounts;");
  const m = await loadSource(dir);
  assert.equal(m.tables.length, 7);
  assert.equal(m.chunks.length, 1);
});
test("wrong manifest schema/version rejected", async () => {
  for (const change of [
    (m) => (m.version = 2),
    (m) => m.tables[0].columns.reverse(),
    (m) => m.tables.reverse(),
  ]) {
    const dir = await copySource();
    await editManifest(dir, change);
    await assert.rejects(loadSource(dir));
  }
});
test("path traversal and altered chunk hashes rejected", async () => {
  const dir = await copySource();
  await editManifest(dir, (m) => (m.chunks[0].name = "../outside.sql"));
  await assert.rejects(loadSource(dir));
  const corrupt = await copySource();
  await writeFile(path.join(corrupt, "part-00001.sql"), "DROP TABLE accounts;");
  await assert.rejects(loadSource(corrupt), /digest mismatch/);
});
test("arbitrary SQL cannot be authorized by replacing its manifest hash", async () => {
  const dir = await copySource(),
    raw = Buffer.from("DROP TABLE accounts;\n");
  await writeFile(path.join(dir, "part-00001.sql"), raw);
  await editManifest(
    dir,
    (m) =>
      (m.chunks[0] = {
        name: "part-00001.sql",
        sha256: sha(raw),
        bytes: raw.length,
      }),
  );
  await assert.rejects(loadSource(dir), /SQL differs/);
});
test("safe integer, invalid UTF8 and canonical base64 validation", () => {
  for (const v of ["9007199254740992", "-1", "01", "1.1", 1])
    assert.throws(() => integer(v));
  assert.equal(integer("9007199254740991"), "9007199254740991");
  assert.throws(() => textBytes("/w=="));
  assert.throws(() => textBytes("YQ"));
  assert.equal(textBytes("YQ==").toString(), "a");
  assert.throws(() => decodeRow(schema[0], [["text", null]]));
});
test("typed encoding retains NULL, empty, composed/decomposed Unicode and NUL", () => {
  const t = {
    columns: [
      { name: "text", type: "text", nullable: false },
      { name: "nil", type: "text", nullable: true },
      { name: "empty", type: "text", nullable: false },
      { name: "integer", type: "integer", nullable: false },
    ],
  };
  const row = {
    text: "中文\0e\u0301é",
    nil: null,
    empty: "",
    integer: "9007199254740991",
  };
  const values = decodeRow(t, JSON.parse(encodeRow(t, row)));
  assert.equal(values[0].toString(), row.text);
  assert.equal(values[1], null);
  assert.equal(values[2].length, 0);
  assert.equal(values[3], row.integer);
});
test("source high-water lower than AUTO_INCREMENT is rejected", async () => {
  const dir = await copySource();
  await editManifest(dir, (m) => (m.tables[3].highWater = "9"));
  await assert.rejects(loadSource(dir), /high water/);
});
test("oversized statement rejected before any target runner is invoked", async () => {
  const dir = await copySource(),
    p = path.join(dir, "accounts.jsonl"),
    lines = (await readFile(p, "utf8")).trimEnd().split("\n");
  const row = JSON.parse(lines[0]);
  row[4][1] = Buffer.alloc(48 * 1024, "x").toString("base64");
  lines[0] = JSON.stringify(row);
  const raw = Buffer.from(lines.join("\n") + "\n");
  await writeFile(p, raw);
  await editManifest(dir, (m) => {
    m.tables[0].sha256 = sha(raw);
    m.tables[0].jsonl.sha256 = sha(raw);
    m.tables[0].jsonl.bytes = raw.length;
  });
  let calls = 0;
  await assert.rejects(
    migrate({ source: dir }, async () => {
      calls++;
      throw Error("target touched");
    }),
    /statement exceeds/,
  );
  assert.equal(calls, 0);
});
test("nonempty business/session table refuses migration", async () => {
  await assert.rejects(
    assertEmpty(async () => [{ name: "accounts", n: 1 }]),
    /must be empty/,
  );
  const queries = [];
  await assertEmpty(async ({ sql }) => {
    queries.push(sql);
    return [{ n: 0 }];
  });
  assert.equal(queries.length, 3);
  assert.ok(queries.every((q) => q.split("UNION ALL").length <= 4));
});
test(
  "real local D1 partial-shard failure forbids resume and fresh retry verifies",
  { skip: process.env.RK_RUN_LOCAL_D1 !== "1", timeout: 240000 },
  async () => {
    const dir = await copySource();
    const full = await readFile(path.join(dir, "part-00001.sql"), "utf8");
    const split = full.indexOf("\n") + 1,
      parts = [full.slice(0, split), full.slice(split)];
    for (let i = 0; i < parts.length; i++)
      await writeFile(
        path.join(dir, `part-${String(i + 1).padStart(5, "0")}.sql`),
        parts[i],
      );
    await editManifest(
      dir,
      (m) =>
        (m.chunks = parts.map((s, i) => ({
          name: `part-${String(i + 1).padStart(5, "0")}.sql`,
          sha256: sha(s),
          bytes: Buffer.byteLength(s),
        }))),
    );
    const options = {
      source: dir,
      env: "preview",
      mode: "local",
      persist: path.join(base, "failed-d1"),
    };
    const run = await makeRunner(options);
    await run({ file: path.join(root, "worker/migrations/0001_init.sql") });
    let imported = 0;
    await assert.rejects(
      migrate(options, async () => async (command) => {
        if (command.file && ++imported === 2)
          return run({ sql: "SELECT missing_column FROM missing_table" });
        return run(command);
      }),
      /D1 command failed/,
    );
    assert.equal(imported, 2);
    assert.equal(
      (await run({ sql: "SELECT COUNT(*) AS n FROM accounts" }))[0].n,
      1,
    );
    await assert.rejects(migrate(options), /must be empty/);
    const fresh = { ...options, persist: path.join(base, "fresh-d1") },
      freshRun = await makeRunner(fresh);
    await freshRun({
      file: path.join(root, "worker/migrations/0001_init.sql"),
    });
    assert.equal((await migrate(fresh)).ok, true);
    assert.equal((await verify(fresh)).fullComparison, true);
  },
);
after(() => console.log(JSON.stringify({ syntheticTestArtifacts: base })));
