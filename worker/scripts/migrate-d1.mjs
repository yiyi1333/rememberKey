import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseArgs,
  loadSource,
  makeRunner,
  checkSchema,
  assertEmpty,
  safeFailure,
} from "./migration-common.mjs";
export async function migrate(options, runnerFactory = makeRunner) {
  const manifest = await loadSource(options.source);
  const run = await runnerFactory(options);
  await checkSchema(run);
  await assertEmpty(run);
  for (const chunk of manifest.chunks)
    await run({ file: path.join(options.source, chunk.name) });
  return {
    ok: true,
    importedTables: manifest.tables.map((t) => ({
      table: t.name,
      rows: t.rows,
    })),
    chunks: manifest.chunks.length,
    requiresFullVerification: true,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  Promise.resolve()
    .then(() => migrate(parseArgs(process.argv.slice(2))))
    .then((r) => console.log(JSON.stringify(r)))
    .catch(safeFailure);
