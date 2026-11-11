import { Injectable } from '@nestjs/common';
import type { Prisma, Vendor } from '@prisma/client';

import { PrismaService } from '../../common/prisma.service';

export const DEFAULTS = {
  /** Platform commission per vendor category, in percent. A vendor's own commissionPct overrides it. */
  commission: { service: 15, driver: 15, restaurant: 15, rider: 0, responder: 0, seller: 0, agent: 0 } as Record<string, number>,
  /** Plan A: share of monthly net profit put in the pool, % of that pool per level 1–30, and the repurchase qualification. */
  incomePlan: { poolPct: 50, levels: [10, 7, 6, 5, 4, 3, 2, 1, 1, 1, ...Array(20).fill(0.5)] as number[], threshold: 100000, subscription: 9900 },
  shopBanner: { chip: 'NEW MEMBER', title: 'Free delivery\nabove ₹499', subtitle: 'Verified sellers, tracked delivery', photo: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=900&q=70' },
  zones: [{ district: 'Jaipur', pincodes: ['302001', '302004', '302015', '302017', '302018', '302020', '302021'], live: true }] as { district: string; pincodes: string[]; live: boolean }[],
  legal: { terms: 'Terms of service for Blissmark members and partners.', privacy: 'How Blissmark collects, uses and protects your data.' },
  templates: {
    vendorApproved: 'You are approved. Go online to start receiving work.',
    vendorRejected: 'Some documents need another look: {reason}',
    vendorSuspended: 'Your partner account is suspended: {reason}',
  } as Record<string, string>,
};
export type SettingKey = keyof typeof DEFAULTS;

@Injectable()
export class SettingsService {
  constructor(private prisma: PrismaService) {}

  async get<K extends SettingKey>(key: K): Promise<(typeof DEFAULTS)[K]> {
    const row = await this.prisma.setting.findUnique({ where: { key } });
    const fallback = DEFAULTS[key];
    if (!row) return fallback;
    // merge objects so newly added defaults appear without a migration
    return (Array.isArray(fallback) ? row.value : { ...(fallback as object), ...(row.value as object) }) as (typeof DEFAULTS)[K];
  }

  async all() {
    const keys = Object.keys(DEFAULTS) as SettingKey[];
    const values = await Promise.all(keys.map((k) => this.get(k)));
    return Object.fromEntries(keys.map((k, i) => [k, values[i]]));
  }

  set(key: SettingKey, value: unknown) {
    const v = value as Prisma.InputJsonValue;
    return this.prisma.setting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } });
  }

  /** Commission percent for a vendor: its own override, else its category's rate. */
  async commissionFor(v: Pick<Vendor, 'category' | 'commissionPct'> | null | undefined) {
    if (v?.commissionPct != null) return v.commissionPct;
    const rates = await this.get('commission');
    return rates[v?.category ?? 'service'] ?? 15;
  }

  /** Commission in paise on `amount` paise. */
  async commissionOn(v: Pick<Vendor, 'category' | 'commissionPct'> | null | undefined, amount: number) {
    return Math.round((amount * (await this.commissionFor(v))) / 100);
  }
}
