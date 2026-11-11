import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { invalid, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { code } from '../../common/util';
import { FoodService } from '../food/food.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ShopService } from '../shop/shop.service';
import { AdminService, hashPassword } from './admin.service';
import { DEFAULTS, SettingsService, type SettingKey } from './settings.service';

export type QueueKind = 'order' | 'booking' | 'ride' | 'food' | 'sos';
const DONE = ['DELIVERED', 'PAID', 'CLOSED', 'CANCELLED', 'CONFIRMED'];
const JAIPUR = { lat: 26.9124, lng: 75.7873 };
const ROLES = ['owner', 'ops', 'support', 'finance'];

/** Deterministic spot near Jaipur for partners without live GPS (until the vendor app reports location). */
function approxSpot(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { lat: JAIPUR.lat + (((h % 1000) / 1000) - 0.5) * 0.12, lng: JAIPUR.lng + ((((h >> 10) % 1000) / 1000) - 0.5) * 0.14 };
}
const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

@Injectable()
export class AdminOpsService {
  constructor(
    private prisma: PrismaService,
    private admin: AdminService,
    private settings: SettingsService,
    private notifications: NotificationsService,
    private food: FoodService,
    private shop: ShopService,
  ) {}

  /* ---------------- orders & bookings: one queue across verticals ---------------- */

  async queue(q: { kind?: string; scope?: string; q?: string }) {
    const live = q.scope !== 'all';
    const st = live ? { notIn: DONE } : undefined;
    const term = q.q?.trim();
    const want = (k: QueueKind) => !q.kind || q.kind === k;
    const take = 100;
    const [orders, bookings, rides, food, sos] = await Promise.all([
      want('order') ? this.prisma.order.findMany({ where: { ...(st ? { status: st } : {}), ...(term ? { id: { contains: term.toUpperCase() } } : {}) }, include: { user: { select: { name: true } } }, orderBy: { placedAt: 'desc' }, take }) : [],
      want('booking') ? this.prisma.booking.findMany({ where: { ...(st ? { status: st } : {}), ...(term ? { id: { contains: term.toUpperCase() } } : {}) }, include: { user: { select: { name: true } }, service: { select: { label: true } }, vendor: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take }) : [],
      want('ride') ? this.prisma.ride.findMany({ where: { ...(st ? { status: st } : {}), ...(term ? { id: { contains: term.toUpperCase() } } : {}) }, include: { user: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take }) : [],
      want('food') ? this.prisma.foodOrder.findMany({ where: { ...(st ? { status: st } : {}), ...(term ? { id: { contains: term.toUpperCase() } } : {}) }, include: { user: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take }) : [],
      want('sos') ? this.prisma.sosRequest.findMany({ where: { ...(st ? { status: st } : {}), ...(term ? { id: { contains: term.toUpperCase() } } : {}) }, include: { user: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take }) : [],
    ]);
    return [
      ...orders.map((o) => ({ kind: 'order' as const, id: o.id, title: `${(o.items as unknown[]).length} item(s) · ${o.sellerName}`, customer: o.user.name, partner: o.sellerName, status: o.status, amount: o.total, at: o.placedAt })),
      ...bookings.map((b) => ({ kind: 'booking' as const, id: b.id, title: `${b.service.label} · ${b.issue}`, customer: b.user.name, partner: b.vendor?.name ?? null, status: b.status, amount: (b.invoice as { total?: number } | null)?.total ?? null, at: b.createdAt })),
      ...rides.map((r) => ({ kind: 'ride' as const, id: r.id, title: `${(r.pickup as { label: string }).label} → ${(r.drop as { label: string }).label}`, customer: r.user.name, partner: (r.driver as { name?: string } | null)?.name ?? null, status: r.status, amount: (r.fare as { total: number }).total, at: r.createdAt })),
      ...food.map((f) => ({ kind: 'food' as const, id: f.id, title: f.restaurantName, customer: f.user.name, partner: (f.rider as { name?: string } | null)?.name ?? null, status: f.status, amount: f.total, at: f.createdAt })),
      ...sos.map((s) => ({ kind: 'sos' as const, id: s.id, title: `${s.type === 'health' ? 'Health' : 'Highway'} SOS · ${s.issue}`, customer: s.user.name, partner: (s.responder as { name?: string } | null)?.name ?? null, status: s.status, amount: (s.invoice as { total?: number } | null)?.total ?? null, at: s.createdAt })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());
  }

  async queueItem(kind: QueueKind, id: string) {
    const include = { user: { select: { id: true, name: true, phone: true } } };
    const doc =
      kind === 'order' ? await this.prisma.order.findUnique({ where: { id }, include: { ...include, events: { orderBy: { at: 'asc' } } } })
      : kind === 'booking' ? await this.prisma.booking.findUnique({ where: { id }, include: { ...include, service: true, vendor: true, events: { orderBy: { at: 'asc' } } } })
      : kind === 'ride' ? await this.prisma.ride.findUnique({ where: { id }, include })
      : kind === 'food' ? await this.prisma.foodOrder.findUnique({ where: { id }, include })
      : await this.prisma.sosRequest.findUnique({ where: { id }, include });
    if (!doc) throw notFound('Order');
    const candidates = kind === 'booking' ? await this.prisma.vendor.findMany({ where: { services: { has: (doc as { serviceCode: string }).serviceCode }, status: 'approved' }, select: { id: true, name: true, online: true, rating: true, userId: true }, orderBy: { rating: 'desc' } }) : [];
    return { kind, doc, candidates: candidates.map((c) => ({ ...c, app: !!c.userId })) };
  }

  /** Cancel with refund to the customer's wallet where money was taken. */
  async cancel(adminId: string, kind: QueueKind, id: string, reason: string) {
    if (!reason?.trim()) throw invalid('REASON', 'Give a reason the customer will see', 'reason');
    const note = `Cancelled by Blissmark: ${reason.trim()}`;
    if (kind === 'order') {
      const o = await this.prisma.order.findUnique({ where: { id } });
      if (!o || DONE.includes(o.status)) throw invalid('STATE', 'This order is already finished');
      await this.shop.cancelAndRefund(o, note);
    } else if (kind === 'food') {
      const o = await this.prisma.foodOrder.findUnique({ where: { id } });
      if (!o || DONE.includes(o.status)) throw invalid('STATE', 'This order is already finished');
      await this.food.refund(o, note);
    } else if (kind === 'booking') {
      const b = await this.prisma.booking.findUnique({ where: { id } });
      if (!b || DONE.includes(b.status)) throw invalid('STATE', 'This booking is already finished');
      await this.prisma.booking.update({ where: { id }, data: { status: 'CANCELLED', events: { create: { status: 'CANCELLED' } } } });
      await this.notifications.notify(b.userId, 'booking', 'Booking cancelled', note, `/booking/${id}`);
    } else if (kind === 'ride') {
      const r = await this.prisma.ride.findUnique({ where: { id } });
      if (!r || DONE.includes(r.status)) throw invalid('STATE', 'This ride is already finished');
      await this.prisma.ride.update({ where: { id }, data: { status: 'CANCELLED', events: [...((r.events as unknown[]) ?? []), { status: 'CANCELLED', at: new Date() }] as Prisma.InputJsonValue } });
      await this.notifications.notify(r.userId, 'ride', 'Ride cancelled', note, `/ride/${id}`);
    } else {
      const s = await this.prisma.sosRequest.findUnique({ where: { id } });
      if (!s || ['PAID', 'CANCELLED'].includes(s.status)) throw invalid('STATE', 'This SOS is already closed');
      await this.prisma.sosRequest.update({ where: { id }, data: { status: 'CANCELLED', events: [...((s.events as unknown[]) ?? []), { status: 'CANCELLED', at: new Date() }] as Prisma.InputJsonValue } });
      await this.notifications.notify(s.userId, 'sos', 'SOS closed', note, `/sos/${id}`);
    }
    await this.admin.audit(adminId, `${kind}.cancel`, `${kind}:${id}`, { reason });
    return this.queueItem(kind, id);
  }

  /** Manual lead assignment / re-assignment of a service booking to a specific pro. */
  async reassign(adminId: string, id: string, vendorId: string) {
    const b = await this.prisma.booking.findUnique({ where: { id }, include: { service: true } });
    if (!b || !['BROADCASTING', 'ACCEPTED', 'EN_ROUTE'].includes(b.status)) throw invalid('STATE', 'Only bookings that have not started can be reassigned');
    const v = await this.prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!v || v.status !== 'approved' || !v.services.includes(b.serviceCode)) throw invalid('VENDOR', 'Pick an approved pro who offers this service', 'vendorId');
    await this.prisma.booking.update({ where: { id }, data: { vendorId, status: 'ACCEPTED', events: { create: { status: 'ACCEPTED' } } } });
    await this.notifications.notify(b.userId, 'booking', `${v.name.split(' ')[0]} will handle your request`, `${b.service.label} · #${id}`, `/booking/${id}`);
    if (v.userId) await this.notifications.notify(v.userId, 'partner', 'Job assigned to you', `${b.service.label} · ${b.issue} · #${id}`, `/job/booking/${id}`);
    await this.admin.audit(adminId, 'booking.reassign', `booking:${id}`, { vendorId, from: b.vendorId });
    return this.queueItem('booking', id);
  }

  /* ---------------- live dispatch map ---------------- */

  async dispatch() {
    const [vendors, rides, sos] = await Promise.all([
      this.prisma.vendor.findMany({ where: { online: true, status: 'approved', category: { in: ['driver', 'rider', 'responder', 'service'] } }, select: { id: true, name: true, category: true, vehicle: true, plate: true, services: true, userId: true } }),
      this.prisma.ride.findMany({ where: { status: { in: ['SEARCHING', 'ACCEPTED', 'ARRIVING', 'ON_TRIP'] } }, select: { id: true, status: true, pickup: true, drop: true, driverId: true, vehicle: true } }),
      this.prisma.sosRequest.findMany({ where: { status: { in: ['ALERTED', 'RESPONDER_ASSIGNED', 'EN_ROUTE', 'ARRIVED'] } }, select: { id: true, status: true, type: true, issue: true, location: true, responderId: true } }),
    ]);
    return {
      center: JAIPUR,
      vendors: vendors.map((v) => ({ ...v, app: !!v.userId, ...approxSpot(v.id), approximate: true })),
      rides: rides.map((r) => ({ id: r.id, status: r.status, vehicle: r.vehicle, driverId: r.driverId, pickup: r.pickup, drop: r.drop })),
      sos: sos.map((s) => ({ id: s.id, status: s.status, type: s.type, issue: s.issue, responderId: s.responderId, ...((s.location as { lat?: number; lng?: number }) ?? {}) })),
    };
  }

  /* ---------------- income plan ---------------- */

  async income() {
    const plan = await this.settings.get('incomePlan');
    const [members, active, subs, statements] = await Promise.all([
      this.prisma.member.count(),
      this.prisma.member.count({ where: { active: true } }),
      this.prisma.subscription.groupBy({ by: ['status'], _count: true, _sum: { amount: true } }),
      this.prisma.incomeStatement.groupBy({ by: ['month'], _count: true, _sum: { total: true }, orderBy: { month: 'desc' }, take: 12 }),
    ]);
    const qualified = await this.prisma.incomeStatement.groupBy({ by: ['month'], where: { qualified: true }, _count: true });
    return {
      plan,
      members,
      active,
      subscriptions: subs.map((s) => ({ status: s.status, count: s._count, amount: s._sum.amount ?? 0 })),
      runs: statements.map((s) => ({ month: s.month, statements: s._count, total: s._sum.total ?? 0, qualified: qualified.find((q) => q.month === s.month)?._count ?? 0 })),
    };
  }

  /** Preview of one month's Plan A distribution: pool and per-level allocation. */
  async incomePreview(netProfit: number) {
    if (!Number.isInteger(netProfit) || netProfit <= 0) throw invalid('PROFIT', 'Enter the audited net profit', 'netProfit');
    const plan = await this.settings.get('incomePlan');
    const pool = Math.round((netProfit * plan.poolPct) / 100);
    const depthCounts = await this.prisma.referralClosure.groupBy({ by: ['depth'], where: { depth: { gt: 0, lte: 30 } }, _count: true });
    const levels = plan.levels.map((pct, i) => ({ level: i + 1, pct, amount: Math.round((pool * pct) / 100), links: depthCounts.find((d) => d.depth === i + 1)?._count ?? 0 }));
    const allocated = levels.reduce((s, l) => s + l.amount, 0);
    return { netProfit, poolPct: plan.poolPct, pool, allocated, unallocated: pool - allocated, levels, note: 'How each level’s share is split between qualified members is pending Blissmark’s confirmation, so release stays disabled.' };
  }

  /* ---------------- finance & settlements ---------------- */

  async finance() {
    const accounts = await this.prisma.ledgerAccount.findMany({ where: { kind: { in: ['vendor_earnings', 'platform_commission', 'bank_payouts', 'gateway_clearing', 'wallet_withdrawable', 'wallet_locked'] } } });
    const sums = await this.prisma.ledgerEntry.groupBy({ by: ['accountId'], where: { accountId: { in: accounts.map((a) => a.id) } }, _sum: { debit: true, credit: true } });
    const byKind: Record<string, number> = {};
    const vendorBal = new Map<string, number>();
    for (const s of sums) {
      const a = accounts.find((x) => x.id === s.accountId)!;
      const bal = (s._sum.credit ?? 0) - (s._sum.debit ?? 0);
      byKind[a.kind] = (byKind[a.kind] ?? 0) + bal;
      if (a.kind === 'vendor_earnings' && a.ownerId) vendorBal.set(a.ownerId, (vendorBal.get(a.ownerId) ?? 0) + bal);
    }
    const ids = [...vendorBal.keys()].filter((k) => !k.includes(':'));
    const named = await this.prisma.vendor.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, businessName: true, category: true, bank: true } });
    const settlements = [...vendorBal.entries()]
      .filter(([, b]) => b !== 0)
      .map(([owner, balance]) => {
        const v = named.find((n) => n.id === owner);
        return { owner, name: v ? v.businessName ?? v.name : owner.replace(/^\w+:/, ''), category: v?.category ?? owner.split(':')[0], app: !!v, bank: (v?.bank as { last4: string } | null)?.last4 ?? null, balance };
      })
      .sort((a, b) => b.balance - a.balance);
    const [payouts, withdrawals] = await Promise.all([
      this.prisma.vendorPayout.findMany({ include: { vendor: { select: { name: true, businessName: true, bank: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      this.prisma.withdrawal.findMany({ include: { user: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
    ]);
    return {
      totals: { commission: byKind.platform_commission ?? 0, vendorOwed: byKind.vendor_earnings ?? 0, memberWallets: (byKind.wallet_withdrawable ?? 0) + (byKind.wallet_locked ?? 0), paidOut: byKind.bank_payouts ?? 0 },
      settlements,
      payouts: payouts.map((p) => ({ id: p.id, who: p.vendor.businessName ?? p.vendor.name, type: 'partner', amount: p.amount, bankLast4: p.bankLast4, ifsc: (p.vendor.bank as { ifsc?: string } | null)?.ifsc ?? null, status: p.status, at: p.createdAt })),
      withdrawals: withdrawals.map((w) => ({ id: w.id, who: w.user.name, type: 'member', amount: w.net, tds: w.tds, bankLast4: w.bankLast4, ifsc: null, status: w.status, at: w.createdAt })),
    };
  }

  async markPaid(adminId: string, type: 'partner' | 'member', id: string) {
    if (type === 'partner') await this.prisma.vendorPayout.update({ where: { id }, data: { status: 'paid' } });
    else await this.prisma.withdrawal.update({ where: { id }, data: { status: 'paid' } });
    await this.admin.audit(adminId, 'payout.paid', `${type}-payout:${id}`);
    return this.finance();
  }

  /** NEFT / Razorpay Payouts batch file for everything still processing. */
  async payoutCsv(adminId: string) {
    const f = await this.finance();
    const rows = [...f.payouts, ...f.withdrawals].filter((p) => p.status === 'processing');
    const head = ['reference', 'payee', 'type', 'amount_inr', 'account_last4', 'ifsc', 'requested_at'];
    const lines = rows.map((p) => [p.id, p.who, p.type, (p.amount / 100).toFixed(2), p.bankLast4, p.ifsc ?? '', p.at.toISOString()].map(csvCell).join(','));
    await this.admin.audit(adminId, 'payout.export', 'payouts', { rows: rows.length });
    return [head.join(','), ...lines].join('\n');
  }

  async journals(limit = 100) {
    const j = await this.prisma.ledgerJournal.findMany({ include: { entries: { include: { account: true } } }, orderBy: { createdAt: 'desc' }, take: limit });
    return j.map((x) => ({ id: x.id, type: x.type, title: x.title, ref: x.ref, at: x.createdAt, lines: x.entries.map((e) => ({ account: e.account.kind, owner: e.account.ownerId, debit: e.debit, credit: e.credit })) }));
  }

  /* ---------------- property moderation ---------------- */

  async listings(scope: string) {
    const where: Prisma.PropertyWhereInput = scope === 'pending' ? { verified: false, status: { not: 'rejected' } } : scope === 'featured' ? { featured: true } : {};
    const list = await this.prisma.property.findMany({ where, include: { _count: { select: { enquiries: true, shortlists: true } } }, orderBy: { listedAt: 'desc' }, take: 200 });
    const agents = await this.prisma.vendor.findMany({ where: { id: { in: list.map((p) => p.agentId).filter(Boolean) as string[] } }, include: { docs: { where: { kind: 'rera' } } } });
    return list.map(({ _count, ...p }) => {
      const a = agents.find((x) => x.id === p.agentId);
      return { ...p, enquiries: _count.enquiries, shortlists: _count.shortlists, agent: a ? { id: a.id, name: a.businessName ?? a.name, status: a.status, rera: a.docs[0] ? { number: a.docs[0].number, status: a.docs[0].status } : null } : null };
    });
  }

  async moderate(adminId: string, id: string, m: { verified?: boolean; featured?: boolean; status?: string; reason?: string }) {
    const p = await this.prisma.property.findUnique({ where: { id } });
    if (!p) throw notFound('Listing');
    if (m.status && !['active', 'paused', 'sold', 'rejected'].includes(m.status)) throw invalid('STATUS', 'Unknown status', 'status');
    await this.prisma.property.update({ where: { id }, data: { ...(m.verified !== undefined ? { verified: m.verified } : {}), ...(m.featured !== undefined ? { featured: m.featured } : {}), ...(m.status ? { status: m.status } : {}) } });
    if (p.agentId && (m.verified || m.status === 'rejected')) {
      const a = await this.prisma.vendor.findUnique({ where: { id: p.agentId } });
      if (a?.userId) await this.notifications.notify(a.userId, 'partner', m.verified ? 'Listing verified' : 'Listing rejected', m.verified ? `${p.title} now shows a Verified badge.` : `${p.title}: ${m.reason ?? 'does not meet listing rules'}`, '/jobs');
    }
    await this.admin.audit(adminId, 'listing.moderate', `property:${id}`, m as Prisma.InputJsonValue);
    return this.listings('all');
  }

  async enquiries() {
    return this.prisma.enquiry.findMany({ include: { property: { select: { title: true, agentName: true } }, user: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  /* ---------------- catalog & content ---------------- */

  async catalog() {
    const [categories, services, coupons, products] = await Promise.all([
      this.prisma.category.findMany({ orderBy: { sort: 'asc' }, include: { _count: { select: { products: true } } } }),
      this.prisma.service.findMany({ orderBy: { sort: 'asc' } }),
      this.prisma.coupon.findMany(),
      this.prisma.product.findMany({ include: { seller: { select: { name: true } }, category: { select: { name: true } } }, orderBy: { title: 'asc' }, take: 300 }),
    ]);
    return { categories: categories.map(({ _count, ...c }) => ({ ...c, products: _count.products })), services, coupons, products, banner: await this.settings.get('shopBanner'), legal: await this.settings.get('legal') };
  }

  async saveCategory(adminId: string, c: { id?: string; name: string; photo: string; sort?: number }) {
    if (!c.name?.trim() || !/^https:\/\//.test(c.photo ?? '')) throw invalid('CATEGORY', 'Enter a name and an https photo link');
    const id = c.id ?? c.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
    await this.prisma.category.upsert({ where: { id }, create: { id, name: c.name.trim(), photo: c.photo, sort: c.sort ?? 99 }, update: { name: c.name.trim(), photo: c.photo, ...(c.sort !== undefined ? { sort: c.sort } : {}) } });
    await this.admin.audit(adminId, 'category.save', `category:${id}`, c);
    return this.catalog();
  }

  async saveService(adminId: string, code_: string, s: { visitCharge?: number; live?: boolean; requiresQuote?: boolean; issues?: string[] }) {
    const svc = await this.prisma.service.findUnique({ where: { code: code_ } });
    if (!svc) throw notFound('Service');
    if (s.visitCharge !== undefined && (!Number.isInteger(s.visitCharge) || s.visitCharge < 0)) throw invalid('PRICE', 'Enter a valid visit charge', 'visitCharge');
    await this.prisma.service.update({ where: { code: code_ }, data: { ...(s.visitCharge !== undefined ? { visitCharge: s.visitCharge } : {}), ...(s.live !== undefined ? { live: s.live } : {}), ...(s.requiresQuote !== undefined ? { requiresQuote: s.requiresQuote } : {}), ...(s.issues ? { issues: s.issues.map((i) => i.trim()).filter(Boolean) } : {}) } });
    await this.admin.audit(adminId, 'service.save', `service:${code_}`, s as Prisma.InputJsonValue);
    return this.catalog();
  }

  async saveCoupon(adminId: string, c: { code: string; description: string; percent: number; maxDiscount: number; minOrder: number; active: boolean }) {
    const id = (c.code ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{3,16}$/.test(id)) throw invalid('CODE', 'Use 3–16 letters or digits', 'code');
    if (!Number.isInteger(c.percent) || c.percent < 1 || c.percent > 90) throw invalid('PERCENT', 'Discount must be 1–90%', 'percent');
    const data = { description: c.description?.trim() || `${c.percent}% off`, percent: c.percent, maxDiscount: c.maxDiscount, minOrder: c.minOrder ?? 0, active: c.active ?? true };
    await this.prisma.coupon.upsert({ where: { code: id }, create: { code: id, ...data }, update: data });
    await this.admin.audit(adminId, 'coupon.save', `coupon:${id}`, c);
    return this.catalog();
  }

  async productActive(adminId: string, id: string, active: boolean) {
    await this.prisma.product.update({ where: { id }, data: { active } });
    await this.admin.audit(adminId, active ? 'product.show' : 'product.hide', `product:${id}`);
    return this.catalog();
  }

  /* ---------------- settings, staff, audit ---------------- */

  settingsAll() {
    return this.settings.all();
  }

  async saveSetting(adminId: string, key: string, value: unknown) {
    if (!(key in DEFAULTS)) throw invalid('KEY', 'Unknown setting', 'key');
    if (key === 'commission') {
      const bad = Object.values(value as Record<string, number>).some((n) => typeof n !== 'number' || n < 0 || n > 50);
      if (bad) throw invalid('COMMISSION', 'Each rate must be 0–50%', 'value');
    }
    if (key === 'incomePlan') {
      const p = value as { poolPct: number; levels: number[] };
      if (!Array.isArray(p.levels) || p.levels.length !== 30 || p.levels.some((n) => typeof n !== 'number' || n < 0)) throw invalid('LEVELS', 'Give 30 level percentages', 'value');
      if (p.levels.reduce((s, n) => s + n, 0) > 100) throw invalid('LEVELS', 'Level percentages add up to more than 100%', 'value');
      if (p.poolPct < 0 || p.poolPct > 100) throw invalid('POOL', 'Pool must be 0–100% of net profit', 'value');
    }
    await this.settings.set(key as SettingKey, value);
    await this.admin.audit(adminId, 'setting.save', `setting:${key}`, value as Prisma.InputJsonValue);
    return this.settings.all();
  }

  async staff() {
    const list = await this.prisma.admin.findMany({ orderBy: { createdAt: 'asc' } });
    return list.map((a) => this.admin.adminDto(a));
  }

  /** Creates a staff account with a one-time password the owner hands over. */
  async addStaff(adminId: string, s: { email: string; name: string; role: string }) {
    const email = (s.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw invalid('EMAIL', 'Enter a valid email', 'email');
    if (!s.name?.trim()) throw invalid('NAME', 'Enter a name', 'name');
    if (!ROLES.includes(s.role)) throw invalid('ROLE', 'Choose a role', 'role');
    if (await this.prisma.admin.findUnique({ where: { email } })) throw invalid('EMAIL', 'That email already has an account', 'email');
    const temp = `${code(4)}-${code(4)}-${code(4)}`;
    await this.prisma.admin.create({ data: { email, name: s.name.trim(), role: s.role, passwordHash: hashPassword(temp) } });
    await this.admin.audit(adminId, 'staff.add', `admin:${email}`, { role: s.role });
    return { staff: await this.staff(), tempPassword: temp };
  }

  async editStaff(adminId: string, id: string, s: { role?: string; active?: boolean }) {
    if (id === adminId && (s.active === false || (s.role && s.role !== 'owner'))) throw invalid('SELF', 'You cannot remove your own owner access');
    if (s.role && !ROLES.includes(s.role)) throw invalid('ROLE', 'Choose a role', 'role');
    await this.prisma.admin.update({ where: { id }, data: { ...(s.role ? { role: s.role } : {}), ...(s.active !== undefined ? { active: s.active } : {}) } });
    await this.admin.audit(adminId, 'staff.edit', `admin:${id}`, s);
    return this.staff();
  }

  auditLog(q: { action?: string }) {
    return this.prisma.auditLog.findMany({ where: q.action ? { action: { startsWith: q.action } } : {}, orderBy: { createdAt: 'desc' }, take: 200 });
  }

  /* ---------------- support tickets ---------------- */

  tickets() {
    return this.prisma.supportTicket.findMany({ include: { vendor: { select: { name: true, businessName: true, category: true, userId: true } } }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  async replyTicket(adminId: string, id: string, reply: string, close: boolean) {
    if (!reply?.trim()) throw invalid('REPLY', 'Write a reply', 'reply');
    const t = await this.prisma.supportTicket.update({ where: { id }, data: { reply: reply.trim(), repliedAt: new Date(), status: close ? 'closed' : 'open' }, include: { vendor: true } });
    if (t.vendor.userId) await this.notifications.notify(t.vendor.userId, 'partner', 'Support replied', reply.trim().slice(0, 120), '/support');
    await this.admin.audit(adminId, 'ticket.reply', `ticket:${id}`, { close });
    return this.tickets();
  }
}
