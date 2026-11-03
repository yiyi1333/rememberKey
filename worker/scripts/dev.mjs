#!/usr/bin/env node
/**
 * `wrangler dev` wrapper.
 *
 * workerd creates Durable Object / email-store directories inside the OS temp
 * directory. On some Windows setups (e.g. when TEMP points at a restricted
 * location) that fails with "CreateDirectory: #5 access denied" and the dev
 * server refuses to start. Pointing TEMP/TMP at a workspace-local directory
 * fixes it. On other platforms this is a harmless no-op.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const tmp = join(root, '.tmp');
mkdirSync(tmp, { recursive: true });

const args = ['dev', ...process.argv.slice(2)];
const wranglerBin = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const useLocalWrangler = existsSync(wranglerBin);
const command = useLocalWrangler ? process.execPath : 'npx';
const commandArgs = useLocalWrangler ? [wranglerBin, ...args] : ['wrangler', ...args];

const child = spawn(command, commandArgs, {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp },
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  if (signal) process.exit(0);
  process.exit(code ?? 0);
});
