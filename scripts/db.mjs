// Starts/stops the project's private PostgreSQL instance (backend/.pgdata, port 5433, trust auth on localhost).
// First run initialises it. Uses the PostgreSQL 18 binaries installed on this machine (override with PG_BIN).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = process.env.PG_BIN ?? 'C:/Program Files/PostgreSQL/18/bin';
const data = join(root, '.pgdata');
const run = (exe, args) => execFileSync(join(bin, exe), args, { stdio: 'inherit' });

const cmd = process.argv[2];
if (cmd === 'start') {
  if (!existsSync(data)) {
    run('initdb.exe', ['-D', data, '-U', 'blissmark', '--auth=trust', '--encoding=UTF8', '--locale=C']);
    run('pg_ctl.exe', ['-D', data, '-o', '-p 5433', '-l', join(data, 'server.log'), '-w', 'start']);
    run('createdb.exe', ['-h', 'localhost', '-p', '5433', '-U', 'blissmark', 'blissmark']);
  } else {
    run('pg_ctl.exe', ['-D', data, '-o', '-p 5433', '-l', join(data, 'server.log'), '-w', 'start']);
  }
} else if (cmd === 'stop') {
  run('pg_ctl.exe', ['-D', data, '-w', 'stop']);
} else {
  console.log('usage: node scripts/db.mjs start|stop');
}
