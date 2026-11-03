import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Minimal .env loader (with ${VAR} expansion, like Prisma's) so `npm start` needs no extra packages.
try {
  for (const line of readFileSync(join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"]*)"?\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/\$\{([A-Z0-9_]+)\}/g, (_, k: string) => process.env[k] ?? '');
  }
} catch {
  // no .env: rely on the real environment
}
