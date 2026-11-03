import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  parseArgs,
  loadSource,
  makeRunner,
  checkSchema,
  assertEmpty,
  transients,
  encodeRow,
  safeFailure,
} from "./migration-common.mjs";
const literal = (c, v) =>
  c.type === "integer"
    ? v
    : `CAST(X'${Buffer.from(v, "utf8").toString("hex")}' AS TEXT)`;
export async function verify(options) {
  const m = await loadSource(options.source),
    run = await makeRunner(options);
  await checkSchema(run);
  await assertEmpty(run, transients);
  const tables = [];
  for (const t of m.tables) {
    let last = null,
      count = 0;
    const hash = createHash("sha256");
    for (;;) {
      const keys = t.primaryKey.map((k) => t.columns.find((c) => c.name === k));
      const where = last
        ? " WHERE (" +
          keys.map((c) => `"${c.name}"`).join(",") +
          ") > (" +
          keys.map((c) => literal(c, last[c.name])).join(",") +
          ")"
        : "";
      const columns = t.columns
        .map((c) =>
          c.type === "integer"
            ? `CAST("${c.name}" AS TEXT) AS "${c.name}"`
            : `"${c.name}"`,
        )
        .join(",");
      const rows = await run({
        sql: `SELECT ${columns} FROM "${t.name}"${where} ORDER BY ${keys.map((c) => `"${c.name}" COLLATE BINARY`).join(",")} LIMIT 200`,
      });
      for (const row of rows) {
        hash.update(encodeRow(t, row));
        count++;
      }
      if (rows.length < 200) break;
      last = rows.at(-1);
    }
    const sum = hash.digest("hex");
    if (count !== t.rows || sum !== t.sha256)
      throw Error(`full verification mismatch: ${t.name}`);
    if (["changes", "audit"].includes(t.name)) {
      const seq = await run({
        sql: `SELECT CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name='${t.name}'`,
      });
      if (seq.length !== 1 || seq[0].seq !== t.highWater)
        throw Error("sequence high-water mismatch");
    }
    tables.push({ table: t.name, rows: count, sha256: sum });
  }
  const admins = await run({
    sql: "SELECT COUNT(*) AS n FROM accounts WHERE role='admin' AND disabled=0",
  });
  if (admins[0]?.n < 1) throw Error("no active administrator");
  return {
    ok: true,
    fullComparison: true,
    tables,
    transientTablesEmpty: true,
    activeAdministrator: true,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  Promise.resolve()
    .then(() => verify(parseArgs(process.argv.slice(2))))
    .then((r) => console.log(JSON.stringify(r)))
    .catch(safeFailure);
