import { Injectable } from '@nestjs/common';
import type { Prisma, Vendor } from '@prisma/client';

import { AppError, invalid } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { code } from '../../common/util';
import { NotificationsService } from '../notifications/notifications.service';
import { LedgerService } from '../wallet/ledger.service';

export type Category = 'service' | 'driver' | 'rider' | 'responder' | 'restaurant' | 'seller' | 'agent';

/** Vendor types from the proposal (section 04) and the KYC documents each one must upload. */
export const CATEGORIES: Record<Category, { label: string; docs: string[] }> = {
  service: { label: 'Home service pro', docs: ['id_proof', 'address_proof', 'skill_certificate'] },
  driver: { label: 'Cab driver', docs: ['id_proof', 'driving_licence', 'vehicle_rc', 'vehicle_insurance'] },
  rider: { label: 'Delivery partner', docs: ['id_proof', 'driving_licence', 'vehicle_rc'] },
  responder: { label: 'Emergency responder', docs: ['id_proof', 'driving_licence', 'vehicle_rc', 'operator_licence'] },
  restaurant: { label: 'Restaurant / cloud kitchen', docs: ['id_proof', 'fssai', 'gst'] },
  seller: { label: 'Product seller', docs: ['id_proof', 'gst', 'bank_proof'] },
  agent: { label: 'Property agent / builder', docs: ['id_proof', 'rera'] },
};

export const DOC_LABEL: Record<string, string> = {
  id_proof: 'Aadhaar or PAN card',
  address_proof: 'Address proof',
  skill_certificate: 'Skill or trade certificate',
  driving_licence: 'Driving licence',
  vehicle_rc: 'Vehicle RC',
  vehicle_insurance: 'Vehicle insurance',
  operator_licence: 'Operator / ambulance licence',
  fssai: 'FSSAI food licence',
  gst: 'GST certificate',
  bank_proof: 'Cancelled cheque',
  rera: 'RERA registration',
};

export const CAB_TYPES = ['bike', 'auto', 'mini', 'sedan'] as const;
const APPROVE_AFTER_MS = 20000; // simulated admin review time until the admin panel ships
const MIN_PAYOUT = 10000;
const AVATAR = 'https://images.unsplash.com/photo-1607990281513-2c110a25bd8c?w=300&q=70';

export type ProfileInput = {
  category: Category;
  name: string;
  businessName?: string;
  district?: string;
  services?: string[];
  cabType?: (typeof CAB_TYPES)[number];
  responderType?: 'tow' | 'ambulance';
  vehicle?: string;
  plate?: string;
  restaurant?: { kind: 'restaurant' | 'kitchen'; cuisine: string; locality: string; costForTwo: number; pureVeg?: boolean };
};

const startOfDay = (d = new Date()) => {
  const ist = new Date(d.getTime() + 5.5 * 3600000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 5.5 * 3600000);
};

@Injectable()
export class PartnerService {
  constructor(
    private prisma: PrismaService,
    private ledger: LedgerService,
    private notifications: NotificationsService,
  ) {}

  /* ---------------- identity ---------------- */

  /** The caller's vendor profile. Throws NOT_PARTNER so the app can start onboarding. */
  async vendor(userId: string) {
    const v = await this.prisma.vendor.findUnique({ where: { userId } });
    if (!v) throw new AppError(404, 'NOT_PARTNER', 'No vendor profile yet');
    return this.review(v);
  }

  async approved(userId: string) {
    const v = await this.vendor(userId);
    if (v.status !== 'approved') throw invalid('NOT_APPROVED', v.status === 'suspended' ? 'Your account is suspended. Contact support.' : 'Your account is still being verified');
    return v;
  }

  /** Simulated admin review: approves a submitted profile once its review time has passed. */
  private async review(v: Vendor) {
    if (v.status !== 'pending' || !v.submittedAt || Date.now() - v.submittedAt.getTime() < APPROVE_AFTER_MS) return v;
    const { count } = await this.prisma.vendor.updateMany({ where: { id: v.id, status: 'pending' }, data: { status: 'approved' } });
    if (count) {
      await this.prisma.vendorDoc.updateMany({ where: { vendorId: v.id }, data: { status: 'verified' } });
      await this.notifications.notify(v.userId!, 'partner', 'You are approved', 'Your documents are verified. Go online to start receiving work.', '/');
    }
    return this.prisma.vendor.findUniqueOrThrow({ where: { id: v.id } });
  }

  async me(userId: string) {
    return this.dto(await this.vendor(userId));
  }

  async dto(v: Vendor) {
    const [docs, member, restaurant, seller, unread] = await Promise.all([
      this.prisma.vendorDoc.findMany({ where: { vendorId: v.id }, select: { kind: true, number: true, status: true, image: true } }),
      this.prisma.member.findUnique({ where: { userId: v.userId! }, select: { referralCode: true } }),
      v.restaurantId ? this.prisma.restaurant.findUnique({ where: { id: v.restaurantId } }) : null,
      v.sellerId ? this.prisma.seller.findUnique({ where: { id: v.sellerId } }) : null,
      this.notifications.unread(v.userId!, true),
    ]);
    const cat = CATEGORIES[v.category as Category];
    return {
      id: v.id,
      name: v.name,
      phone: v.phone,
      photo: v.photo,
      category: v.category,
      categoryLabel: cat?.label ?? v.category,
      status: v.status,
      businessName: v.businessName,
      district: v.district,
      services: v.services,
      vehicle: v.vehicle,
      plate: v.plate,
      online: v.online,
      holiday: v.holiday,
      radiusKm: v.radiusKm,
      pincodes: v.pincodes,
      hours: (v.hours as { open: string; close: string; days: number[] } | null) ?? { open: '08:00', close: '20:00', days: [1, 2, 3, 4, 5, 6] },
      rating: v.rating,
      jobs: v.jobs,
      bank: v.bank as { holder: string; last4: string; ifsc: string } | null,
      restaurant: restaurant && { id: restaurant.id, name: restaurant.name, kind: restaurant.kind, cuisine: restaurant.cuisine, locality: restaurant.locality, open: restaurant.open, etaMin: restaurant.etaMin, costForTwo: restaurant.costForTwo },
      seller: seller && { id: seller.id, name: seller.name },
      referralCode: member?.referralCode ?? null,
      unread,
      docs: (cat?.docs ?? []).map((kind) => {
        const d = docs.find((x) => x.kind === kind);
        return { kind, label: DOC_LABEL[kind] ?? kind, number: d?.number ?? null, status: d ? d.status : 'missing', hasImage: !!d?.image };
      }),
    };
  }

  /* ---------------- onboarding ---------------- */

  private async buildServices(p: ProfileInput) {
    switch (p.category) {
      case 'service': {
        const home = await this.prisma.service.findMany({ where: { group: 'home' }, select: { code: true } });
        const codes = (p.services ?? []).filter((c) => home.some((h) => h.code === c));
        if (!codes.length) throw invalid('SERVICES', 'Choose at least one service you offer', 'services');
        return codes;
      }
      case 'driver':
        if (!p.cabType || !CAB_TYPES.includes(p.cabType)) throw invalid('VEHICLE', 'Choose your vehicle type', 'cabType');
        return [`cab:${p.cabType}`];
      case 'responder':
        if (!p.responderType) throw invalid('TYPE', 'Choose tow truck or ambulance', 'responderType');
        return [p.responderType];
      case 'rider':
        return ['rider'];
      default:
        return [p.category];
    }
  }

  /** Creates or edits the profile while it is a draft (category is fixed once submitted). */
  async saveProfile(userId: string, p: ProfileInput) {
    if (!CATEGORIES[p.category]) throw invalid('CATEGORY', 'Choose what kind of partner you are', 'category');
    if (!p.name || p.name.trim().length < 2) throw invalid('NAME', 'Enter your full name', 'name');
    const needsVehicle = ['driver', 'rider', 'responder'].includes(p.category);
    if (needsVehicle && (!p.vehicle?.trim() || !p.plate?.trim())) throw invalid('VEHICLE', 'Enter your vehicle model and number plate', 'vehicle');
    if (['restaurant', 'seller'].includes(p.category) && !p.businessName?.trim()) throw invalid('BUSINESS', 'Enter your business name', 'businessName');
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const existing = await this.prisma.vendor.findUnique({ where: { userId } });
    if (existing && existing.status !== 'draft' && existing.category !== p.category) throw invalid('CATEGORY', 'Your category is fixed after verification. Contact support to change it.', 'category');
    const services = await this.buildServices(p);
    const data = {
      name: p.name.trim(),
      category: p.category,
      businessName: p.businessName?.trim() || null,
      district: p.district?.trim() || 'Jaipur',
      services,
      vehicle: needsVehicle ? p.vehicle!.trim() : null,
      plate: needsVehicle ? p.plate!.trim().toUpperCase() : null,
    };
    const v = existing
      ? await this.prisma.vendor.update({ where: { id: existing.id }, data })
      : await this.prisma.vendor.create({ data: { ...data, userId, phone: user.phone, photo: user.photo ?? AVATAR, rating: 5, jobs: 0, years: 0, online: false, status: 'draft' } });
    if (!user.name) await this.prisma.user.update({ where: { id: userId }, data: { name: data.name } });

    // a restaurant or seller gets the storefront the customer app lists
    if (p.category === 'restaurant') {
      const r = p.restaurant;
      if (!r?.cuisine?.trim() || !r.locality?.trim()) throw invalid('RESTAURANT', 'Enter your cuisine and locality', 'restaurant');
      const fields = { name: data.businessName!, kind: r.kind === 'kitchen' ? 'kitchen' : 'restaurant', cuisine: r.cuisine.trim(), locality: r.locality.trim(), costForTwo: Math.max(10000, r.costForTwo || 40000), pureVeg: !!r.pureVeg };
      if (v.restaurantId) await this.prisma.restaurant.update({ where: { id: v.restaurantId }, data: fields });
      else {
        const rest = await this.prisma.restaurant.create({
          data: { id: `rest-${code(6).toLowerCase()}`, ...fields, photo: 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=900&q=70', rating: 4.5, ratings: 0, etaMin: 30, open: false, sort: 99 },
        });
        await this.prisma.vendor.update({ where: { id: v.id }, data: { restaurantId: rest.id } });
      }
    }
    if (p.category === 'seller') {
      if (v.sellerId) await this.prisma.seller.update({ where: { id: v.sellerId }, data: { name: data.businessName! } });
      else {
        const s = await this.prisma.seller.create({ data: { name: data.businessName!, rating: 4.5 } });
        await this.prisma.vendor.update({ where: { id: v.id }, data: { sellerId: s.id } });
      }
    }
    return this.me(userId);
  }

  async saveDoc(userId: string, d: { kind: string; number: string; image?: string }) {
    const v = await this.vendor(userId);
    if (!CATEGORIES[v.category as Category].docs.includes(d.kind)) throw invalid('DOC', 'This document is not needed for your category', 'kind');
    if (!d.number || d.number.trim().length < 4) throw invalid('DOC_NUMBER', 'Enter the document number', 'number');
    if (d.image && (!d.image.startsWith('data:image/') || d.image.length > 600000)) throw invalid('DOC_IMAGE', 'The photo is too large. Retake it a little further away.', 'image');
    const existing = await this.prisma.vendorDoc.findFirst({ where: { vendorId: v.id, kind: d.kind } });
    const data = { number: d.number.trim().toUpperCase(), image: d.image ?? existing?.image ?? null, status: 'submitted' };
    if (existing) await this.prisma.vendorDoc.update({ where: { id: existing.id }, data });
    else await this.prisma.vendorDoc.create({ data: { vendorId: v.id, kind: d.kind, ...data } });
    return this.me(userId);
  }

  /** Sends the profile for admin verification (proposal: mandatory documents + approval gate). */
  async submit(userId: string) {
    const v = await this.vendor(userId);
    if (v.status === 'approved') return this.me(userId);
    const docs = await this.prisma.vendorDoc.findMany({ where: { vendorId: v.id } });
    const missing = CATEGORIES[v.category as Category].docs.filter((k) => !docs.some((d) => d.kind === k && d.image));
    if (missing.length) throw invalid('DOCS_MISSING', `Upload your ${DOC_LABEL[missing[0]] ?? missing[0]} to continue`);
    await this.prisma.vendor.update({ where: { id: v.id }, data: { status: 'pending', submittedAt: new Date() } });
    await this.notifications.notify(userId, 'partner', 'Documents submitted', 'Our team is verifying your documents. This usually takes a few minutes.', '/');
    return this.me(userId);
  }

  /* ---------------- availability ---------------- */

  async setOnline(userId: string, online: boolean) {
    const v = await this.approved(userId);
    if (online && v.holiday) throw invalid('HOLIDAY', 'Turn off holiday mode to go online');
    if (online && v.category !== 'agent' && v.category !== 'seller') {
      const docsOk = await this.prisma.vendorDoc.count({ where: { vendorId: v.id, status: 'verified' } });
      if (!docsOk) throw invalid('DOCS', 'Your documents are not verified yet');
    }
    await this.prisma.vendor.update({ where: { id: v.id }, data: { online } });
    if (v.restaurantId) await this.prisma.restaurant.update({ where: { id: v.restaurantId }, data: { open: online } });
    return this.me(userId);
  }

  async availability(userId: string, a: { hours?: { open: string; close: string; days: number[] }; radiusKm?: number; pincodes?: string[]; holiday?: boolean }) {
    const v = await this.vendor(userId);
    const data: Prisma.VendorUpdateInput = {};
    if (a.hours) {
      const t = /^([01]\d|2[0-3]):[0-5]\d$/;
      if (!t.test(a.hours.open) || !t.test(a.hours.close) || a.hours.open >= a.hours.close) throw invalid('HOURS', 'Closing time must be after opening time', 'hours');
      if (!a.hours.days?.length) throw invalid('HOURS', 'Pick at least one working day', 'hours');
      data.hours = { open: a.hours.open, close: a.hours.close, days: [...new Set(a.hours.days.filter((d) => d >= 0 && d <= 6))].sort() };
    }
    if (a.radiusKm !== undefined) data.radiusKm = Math.max(1, Math.min(50, Math.round(a.radiusKm)));
    if (a.pincodes) {
      const bad = a.pincodes.find((p) => !/^\d{6}$/.test(p));
      if (bad) throw invalid('PINCODE', `${bad} is not a valid 6-digit pincode`, 'pincodes');
      data.pincodes = [...new Set(a.pincodes)];
    }
    if (a.holiday !== undefined) {
      data.holiday = a.holiday;
      if (a.holiday) data.online = false; // holiday mode takes the partner offline
    }
    await this.prisma.vendor.update({ where: { id: v.id }, data });
    if (a.holiday && v.restaurantId) await this.prisma.restaurant.update({ where: { id: v.restaurantId }, data: { open: false } });
    return this.me(userId);
  }

  /* ---------------- money ---------------- */

  /** Ledger owner ids whose vendor_earnings belong to this partner. */
  async owners(v: Vendor) {
    const ids = [v.id];
    if (v.restaurantId) ids.push(`restaurant:${v.restaurantId}`);
    if (v.sellerId) {
      const s = await this.prisma.seller.findUnique({ where: { id: v.sellerId } });
      if (s) ids.push(`seller:${s.name}`);
    }
    return ids;
  }

  private async accounts(v: Vendor) {
    return this.prisma.ledgerAccount.findMany({ where: { kind: 'vendor_earnings', ownerId: { in: await this.owners(v) } } });
  }

  async balance(v: Vendor) {
    const accounts = await this.accounts(v);
    const sums = await this.prisma.ledgerEntry.groupBy({ by: ['accountId'], where: { accountId: { in: accounts.map((a) => a.id) } }, _sum: { debit: true, credit: true } });
    return { total: sums.reduce((s, r) => s + (r._sum.credit ?? 0) - (r._sum.debit ?? 0), 0), byAccount: sums.map((r) => ({ accountId: r.accountId, ownerId: accounts.find((a) => a.id === r.accountId)!.ownerId!, balance: (r._sum.credit ?? 0) - (r._sum.debit ?? 0) })) };
  }

  /** Earned (credited) since a moment in time. */
  async earnedSince(v: Vendor, since: Date) {
    const accounts = await this.accounts(v);
    const rows = await this.prisma.ledgerEntry.findMany({ where: { accountId: { in: accounts.map((a) => a.id) }, credit: { gt: 0 }, journal: { createdAt: { gte: since }, type: { notIn: ['refund', 'payout'] } } }, select: { credit: true } });
    return rows.reduce((s, r) => s + r.credit, 0);
  }

  async wallet(userId: string) {
    const v = await this.vendor(userId);
    const accounts = await this.accounts(v);
    const [bal, today, week, entries, payouts] = await Promise.all([
      this.balance(v),
      this.earnedSince(v, startOfDay()),
      this.earnedSince(v, new Date(startOfDay().getTime() - 6 * 86400000)),
      this.prisma.ledgerEntry.findMany({ where: { accountId: { in: accounts.map((a) => a.id) } }, include: { journal: true }, orderBy: { journal: { createdAt: 'desc' } }, take: 60 }),
      this.prisma.vendorPayout.findMany({ where: { vendorId: v.id }, orderBy: { createdAt: 'desc' }, take: 20 }),
    ]);
    // payouts settle on the next bank cycle; the demo marks them paid after a minute
    for (const p of payouts.filter((p) => p.status === 'processing' && Date.now() - p.createdAt.getTime() > 60000)) {
      await this.prisma.vendorPayout.update({ where: { id: p.id }, data: { status: 'paid' } });
      p.status = 'paid';
    }
    return {
      balance: bal.total,
      today,
      week,
      minPayout: MIN_PAYOUT,
      bank: v.bank as { holder: string; last4: string; ifsc: string } | null,
      transactions: entries.map((e) => ({ id: e.id, title: e.journal.title, type: e.journal.type, ref: e.journal.ref, amount: e.credit - e.debit, at: e.journal.createdAt })),
      payouts: payouts.map((p) => ({ id: p.id, amount: p.amount, bankLast4: p.bankLast4, status: p.status, at: p.createdAt })),
    };
  }

  async saveBank(userId: string, b: { holder: string; account: string; ifsc: string }) {
    const v = await this.vendor(userId);
    if (!b.holder || b.holder.trim().length < 3) throw invalid('HOLDER', 'Enter the account holder name', 'holder');
    if (!/^\d{9,18}$/.test(b.account ?? '')) throw invalid('ACCOUNT', 'Enter a valid bank account number', 'account');
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test((b.ifsc ?? '').toUpperCase())) throw invalid('IFSC', 'Enter a valid IFSC code', 'ifsc');
    // TODO(RazorpayX): register the fund account and keep only its id; the app never needs the full number again
    await this.prisma.vendor.update({ where: { id: v.id }, data: { bank: { holder: b.holder.trim(), last4: b.account.slice(-4), ifsc: b.ifsc.toUpperCase() } } });
    return this.wallet(userId);
  }

  /** Direct bank withdrawal from the vendor wallet (double-entry: earnings → bank payouts). */
  async withdraw(userId: string, amount: number) {
    const v = await this.approved(userId);
    const bank = v.bank as { last4: string } | null;
    if (!bank) throw invalid('BANK', 'Add your bank account first', 'bank');
    if (!Number.isInteger(amount) || amount < MIN_PAYOUT) throw invalid('AMOUNT', `The minimum withdrawal is ₹${MIN_PAYOUT / 100}`, 'amount');
    const bal = await this.balance(v);
    if (amount > bal.total) throw invalid('AMOUNT', 'That is more than your available balance', 'amount');
    const payout = await this.prisma.vendorPayout.create({ data: { vendorId: v.id, amount, bankLast4: bank.last4, status: 'processing' } });
    let left = amount;
    const lines: { kind: 'vendor_earnings' | 'bank_payouts'; ownerId?: string; debit?: number; credit?: number }[] = [];
    for (const a of bal.byAccount.filter((a) => a.balance > 0)) {
      const take = Math.min(left, a.balance);
      if (take <= 0) break;
      lines.push({ kind: 'vendor_earnings', ownerId: a.ownerId, debit: take });
      left -= take;
    }
    lines.push({ kind: 'bank_payouts', credit: amount });
    await this.prisma.$transaction((tx) => this.ledger.post(tx, { type: 'payout', title: `Withdrawal to bank ••${bank.last4}`, ref: payout.id, key: `vendor-payout:${payout.id}` }, lines));
    await this.notifications.notify(userId, 'partner', 'Withdrawal requested', `₹${amount / 100} is on its way to bank ••${bank.last4}`, '/earnings');
    return this.wallet(userId);
  }

  /* ---------------- performance, referral, support, inbox ---------------- */

  async performance(userId: string) {
    const v = await this.vendor(userId);
    const [bookings, rides] = await Promise.all([
      this.prisma.booking.findMany({ where: { vendorId: v.id, rating: { not: null } }, include: { service: true, user: true }, orderBy: { updatedAt: 'desc' }, take: 20 }),
      this.prisma.ride.findMany({ where: { driverId: v.id, rating: { not: null } }, include: { user: true }, orderBy: { updatedAt: 'desc' }, take: 20 }),
    ]);
    const offered = v.accepted + v.declined;
    const acceptance = offered ? Math.round((v.accepted / offered) * 100) : 100;
    const cancellation = v.accepted ? Math.round((v.cancelled / v.accepted) * 100) : 0;
    const warnings: string[] = [];
    if (offered >= 5 && acceptance < 60) warnings.push('Your acceptance rate is below 60%. Partners under this may get fewer jobs.');
    if (v.accepted >= 5 && cancellation > 15) warnings.push('You cancel more than 15% of accepted jobs. Frequent cancellations can lead to suspension.');
    if (v.jobs >= 5 && v.rating < 4) warnings.push('Your rating is below 4.0. Review recent feedback to improve.');
    const reviews = [
      ...bookings.map((b) => ({ id: b.id, rating: b.rating!, text: b.review, title: b.service.label, by: b.user.name ?? 'Customer', at: b.updatedAt })),
      ...rides.map((r) => ({ id: r.id, rating: r.rating!, text: null, title: 'Cab ride', by: r.user.name ?? 'Rider', at: r.updatedAt })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());
    return { rating: v.rating, jobs: v.jobs, accepted: v.accepted, declined: v.declined, cancelled: v.cancelled, acceptance, cancellation, warnings, reviews };
  }

  async referral(userId: string) {
    await this.vendor(userId);
    const m = await this.prisma.member.findUnique({ where: { userId }, include: { _count: { select: { downline: true } } } });
    const network = m ? await this.prisma.referralClosure.count({ where: { ancestorId: m.id, depth: { gt: 0 } } }) : 0;
    return { code: m?.referralCode ?? null, direct: m?._count.downline ?? 0, network };
  }

  async tickets(userId: string) {
    const v = await this.vendor(userId);
    return this.prisma.supportTicket.findMany({ where: { vendorId: v.id }, orderBy: { createdAt: 'desc' } });
  }

  async raiseTicket(userId: string, t: { subject: string; message: string }) {
    const v = await this.vendor(userId);
    if (!t.subject?.trim()) throw invalid('SUBJECT', 'Choose what this is about', 'subject');
    if (!t.message || t.message.trim().length < 10) throw invalid('MESSAGE', 'Describe the problem in a few words', 'message');
    await this.prisma.supportTicket.create({ data: { vendorId: v.id, subject: t.subject.trim(), message: t.message.trim() } });
    await this.notifications.notify(userId, 'partner', 'Ticket raised', 'Our partner support team replies within 24 hours.', '/support');
    return this.tickets(userId);
  }

  inbox(userId: string) {
    return this.notifications.list(userId, true);
  }

  readNotifications(userId: string, ids?: string[]) {
    return this.notifications.markRead(userId, ids, true);
  }
}
