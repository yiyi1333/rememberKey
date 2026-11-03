#!/usr/bin/env node
// Local Pages + Worker only. Never changes existing .dev.vars or deletes D1 state.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = {};
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (key === '--help') {
    console.log('node scripts/dev-cloudflare.mjs [--persist-to DIRECTORY] [--bootstrap-token TEST_TOKEN]');
    console.log('Build web first. Starts local API :8787 and Pages :8788; applies local D1 migrations.');
    process.exit(0);
  }
  if (!['--persist-to', '--bootstrap-token'].includes(key) || !process.argv[i + 1]) {
    throw new Error(`Unknown or missing argument: ${key}`);
  }
  options[key] = process.argv[++i];
}
if (options['--bootstrap-token'] && !options['--persist-to']) {
  throw new Error('--bootstrap-token requires an explicit --persist-to test-state directory');
}
const tmp = join(root, '.tmp');
mkdirSync(tmp, { recursive: true });
const runDirectory = mkdtempSync(join(tmp, 'cloudflare-dev-'));
const workerDirectory = join(root, 'worker');
const webDirectory = join(root, 'web');
const persistence = resolve(root, options['--persist-to'] || 'worker/.wrangler/state');
const childEnvironment = {
  ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp,
  WRANGLER_REGISTRY_PATH: join(runDirectory, 'registry'),
  WRANGLER_SEND_METRICS: 'false',
  CI: 'true',
};
const children = new Set();
let stopping = false;
let temporaryConfig;
let temporarySecrets;

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await Promise.all([...children].map(child => new Promise(done => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    child.once('exit', done);
    if (process.platform === 'win32') {
      // Only terminate trees launched by this invocation, never processes by name or port.
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore',
      });
      killer.once('error', () => { child.kill(); done(); });
      killer.once('exit', done);
    } else child.kill('SIGTERM');
  })));
  for (const file of [temporarySecrets, temporaryConfig]) {
    if (file && existsSync(file)) unlinkSync(file);
  }
  process.exitCode = code;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void stop(); });

function launch(directory, args) {
  const executable = join(directory, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (!existsSync(executable)) throw new Error(`Install dependencies in ${directory} first`);
  const child = spawn(process.execPath, [executable, ...args], {
    cwd: directory, env: childEnvironment, stdio: 'inherit', windowsHide: true,
  });
  children.add(child);
  child.once('error', error => { console.error(error.message); void stop(1); });
  return child;
}
async function assertPortAvailable(port) {
  await new Promise((accept, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`Port ${port} is already in use; no process was stopped`)));
    server.listen(port, '127.0.0.1', () => server.close(accept));
  });
}
async function waitForHttp(url, child) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && !stopping) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Local process exited before ${url} became ready`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      await response.arrayBuffer();
      if (response.ok) return;
    } catch { /* startup is asynchronous */ }
    await new Promise(done => setTimeout(done, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

try {
  await Promise.all([assertPortAvailable(8787), assertPortAvailable(8788)]);
  if (!existsSync(join(webDirectory, 'dist', 'index.html'))) throw new Error('Run npm --prefix web run build first');
  let config = join(workerDirectory, 'wrangler.jsonc');
  if (options['--bootstrap-token']) {
    // Config is strict JSON today; fail clearly if comments are introduced, never rewrite the source.
    const local = JSON.parse(readFileSync(config, 'utf8'));
    local.main = resolve(workerDirectory, local.main);
    local.d1_databases = local.d1_databases.map(binding => ({
      ...binding, migrations_dir: resolve(workerDirectory, binding.migrations_dir),
    }));
    delete local.$schema;
    delete local.env;
    temporaryConfig = join(runDirectory, 'wrangler.json');
    temporarySecrets = join(runDirectory, '.dev.vars');
    writeFileSync(temporaryConfig, JSON.stringify(local, null, 2), { flag: 'wx' });
    writeFileSync(temporarySecrets, `RK_BOOTSTRAP_TOKEN=${JSON.stringify(options['--bootstrap-token'])}\n`, { flag: 'wx', mode: 0o600 });
    config = temporaryConfig;
  }
  const migrate = launch(workerDirectory, ['d1', 'migrations', 'apply', 'rememberkey', '--local', '--env=', '--config', config, '--persist-to', persistence]);
  const migrationCode = await new Promise(done => migrate.once('exit', done));
  children.delete(migrate);
  if (migrationCode !== 0) throw new Error('Local D1 migrations failed');
  const api = launch(workerDirectory, ['dev', '--local', '--env=', '--config', config, '--ip', '127.0.0.1', '--port', '8787', '--inspector-port', '9229', '--persist-to', persistence, '--show-interactive-dev-session=false']);
  api.once('exit', code => { if (!stopping) void stop(code || 1); });
  await waitForHttp('http://127.0.0.1:8787/healthz', api);
  const pages = launch(webDirectory, ['pages', 'dev', 'dist', '--ip', '127.0.0.1', '--port', '8788', '--inspector-port', '9230', '--service', 'API=rememberkey-api', '--persist-to', join(persistence, 'pages'), '--show-interactive-dev-session=false']);
  pages.once('exit', code => { if (!stopping) void stop(code || 1); });
  await waitForHttp('http://127.0.0.1:8788/readyz', pages);
  console.log('Local Pages → API ready at http://127.0.0.1:8788 (API :8787). Ctrl+C stops only this run.');
} catch (error) {
  console.error(error.message);
  await stop(1);
}
