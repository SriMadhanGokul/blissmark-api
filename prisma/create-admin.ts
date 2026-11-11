/**
 * Creates the first admin-panel owner. Prints nothing secret: the generated password is written
 * to the file given as the first argument (keep it out of git), or use ADMIN_PASSWORD.
 * Run: npx ts-node --transpile-only prisma/create-admin.ts ../admin-panel/.owner-login.txt
 */
import '../src/env';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import { hashPassword } from '../src/modules/admin/admin.service';

const prisma = new PrismaClient();

async function main() {
  const email = (process.env.ADMIN_EMAIL ?? 'owner@blissmark.local').toLowerCase();
  const out = process.argv[2];
  if (await prisma.admin.findUnique({ where: { email } })) {
    console.log(`Admin ${email} already exists; nothing changed.`);
    return;
  }
  const password = process.env.ADMIN_PASSWORD ?? randomBytes(12).toString('base64url');
  await prisma.admin.create({ data: { email, name: 'Blissmark Owner', role: 'owner', passwordHash: hashPassword(password) } });
  if (out) writeFileSync(out, `Blissmark admin panel owner login\nEmail: ${email}\nPassword: ${password}\nChange it after the first sign-in (Settings → My account).\n`);
  console.log(`Created owner ${email}${out ? `; login written to ${out}` : ''}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
