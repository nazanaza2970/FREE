#!/usr/bin/env node
/**
 * free-sync-server — standalone self-hosted sync server (device registry +
 * entity store with last-write-wins merges).
 *
 *   free-sync-server [--port 3901] [--host 0.0.0.0] [--db ./data/sync.db]
 *
 * Thin wrapper that runs the TypeScript implementation through tsx so the bin
 * has no build step. Env: SYNC_DB, PORT, HOST.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'server', 'sync', 'server.ts');

const child = spawn(process.execPath, ['--import', 'tsx', target, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

child.on('error', (err) => {
  process.stderr.write(`sync-server: failed to start: ${err.message}\n`);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 1));
