import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Prisma } from '@prisma/client';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import { ROLE_PERMS } from '../../common/auth';
import { invalid, notFound, unauthorized } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CATEGORIES, DOC_LABEL, PartnerService, type Category } from '../partner/partner.service';
import { LedgerService } from '../wallet/ledger.service';
import { SettingsService } from './settings.service';

/** scrypt with a random salt, stored as salt:hash. */
export function hashPassword(pw: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`;
}
function checkPassword(pw: string, stored: string) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = scryptSync(pw, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

const startOfDay = () => {
  const ist = new Date(Date.now() + 5.5 * 3600000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 5.5 * 3600000);
};
const days = (n: number) => new Date(Date.now() - n * 86400000);
const mask = (phone?: string | null) => (phone ? `${phone.slice(0, 2)}••••${phone.slice(-4)}` : null);

/** Admin panel: identity, audit trail, dashboard, vendor verification and customer management. */
@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private settings: SettingsService,
    private notifications: NotificationsService,
    private ledger: LedgerService,
    private partner: PartnerService,
  ) {}

  /* ---------------- identity & audit ---------------- */

  async login(email: string, password: string) {
    const a = await this.prisma.admin.findUnique({ where: { email: (email ?? '').trim().toLowerCase() } });
    // same answer for unknown email and wrong password
    if (!a || !a.active || !checkPassword(password ?? '', a.passwordHash)) throw invalid('LOGIN', 'Email or password is wrong', 'password');
    await this.prisma.admin.update({ where: { id: a.id }, data: { lastLoginAt: new Date() } });
    await this.audit(a.id, 'login', `admin:${a.id}`);
    return { token: this.jwt.sign({ sub: a.id, admin: true, role: a.role }, { expiresIn: '12h' }), admin: this.adminDto(a) };
  }

  adminDto(a: { id: string; email: string; name: string; role: string; active: boolean; lastLoginAt: Date | null }) {
    return { id: a.id, email: a.email, name: a.name, role: a.role, active: a.active, lastLoginAt: a.lastLoginAt, perms: ROLE_PERMS[a.role] ?? [] };
  }

  async me(adminId: string) {
    const a = await this.prisma.admin.findUnique({ where: { id: adminId } });
    if (!a || !a.active) throw unauthorized();
    return this.adminDto(a);
  }

  async changePassword(adminId: string, current: string, next: string) {
    const a = await this.prisma.admin.findUniqueOrThrow({ where: { id: adminId } });
    if (!checkPassword(current ?? '', a.passwordHash)) throw invalid('PASSWORD', 'Current password is wrong', 'current');
    if (!next || next.length < 10) throw invalid('PASSWORD', 'Use at least 10 characters', 'next');
    await this.prisma.admin.update({ where: { id: adminId }, data: { passwordHash: hashPassword(next) } });
    await this.audit(adminId, 'password.change', `admin:${adminId}`);
    return { ok: true };
  }

  async audit(adminId: string, action: string, target: string, detail?: Prisma.InputJsonValue) {
    const a = await this.prisma.admin.findUnique({ where: { id: adminId }, select: { name: true } });
    await this.prisma.auditLog.create({ data: { adminId, adminName: a?.name ?? 'admin', action, target, detail } });
  }

  /* ---------------- executive dashboard ---------------- */

  async dashboard() {
    const today = startOfDay();
    const [users, newUsers, vendorsOnline, pendingVendors, liveBookings, liveRides, liveFood, liveSos, openOrders, pendingListings, openTickets] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { createdAt: { gte: today } } }),
      this.prisma.vendor.count({ where: { online: true, status: 'approved' } }),
      this.prisma.vendor.count({ where: { status: 'pending' } }),
      this.prisma.booking.count({ where: { status: { in: ['BROADCASTING', 'ACCEPTED', 'EN_ROUTE', 'STARTED', 'QUOTE_SENT', 'QUOTE_APPROVED', 'COMPLETED', 'INVOICED'] } } }),
      this.prisma.ride.count({ where: { status: { in: ['SEARCHING', 'ACCEPTED', 'ARRIVING', 'ON_TRIP'] } } }),
      this.prisma.foodOrder.count({ where: { status: { in: ['PLACED', 'PREPARING', 'RIDER_ASSIGNED', 'PICKED_UP'] } } }),
      this.prisma.sosRequest.findMany({ where: { status: { in: ['ALERTED', 'RESPONDER_ASSIGNED', 'EN_ROUTE', 'ARRIVED'] } }, include: { user: { select: { name: true } } }, orderBy: { createdAt: 'desc' } }),
      this.prisma.order.count({ where: { status: { in: ['PLACED', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY'] } } }),
      this.prisma.property.count({ where: { verified: false, status: { not: 'rejected' } } }),
      this.prisma.supportTicket.count({ where: { status: 'open' } }),
    ]);

    // 30-day performance per vertical: count and gross value (paise)
    const since = days(30);
    const [orders, bookings, rides, food, sos] = await Promise.all([
      this.prisma.order.findMany({ where: { placedAt: { gte: since }, status: { not: 'CANCELLED' } }, select: { total: true, placedAt: true } }),
      this.prisma.booking.findMany({ where: { createdAt: { gte: since }, status: { in: ['PAID', 'CLOSED'] } }, select: { invoice: true, createdAt: true } }),
      this.prisma.ride.findMany({ where: { createdAt: { gte: since }, status: 'PAID' }, select: { fare: true, createdAt: true } }),
      this.prisma.foodOrder.findMany({ where: { createdAt: { gte: since }, status: { not: 'CANCELLED' } }, select: { total: true, createdAt: true } }),
      this.prisma.sosRequest.findMany({ where: { createdAt: { gte: since }, status: 'PAID' }, select: { invoice: true, createdAt: true } }),
    ]);
    const rows = [
      ...orders.map((o) => ({ v: 'Shopping', amount: o.total, at: o.placedAt })),
      ...bookings.map((b) => ({ v: 'Home services', amount: (b.invoice as { total?: number } | null)?.total ?? 0, at: b.createdAt })),
      ...rides.map((r) => ({ v: 'Cabs', amount: (r.fare as { total: number }).total, at: r.createdAt })),
      ...food.map((f) => ({ v: 'Food', amount: f.total, at: f.createdAt })),
      ...sos.map((s) => ({ v: 'Emergency', amount: (s.invoice as { total?: number } | null)?.total ?? 0, at: s.createdAt })),
    ];
    const verticals = ['Shopping', 'Home services', 'Cabs', 'Food', 'Emergency'].map((v) => {
      const r = rows.filter((x) => x.v === v);
      return { vertical: v, count: r.length, gmv: r.reduce((s, x) => s + x.amount, 0) };
    });
    const daily = Array.from({ length: 14 }, (_, i) => {
      const from = new Date(startOfDay().getTime() - (13 - i) * 86400000);
      const to = new Date(from.getTime() + 86400000);
      const r = rows.filter((x) => x.at >= from && x.at < to);
      return { day: from.toISOString().slice(0, 10), gmv: r.reduce((s, x) => s + x.amount, 0), count: r.length };
    });

    // income plan liability: money already set aside for members, and this month's subscription pool
    const pools = await this.prisma.ledgerAccount.findMany({ where: { kind: { in: ['income_pool', 'subscription_pool', 'platform_commission'] } } });
    const sums = await this.prisma.ledgerEntry.groupBy({ by: ['accountId'], where: { accountId: { in: pools.map((p) => p.id) } }, _sum: { debit: true, credit: true } });
    const bal = (kind: string) => sums.filter((s) => pools.find((p) => p.id === s.accountId)?.kind === kind).reduce((t, s) => t + (s._sum.credit ?? 0) - (s._sum.debit ?? 0), 0);

    return {
      kpis: { users, newUsers, vendorsOnline, pendingVendors, liveBookings, liveRides, liveFood, liveSos: liveSos.length, openOrders, pendingListings, openTickets, gmvToday: daily[13].gmv, gmv30: rows.reduce((s, x) => s + x.amount, 0) },
      sos: liveSos.map((s) => ({ id: s.id, type: s.type, issue: s.issue, status: s.status, location: s.location, customer: s.user.name, createdAt: s.createdAt, responder: (s.responder as { name?: string } | null)?.name ?? null })),
      verticals,
      daily,
      liability: { incomePool: bal('income_pool'), subscriptionPool: bal('subscription_pool'), commission: bal('platform_commission') },
    };
  }

  /* ---------------- vendor management ---------------- */

  async vendors(q: { status?: string; category?: string; q?: string; app?: string }) {
    const where: Prisma.VendorWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.category ? { category: q.category } : {}),
      ...(q.app === '1' ? { userId: { not: null } } : {}),
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { businessName: { contains: q.q, mode: 'insensitive' } }, { phone: { contains: q.q } }, { plate: { contains: q.q, mode: 'insensitive' } }] } : {}),
    };
    const list = await this.prisma.vendor.findMany({ where, orderBy: [{ submittedAt: 'desc' }, { createdAt: 'desc' }], take: 200 });
    return list.map((v) => ({
      id: v.id,
      name: v.name,
      businessName: v.businessName,
      phone: v.phone,
      photo: v.photo,
      category: v.category,
      categoryLabel: CATEGORIES[v.category as Category]?.label ?? v.category,
      status: v.status,
      online: v.online,
      rating: v.rating,
      jobs: v.jobs,
      district: v.district,
      app: !!v.userId,
      submittedAt: v.submittedAt,
      commissionPct: v.commissionPct,
    }));
  }

  async vendor(id: string) {
    const v = await this.prisma.vendor.findUnique({ where: { id }, include: { docs: { orderBy: { createdAt: 'asc' } }, payouts: { orderBy: { createdAt: 'desc' }, take: 10 }, tickets: { orderBy: { createdAt: 'desc' }, take: 10 } } });
    if (!v) throw notFound('Vendor');
    const [balance, rate, recentBookings, recentRides] = await Promise.all([
      this.partner.balance(v),
      this.settings.commissionFor(v),
      this.prisma.booking.findMany({ where: { vendorId: v.id }, orderBy: { createdAt: 'desc' }, take: 10, include: { service: { select: { label: true } } } }),
      this.prisma.ride.findMany({ where: { driverId: v.id }, orderBy: { createdAt: 'desc' }, take: 10 }),
    ]);
    const required = CATEGORIES[v.category as Category]?.docs ?? [];
    const offered = v.accepted + v.declined;
    return {
      ...v,
      categoryLabel: CATEGORIES[v.category as Category]?.label ?? v.category,
      app: !!v.userId,
      effectiveCommission: rate,
      balance: balance.total,
      acceptance: offered ? Math.round((v.accepted / offered) * 100) : null,
      cancellation: v.accepted ? Math.round((v.cancelled / v.accepted) * 100) : null,
      docs: required.map((kind) => {
        const d = v.docs.find((x) => x.kind === kind);
        return { id: d?.id ?? null, kind, label: DOC_LABEL[kind] ?? kind, number: d?.number ?? null, image: d?.image ?? null, status: d?.status ?? 'missing', note: d?.note ?? null };
      }),
      recent: [
        ...recentBookings.map((b) => ({ kind: 'booking', id: b.id, title: `${b.service.label} · ${b.issue}`, status: b.status, at: b.createdAt, rating: b.rating })),
        ...recentRides.map((r) => ({ kind: 'ride', id: r.id, title: `${(r.pickup as { label: string }).label} → ${(r.drop as { label: string }).label}`, status: r.status, at: r.createdAt, rating: r.rating })),
      ].sort((a, b) => b.at.getTime() - a.at.getTime()),
    };
  }

  private async notifyVendor(v: { userId: string | null }, title: string, body: string) {
    if (v.userId) await this.notifications.notify(v.userId, 'partner', title, body, '/');
  }

  async reviewDoc(adminId: string, docId: string, ok: boolean, note?: string) {
    const d = await this.prisma.vendorDoc.findUnique({ where: { id: docId }, include: { vendor: true } });
    if (!d) throw notFound('Document');
    if (!ok && !note?.trim()) throw invalid('NOTE', 'Say what is wrong with the document', 'note');
    await this.prisma.vendorDoc.update({ where: { id: docId }, data: { status: ok ? 'verified' : 'rejected', note: ok ? null : note!.trim() } });
    await this.audit(adminId, ok ? 'doc.verify' : 'doc.reject', `vendor:${d.vendorId}`, { doc: d.kind, note: note ?? null });
    return this.vendor(d.vendorId);
  }

  /** Approve: every required document verified. Reject: back to draft so the partner can re-upload. */
  async decideVendor(adminId: string, id: string, decision: 'approve' | 'reject' | 'suspend' | 'reinstate', reason?: string) {
    const v = await this.prisma.vendor.findUnique({ where: { id }, include: { docs: true } });
    if (!v) throw notFound('Vendor');
    const t = await this.settings.get('templates');
    if (decision === 'approve') {
      const required = CATEGORIES[v.category as Category]?.docs ?? [];
      const missing = required.filter((k) => !v.docs.some((d) => d.kind === k && d.image));
      if (missing.length) throw invalid('DOCS', `Missing ${DOC_LABEL[missing[0]] ?? missing[0]}`);
      await this.prisma.vendorDoc.updateMany({ where: { vendorId: id, status: { not: 'rejected' } }, data: { status: 'verified' } });
      if (await this.prisma.vendorDoc.count({ where: { vendorId: id, status: 'rejected' } })) throw invalid('DOCS', 'Some documents are rejected. Ask the partner to re-upload first.');
      await this.prisma.vendor.update({ where: { id }, data: { status: 'approved', rejectReason: null } });
      await this.notifyVendor(v, 'You are approved', t.vendorApproved);
    } else {
      if (!reason?.trim()) throw invalid('REASON', 'Give a reason the partner will see', 'reason');
      if (decision === 'reject') {
        await this.prisma.vendor.update({ where: { id }, data: { status: 'draft', rejectReason: reason.trim(), online: false, submittedAt: null } });
        await this.notifyVendor(v, 'Documents need another look', t.vendorRejected.replace('{reason}', reason.trim()));
      } else if (decision === 'suspend') {
        await this.prisma.vendor.update({ where: { id }, data: { status: 'suspended', online: false, rejectReason: reason.trim() } });
        if (v.restaurantId) await this.prisma.restaurant.update({ where: { id: v.restaurantId }, data: { open: false } });
        await this.notifyVendor(v, 'Account suspended', t.vendorSuspended.replace('{reason}', reason.trim()));
      } else {
        await this.prisma.vendor.update({ where: { id }, data: { status: 'approved', rejectReason: null } });
        await this.notifyVendor(v, 'Account restored', `Your partner account is active again. ${reason.trim()}`);
      }
    }
    await this.audit(adminId, `vendor.${decision}`, `vendor:${id}`, { reason: reason ?? null });
    return this.vendor(id);
  }

  async vendorSettings(adminId: string, id: string, s: { commissionPct?: number | null; services?: string[]; warning?: string }) {
    const v = await this.prisma.vendor.findUnique({ where: { id } });
    if (!v) throw notFound('Vendor');
    const data: Prisma.VendorUpdateInput = {};
    if (s.commissionPct !== undefined) {
      if (s.commissionPct !== null && (s.commissionPct < 0 || s.commissionPct > 50)) throw invalid('COMMISSION', 'Commission must be between 0% and 50%', 'commissionPct');
      data.commissionPct = s.commissionPct;
    }
    if (s.services) data.services = s.services; // vertical assignment, incl. multi-category approval
    if (s.warning?.trim()) {
      data.warnings = [...((v.warnings as { text: string; at: string }[]) ?? []), { text: s.warning.trim(), at: new Date().toISOString() }];
      await this.notifyVendor(v, 'Warning from Blissmark', s.warning.trim());
    }
    await this.prisma.vendor.update({ where: { id }, data });
    await this.audit(adminId, 'vendor.settings', `vendor:${id}`, s as Prisma.InputJsonValue);
    return this.vendor(id);
  }

  /* ---------------- customer management ---------------- */

  async customers(q: { q?: string; blocked?: string }) {
    const where: Prisma.UserWhereInput = {
      ...(q.blocked === '1' ? { blocked: true } : {}),
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { phone: { contains: q.q } }, { member: { referralCode: { contains: q.q.toUpperCase() } } }] } : {}),
    };
    const list = await this.prisma.user.findMany({ where, include: { member: { select: { referralCode: true, active: true, _count: { select: { downline: true } } } } }, orderBy: { createdAt: 'desc' }, take: 200 });
    const vendors = await this.prisma.vendor.findMany({ where: { userId: { in: list.map((u) => u.id) } }, select: { userId: true, category: true } });
    return list.map((u) => ({
      id: u.id,
      name: u.name,
      phone: u.phone,
      city: u.city,
      kycVerified: u.kycVerified,
      blocked: u.blocked,
      createdAt: u.createdAt,
      referralCode: u.member?.referralCode ?? null,
      active: u.member?.active ?? false,
      direct: u.member?._count.downline ?? 0,
      partner: vendors.find((v) => v.userId === u.id)?.category ?? null,
    }));
  }

  async customer(id: string) {
    const u = await this.prisma.user.findUnique({ where: { id }, include: { member: { include: { sponsor: { include: { user: { select: { name: true, phone: true } } } }, downline: { include: { user: { select: { id: true, name: true, phone: true } } }, take: 50 } } }, addresses: true } });
    if (!u) throw notFound('Customer');
    const [wallet, orders, bookings, rides, food, sos, history, levels, vendor] = await Promise.all([
      this.ledger.walletBalance(id),
      this.prisma.order.findMany({ where: { userId: id }, orderBy: { placedAt: 'desc' }, take: 10 }),
      this.prisma.booking.findMany({ where: { userId: id }, include: { service: { select: { label: true } } }, orderBy: { createdAt: 'desc' }, take: 10 }),
      this.prisma.ride.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 10 }),
      this.prisma.foodOrder.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 10 }),
      this.prisma.sosRequest.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 10 }),
      this.ledger.walletHistory(id),
      u.member ? this.prisma.referralClosure.groupBy({ by: ['depth'], where: { ancestorId: u.member.id, depth: { gt: 0 } }, _count: true }) : [],
      this.prisma.vendor.findUnique({ where: { userId: id }, select: { id: true, category: true, status: true } }),
    ]);
    const activity = [
      ...orders.map((o) => ({ kind: 'order', id: o.id, title: `Shop order · ${o.sellerName}`, status: o.status, amount: o.total, at: o.placedAt })),
      ...bookings.map((b) => ({ kind: 'booking', id: b.id, title: b.service.label, status: b.status, amount: (b.invoice as { total?: number } | null)?.total ?? null, at: b.createdAt })),
      ...rides.map((r) => ({ kind: 'ride', id: r.id, title: `${r.vehicle} ride`, status: r.status, amount: (r.fare as { total: number }).total, at: r.createdAt })),
      ...food.map((f) => ({ kind: 'food', id: f.id, title: f.restaurantName, status: f.status, amount: f.total, at: f.createdAt })),
      ...sos.map((s) => ({ kind: 'sos', id: s.id, title: `${s.type} SOS · ${s.issue}`, status: s.status, amount: (s.invoice as { total?: number } | null)?.total ?? null, at: s.createdAt })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());
    return {
      id: u.id,
      name: u.name,
      phone: u.phone,
      city: u.city,
      kycVerified: u.kycVerified,
      blocked: u.blocked,
      createdAt: u.createdAt,
      addresses: u.addresses,
      wallet,
      walletHistory: history.slice(0, 20),
      member: u.member && {
        referralCode: u.member.referralCode,
        active: u.member.active,
        joinedAt: u.member.joinedAt,
        sponsor: u.member.sponsor ? { name: u.member.sponsor.user.name, phone: mask(u.member.sponsor.user.phone), code: u.member.sponsor.referralCode } : null,
        direct: u.member.downline.map((d) => ({ userId: d.user.id, name: d.user.name, phone: mask(d.user.phone), code: d.referralCode, active: d.active })),
        levels: (levels as { depth: number; _count: number }[]).sort((a, b) => a.depth - b.depth).map((l) => ({ level: l.depth, members: l._count })),
      },
      vendor,
      activity,
    };
  }

  async customerAction(adminId: string, id: string, a: { blocked?: boolean; kycVerified?: boolean }) {
    const u = await this.prisma.user.findUnique({ where: { id } });
    if (!u) throw notFound('Customer');
    await this.prisma.user.update({ where: { id }, data: { ...(a.blocked !== undefined ? { blocked: a.blocked } : {}), ...(a.kycVerified !== undefined ? { kycVerified: a.kycVerified } : {}) } });
    if (a.blocked) await this.prisma.vendor.updateMany({ where: { userId: id }, data: { online: false } });
    await this.audit(adminId, a.blocked !== undefined ? (a.blocked ? 'customer.block' : 'customer.unblock') : 'customer.kyc', `user:${id}`, a);
    return this.customer(id);
  }

  /** Manual wallet credit/debit (goodwill, corrections). Credits land in the withdrawable wallet. */
  async adjustWallet(adminId: string, id: string, amount: number, reason: string) {
    if (!Number.isInteger(amount) || amount === 0) throw invalid('AMOUNT', 'Enter an amount', 'amount');
    if (!reason?.trim()) throw invalid('REASON', 'Give a reason for the adjustment', 'reason');
    const u = await this.prisma.user.findUnique({ where: { id } });
    if (!u) throw notFound('Customer');
    if (amount < 0 && (await this.ledger.walletBalance(id)).withdrawable < -amount) throw invalid('AMOUNT', 'The wallet does not have that much withdrawable balance', 'amount');
    const key = `admin-adjust:${id}:${Date.now()}`;
    await this.prisma.$transaction((tx) =>
      this.ledger.post(tx, { type: 'adjustment', title: `Adjustment: ${reason.trim()}`, key }, [
        amount > 0 ? { kind: 'wallet_withdrawable', ownerId: id, credit: amount } : { kind: 'wallet_withdrawable', ownerId: id, debit: -amount },
        amount > 0 ? { kind: 'platform_commission', debit: amount } : { kind: 'platform_commission', credit: -amount },
      ]),
    );
    await this.notifications.notify(id, 'wallet', amount > 0 ? 'Wallet credited' : 'Wallet debited', `₹${Math.abs(amount) / 100} · ${reason.trim()}`, '/wallet');
    await this.audit(adminId, 'wallet.adjust', `user:${id}`, { amount, reason });
    return this.customer(id);
  }
}
