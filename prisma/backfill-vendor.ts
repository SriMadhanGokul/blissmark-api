/**
 * One-off, additive backfill for the vendor-app schema: sets each new field only on
 * documents that do not have it yet. Safe to run more than once; changes nothing else.
 * Run: npx ts-node --transpile-only prisma/backfill-vendor.ts
 */
import '../src/env';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SERVICE_TO_CATEGORY: [RegExp, string][] = [
  [/^cab:/, 'driver'],
  [/^rider$/, 'rider'],
  [/^(tow|ambulance)$/, 'responder'],
];

async function setMissing(collection: string, fields: Record<string, unknown>) {
  for (const [field, value] of Object.entries(fields)) {
    const res = (await prisma.$runCommandRaw({
      update: collection,
      updates: [{ q: { [field]: { $exists: false } }, u: { $set: { [field]: value } }, multi: true }],
    })) as { nModified?: number };
    console.log(`${collection}.${field}: ${res.nModified ?? 0} updated`);
  }
}

async function main() {
  const now = { $date: new Date().toISOString() };
  await setMissing('Vendor', {
    status: 'approved',
    radiusKm: 10,
    pincodes: [],
    holiday: false,
    accepted: 0,
    declined: 0,
    cancelled: 0,
    createdAt: now,
  });
  await setMissing('Booking', { declinedBy: [] });
  await setMissing('Ride', { declinedBy: [] });
  await setMissing('FoodOrder', { declinedBy: [] });
  await setMissing('SosRequest', { declinedBy: [] });
  await setMissing('Property', { status: 'active' });
  await setMissing('MenuItem', { available: true });
  await setMissing('Product', { active: true });

  // seeded providers: derive the category from the services they offer
  const vendors = await prisma.$runCommandRaw({ find: 'Vendor', filter: { category: { $exists: false } }, projection: { services: 1 } });
  const docs = ((vendors as { cursor?: { firstBatch?: { _id: string; services?: string[] }[] } }).cursor?.firstBatch ?? []);
  for (const v of docs) {
    const s = v.services?.[0] ?? '';
    const category = SERVICE_TO_CATEGORY.find(([re]) => re.test(s))?.[1] ?? 'service';
    await prisma.$runCommandRaw({ update: 'Vendor', updates: [{ q: { _id: v._id }, u: { $set: { category } } }] });
  }
  console.log(`Vendor.category: ${docs.length} updated`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
