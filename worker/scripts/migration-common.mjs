import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const c = (name, type = "text", nullable = false) => ({ name, type, nullable });
export const schema = [
  {
    name: "accounts",
    columns: [
      c("id"),
      c("username"),
      c("sign_key"),
      c("box_key"),
      c("bundle"),
      c("bundle_version", "integer"),
      c("role"),
      c("disabled", "integer"),
      c("created"),
    ],
    primaryKey: ["id"],
  },
  {
    name: "devices",
    columns: [
      c("account"),
      c("id"),
      c("name"),
      c("pub"),
      c("proof"),
      c("created"),
      c("revoked", "text", true),
    ],
    primaryKey: ["account", "id"],
  },
  {
    name: "records",
    columns: [
      c("account"),
      c("id"),
      c("revision", "integer"),
      c("deleted", "integer"),
      c("envelope", "text", true),
      c("signature"),
      c("operation"),
      c("base", "integer"),
    ],
    primaryKey: ["account", "id"],
  },
  {
    name: "changes",
    columns: [c("seq", "integer"), c("account"), c("record")],
    primaryKey: ["seq"],
  },
  {
    name: "operations",
    columns: [c("account"), c("id"), c("hash"), c("result")],
    primaryKey: ["account", "id"],
  },
  {
    name: "audit",
    columns: [
      c("seq", "integer"),
      c("actor"),
      c("action"),
      c("target"),
      c("created"),
    ],
    primaryKey: ["seq"],
  },
  {
    name: "invitations",
    columns: [
      c("hash"),
      c("expires", "integer"),
      c("used", "integer"),
      c("used_by", "text", true),
    ],
    primaryKey: ["hash"],
  },
];
export const transients = [
  "challenges",
  "families",
  "access_tokens",
  "refresh_tokens",
];
export const sha = (raw) => createHash("sha256").update(raw).digest("hex");
export function validDatabaseId(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    ) &&
    !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)
  );
}
export function integer(value) {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) > 9007199254740991n
  )
    throw Error("unsafe/noncanonical integer");
  return value;
}
export function textBytes(value) {
  if (typeof value !== "string") throw Error("invalid text");
  const raw = Buffer.from(value, "base64");
  if (raw.toString("base64") !== value) throw Error("noncanonical base64");
  new TextDecoder("utf-8", { fatal: true }).decode(raw);
  return raw;
}
export function decodeRow(table, row) {
  if (!Array.isArray(row) || row.length !== table.columns.length)
    throw Error("wrong row columns");
  return row.map((tuple, i) => {
    const col = table.columns[i];
    if (!Array.isArray(tuple) || tuple.length !== 2 || tuple[0] !== col.type)
      throw Error("wrong tuple type");
    const v = tuple[1];
    if (v === null) {
      if (!col.nullable) throw Error("unexpected NULL");
      return null;
    }
    return col.type === "integer" ? integer(v) : textBytes(v);
  });
}
export function encodeRow(table, row) {
  return (
    JSON.stringify(
      table.columns.map((c) => [
        c.type,
        row[c.name] === null
          ? null
          : c.type === "integer"
            ? integer(row[c.name])
            : Buffer.from(row[c.name], "utf8").toString("base64"),
      ]),
    ) + "\n"
  );
}
export function insertSQL(table, values) {
  return `INSERT INTO "${table.name}" (${table.columns.map((c) => `"${c.name}"`).join(",")}) VALUES (${values.map((v, i) => (v === null ? "NULL" : table.columns[i].type === "integer" ? v : `CAST(X'${v.toString("hex")}' AS TEXT)`)).join(",")});\n`;
}
export function parseArgs(args) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--local" || a === "--remote") {
      if (o.mode) throw Error("exactly one --local or --remote required");
      o.mode = a.slice(2);
    } else if (["--source", "--env", "--persist-to"].includes(a)) {
      const key = a.slice(2);
      if (o[key] !== undefined || !args[i + 1] || args[i + 1].startsWith("--"))
        throw Error("missing/duplicate option");
      o[key] = args[++i];
    } else throw Error("unknown option");
  }
  if (!o.source || !["preview", "production"].includes(o.env) || !o.mode)
    throw Error(
      "--source, --env preview|production and exactly one --local|--remote are required",
    );
  if (o.env === "production" && o.mode !== "remote")
    throw Error("production requires explicit --remote");
  if (o.mode === "remote" && o["persist-to"])
    throw Error("--persist-to is local-only");
  o.source = path.resolve(o.source);
  o.persist = path.resolve(
    o["persist-to"] ?? path.join(root, ".tools/migration/d1-local"),
  );
  return o;
}
async function safeFile(source, file) {
  if (
    !file ||
    typeof file.name !== "string" ||
    !/^[a-z0-9-]+\.(jsonl|sql)$/.test(file.name) ||
    !Number.isSafeInteger(file.bytes) ||
    file.bytes < 0 ||
    !/^[0-9a-f]{64}$/.test(file.sha256)
  )
    throw Error("invalid manifest file");
  const p = path.join(source, file.name);
  if (path.dirname(await realpath(p)) !== (await realpath(source)))
    throw Error("file escapes source");
  // JSONL may contain a large vault: hash it as a stream instead of retaining
  // a second complete copy. SQL chunks are bounded before this function runs.
  if (file.name.endsWith(".jsonl")) {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const buffer of createReadStream(p)) {
      bytes += buffer.length;
      hash.update(buffer);
    }
    if (bytes !== file.bytes || hash.digest("hex") !== file.sha256)
      throw Error(`file digest mismatch: ${file.name}`);
    return;
  }
  const raw = await readFile(p);
  if (raw.length !== file.bytes || sha(raw) !== file.sha256)
    throw Error(`file digest mismatch: ${file.name}`);
  return raw;
}
export async function loadSource(source) {
  const m = JSON.parse(
    await readFile(path.join(source, "manifest.json"), "utf8"),
  );
  if (
    m.format !== "rememberKey-mysql-d1" ||
    m.version !== 1 ||
    m.digestEncoding !== "typed-tuples-ascii-json-lf-v1" ||
    !Array.isArray(m.tables) ||
    m.tables.length !== schema.length ||
    !Array.isArray(m.chunks)
  )
    throw Error("unsupported manifest");
  const accounts = new Set(),
    usernames = new Set();
  let admin = false;
  let chunkIndex = 0,
    chunkOffset = 0,
    chunkBytes = null;
  const compareSQL = async (statement) => {
    const expected = Buffer.from(statement);
    let offset = 0;
    while (offset < expected.length) {
      if (chunkBytes === null || chunkOffset === chunkBytes.length) {
        const file = m.chunks[chunkIndex];
        if (!file) throw Error("incomplete chunks");
        if (
          file.name !== `part-${String(chunkIndex + 1).padStart(5, "0")}.sql` ||
          file.bytes > 512 * 1024 ||
          !file.bytes
        )
          throw Error("invalid chunk sequence/size");
        chunkBytes = await safeFile(source, file);
        if (!chunkBytes.subarray(-2).equals(Buffer.from(";\n")))
          throw Error("chunk must end at a complete statement");
        chunkIndex++;
        chunkOffset = 0;
      }
      const size = Math.min(
        expected.length - offset,
        chunkBytes.length - chunkOffset,
      );
      if (
        !expected
          .subarray(offset, offset + size)
          .equals(chunkBytes.subarray(chunkOffset, chunkOffset + size))
      )
        throw Error("SQL differs from validated rows");
      offset += size;
      chunkOffset += size;
    }
  };
  for (let i = 0; i < schema.length; i++) {
    const t = schema[i],
      tm = m.tables[i];
    if (
      JSON.stringify({
        name: tm.name,
        columns: tm.columns,
        primaryKey: tm.primaryKey,
      }) !== JSON.stringify(t)
    )
      throw Error("manifest schema mismatch");
    if (
      !Number.isSafeInteger(tm.rows) ||
      tm.rows < 0 ||
      tm.sha256 !== tm.jsonl.sha256 ||
      tm.jsonl.name !== `${t.name}.jsonl`
    )
      throw Error("invalid table metadata");
    await safeFile(source, tm.jsonl);
    const digest = createHash("sha256");
    let count = 0,
      previous = null,
      max = 0n;
    for await (const line of createInterface({
      input: createReadStream(path.join(source, tm.jsonl.name)),
      crlfDelay: Infinity,
    })) {
      const typed = JSON.parse(line),
        values = decodeRow(t, typed);
      if (JSON.stringify(typed) !== line)
        throw Error("noncanonical row encoding");
      digest.update(line + "\n");
      count++;
      const fields = Object.fromEntries(
        t.columns.map((c, j) => [
          c.name,
          values[j] === null
            ? null
            : c.type === "text"
              ? values[j].toString("utf8")
              : values[j],
        ]),
      );
      const keys = t.primaryKey.map((k) => ({
        type: t.columns.find((c) => c.name === k).type,
        value: fields[k],
      }));
      if (keys.some((k) => k.value === "")) throw Error("empty primary key");
      if (previous) {
        let cmp = 0;
        for (let j = 0; j < keys.length; j++) {
          cmp =
            keys[j].type === "integer"
              ? BigInt(previous[j].value) < BigInt(keys[j].value)
                ? -1
                : BigInt(previous[j].value) > BigInt(keys[j].value)
                  ? 1
                  : 0
              : Buffer.compare(
                  Buffer.from(previous[j].value),
                  Buffer.from(keys[j].value),
                );
          if (cmp) break;
        }
        if (cmp >= 0) throw Error("unsorted/duplicate primary key");
      }
      previous = keys;
      for (const k of ["disabled", "deleted", "used"])
        if (k in fields && !["0", "1"].includes(fields[k]))
          throw Error("invalid boolean");
      if (t.name === "accounts") {
        if (!["admin", "user"].includes(fields.role))
          throw Error("invalid role");
        const folded = fields.username.replace(/[A-Z]/g, (c) =>
          c.toLowerCase(),
        );
        // SQLite NOCASE compares through the first NUL, then byte lengths.
        const usernameKey = `${Buffer.byteLength(folded)}:${folded.split("\0", 1)[0]}`;
        if (!folded || usernames.has(usernameKey))
          throw Error("NOCASE collision");
        usernames.add(usernameKey);
        accounts.add(fields.id);
        admin ||= fields.role === "admin" && fields.disabled === "0";
      }
      if ("account" in fields && !accounts.has(fields.account))
        throw Error("missing account reference");
      if (t.name === "invitations" && fields.used_by !== null)
        throw Error("legacy invitation used_by must be NULL");
      if ("seq" in fields) max = BigInt(fields.seq);
      const statement = insertSQL(t, values);
      if (Buffer.byteLength(statement) > 90 * 1024)
        throw Error("statement exceeds limit");
      await compareSQL(statement);
    }
    if (count !== tm.rows || digest.digest("hex") !== tm.sha256)
      throw Error("table digest/count mismatch");
    for (const k of ["maxSeq", "autoIncrement", "highWater"]) integer(tm[k]);
    if (["changes", "audit"].includes(t.name)) {
      const next = BigInt(tm.autoIncrement),
        high = BigInt(tm.highWater);
      if (
        next < 1n ||
        BigInt(tm.maxSeq) !== max ||
        high !== (max > next - 1n ? max : next - 1n) ||
        high >= 9007199254740991n
      )
        throw Error("invalid high water");
      await compareSQL(
        `DELETE FROM sqlite_sequence WHERE name='${t.name}';\nINSERT INTO sqlite_sequence(name,seq) VALUES('${t.name}',${high});\n`,
      );
    } else if (
      [tm.maxSeq, tm.autoIncrement, tm.highWater].some((x) => x !== "0")
    )
      throw Error("unexpected sequence metadata");
  }
  if (!admin) throw Error("no active administrator");
  // Reconstruct every allowed SQL statement from validated JSONL. A changed manifest
  // cannot smuggle arbitrary SQL by merely replacing a chunk hash.
  if (
    chunkIndex !== m.chunks.length ||
    (chunkBytes !== null && chunkOffset !== chunkBytes.length)
  )
    throw Error("incomplete chunks");
  return m;
}
export async function makeRunner(options) {
  const configPath = path.join(root, "worker/wrangler.jsonc"),
    config = JSON.parse(await readFile(configPath, "utf8"));
  const binding = config.env?.[options.env]?.d1_databases?.find(
    (d) => d.binding === "DB",
  );
  if (!binding) throw Error("missing explicit environment D1 binding");
  if (options.mode === "remote" && !validDatabaseId(binding.database_id))
    throw Error("remote requires configured nonzero database ID");
  const pkg = JSON.parse(
    await readFile(
      path.join(root, "worker/node_modules/wrangler/package.json"),
      "utf8",
    ),
  );
  const lock = JSON.parse(
    await readFile(path.join(root, "worker/package-lock.json"), "utf8"),
  );
  if (pkg.version !== lock.packages["node_modules/wrangler"].version)
    throw Error("installed Wrangler differs from lock");
  const tmp = path.join(root, ".tools/migration-tmp");
  await mkdir(tmp, { recursive: true });
  return async function execute({ sql, file }) {
    const args = [
      path.join(root, "worker/node_modules/wrangler/bin/wrangler.js"),
      "d1",
      "execute",
      binding.database_name,
      "--config",
      configPath,
      "--env",
      options.env,
      `--${options.mode}`,
      "--yes",
      "--json",
    ];
    if (options.mode === "local") args.push("--persist-to", options.persist);
    args.push(file ? "--file" : "--command", file ?? sql);
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: root,
        shell: false,
        env: {
          ...process.env,
          TEMP: tmp,
          TMP: tmp,
          TMPDIR: tmp,
          WRANGLER_SEND_METRICS: "false",
          WRANGLER_LOG_PATH: path.join(tmp, "wrangler.log"),
        },
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (b) => (stdout += b));
      child.stderr.on("data", (b) => (stderr += b));
      child.on("error", () => reject(Error("Wrangler failed to start")));
      child.on("close", (code) => {
        if (code !== 0)
          return reject(
            Error(
              `D1 command failed (exit ${code}); partial target remains private; retry with a NEW empty target`,
            ),
          );
        try {
          const out = JSON.parse(stdout);
          if (!Array.isArray(out) || out.some((r) => r.success === false))
            throw Error();
          resolve(out.flatMap((r) => r.results ?? []));
        } catch {
          reject(Error("invalid Wrangler JSON response"));
        }
      });
    });
  };
}
export async function checkSchema(run) {
  for (const t of schema) {
    const actual = await run({ sql: `PRAGMA table_info("${t.name}")` });
    if (actual.length !== t.columns.length)
      throw Error(`target schema mismatch: ${t.name}`);
    for (let i = 0; i < t.columns.length; i++) {
      const a = actual[i],
        c = t.columns[i],
        pk = t.primaryKey.indexOf(c.name) + 1;
      const nullablePrimary =
        (t.name === "accounts" && c.name === "id") ||
        (t.name === "invitations" && c.name === "hash") ||
        (["changes", "audit"].includes(t.name) && c.name === "seq");
      if (
        a.name !== c.name ||
        a.type.toUpperCase() !== (c.type === "text" ? "TEXT" : "INTEGER") ||
        a.pk !== pk ||
        (!nullablePrimary && Boolean(a.notnull) === c.nullable)
      )
        throw Error(`target column mismatch: ${t.name}.${c.name}`);
    }
  }
  const accountDDL = await run({
    sql: "SELECT sql FROM sqlite_schema WHERE type='table' AND name='accounts'",
  });
  if (
    !/username\s+TEXT\s+NOT NULL\s+COLLATE NOCASE\s+UNIQUE/i.test(
      accountDDL[0]?.sql ?? "",
    )
  )
    throw Error("target username must have NOCASE unique constraint");
  for (const name of ["changes", "audit"]) {
    const ddl = await run({
      sql: `SELECT sql FROM sqlite_schema WHERE type='table' AND name='${name}'`,
    });
    if (!/AUTOINCREMENT/i.test(ddl[0]?.sql ?? ""))
      throw Error("target sequence schema mismatch");
  }
  for (const name of transients)
    await run({ sql: `SELECT COUNT(*) AS n FROM "${name}"` });
}
export async function assertEmpty(
  run,
  names = [...schema.map((t) => t.name), ...transients],
) {
  // Four compound terms were exercised on the locked local D1 runtime.
  for (let i = 0; i < names.length; i += 4) {
    const rows = await run({
      sql: names
        .slice(i, i + 4)
        .map((name) => `SELECT '${name}' AS name,COUNT(*) AS n FROM "${name}"`)
        .join(" UNION ALL "),
    });
    if (rows.some((r) => r.n !== 0))
      throw Error("target business/session tables must be empty");
  }
}
export function safeFailure(error) {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
}
