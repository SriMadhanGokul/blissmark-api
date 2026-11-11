import { Injectable } from '@nestjs/common';

import { invalid, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { digits } from '../../common/util';
import { NotificationsService } from '../notifications/notifications.service';
import { APP_PRIORITY_S, SIM_VENDOR, alertVendors, appVendorsOnline, applyRating } from '../partner/dispatch';
import { SettingsService } from '../admin/settings.service';
import { LedgerService } from '../wallet/ledger.service';

export const COMMISSION_PCT = 15;
export const GST_PCT = 18;
export const OPEN_HOUR = 8;
export const CLOSE_HOUR = 20;
const LEAVE_BEFORE_MS = 30 * 60 * 1000; // pro sets off 30 min before the slot
const ACTIVE = ['BROADCASTING', 'ACCEPTED', 'EN_ROUTE', 'STARTED', 'QUOTE_SENT', 'QUOTE_APPROVED', 'COMPLETED', 'INVOICED'];

type Line = { label: string; amount: number };

/**
 * Until the vendor app ships, a simulator plays the vendor side on a short clock
 * (seconds since the last step). Real vendor actions will replace `simulate()`.
 */
const SIM: Record<string, { next: string; afterS: number }> = {
  BROADCASTING: { next: 'ACCEPTED', afterS: 8 },
  ACCEPTED: { next: 'EN_ROUTE', afterS: 10 }, // and not before the scheduled slot
  EN_ROUTE: { next: 'STARTED', afterS: 30 },
  QUOTE_APPROVED: { next: 'COMPLETED', afterS: 20 },
  COMPLETED: { next: 'INVOICED', afterS: 4 },
};

@Injectable()
export class BookingsService {
  constructor(
    private prisma: PrismaService,
    private ledger: LedgerService,
    private notifications: NotificationsService,
    private settings: SettingsService,
  ) {}

  services() {
    return this.prisma.service.findMany({ where: { live: true }, orderBy: { sort: 'asc' } });
  }

  async service(code: string) {
    const s = await this.prisma.service.findUnique({ where: { code } });
    if (!s) throw notFound('Service');
    const pros = await this.prisma.vendor.count({ where: { services: { has: code }, online: true } });
    const rating = await this.prisma.vendor.aggregate({ where: { services: { has: code } }, _avg: { rating: true } });
    return { ...s, pros, avgRating: Math.round((rating._avg.rating ?? 4.7) * 10) / 10 };
  }

  /** Validates the requested slot. "now" means as soon as possible. */
  private slot(urgency: string, scheduledAt?: string) {
    if (urgency === 'now') return new Date();
    const at = scheduledAt ? new Date(scheduledAt) : null;
    if (!at || isNaN(at.getTime())) throw invalid('SLOT', 'Choose a date and time', 'scheduledAt');
    if (at.getTime() < Date.now() + 30 * 60 * 1000) throw invalid('SLOT', 'Choose a time at least 30 minutes from now', 'scheduledAt');
    if (at.getTime() > Date.now() + 30 * 86400000) throw invalid('SLOT', 'You can book up to 30 days ahead', 'scheduledAt');
    const ist = new Date(at.getTime() + 5.5 * 3600000); // slots are in India time
    const h = ist.getUTCHours() + ist.getUTCMinutes() / 60;
    if (h < OPEN_HOUR || h > CLOSE_HOUR) throw invalid('SLOT', 'Pros work between 8 AM and 8 PM', 'scheduledAt');
    return at;
  }

  async create(userId: string, b: { serviceCode: string; issue: string; urgency: string; description: string; addressId: string; scheduledAt?: string }) {
    const service = await this.prisma.service.findUnique({ where: { code: b.serviceCode } });
    if (!service || !service.live) throw invalid('SERVICE', 'This service is not available yet', 'service');
    if (b.description.trim().length < 10) throw invalid('DESCRIPTION', 'Describe the problem in a few words (at least 10 letters)', 'description');
    const address = await this.prisma.address.findFirst({ where: { id: b.addressId, userId } });
    if (!address) throw invalid('ADDRESS', 'Choose an address', 'address');
    const active = await this.prisma.booking.count({ where: { userId, serviceCode: b.serviceCode, status: { in: ACTIVE } } });
    if (active) throw invalid('ACTIVE_BOOKING', `You already have an active ${service.label.toLowerCase()} booking`);
    const scheduledAt = this.slot(b.urgency, b.scheduledAt);
    const notified = Math.max(3, await this.prisma.vendor.count({ where: { services: { has: b.serviceCode }, online: true } }));
    const id = `SR${digits(5)}`;
    await this.prisma.booking.create({
      data: {
        id,
        userId,
        serviceCode: b.serviceCode,
        status: 'BROADCASTING',
        issue: b.issue,
        urgency: b.urgency,
        scheduledAt,
        description: b.description.trim(),
        address: { label: address.label, line1: address.line1, city: address.city, pincode: address.pincode },
        startCode: digits(4),
        notified,
        events: { create: { status: 'BROADCASTING' } },
      },
    });
    const when = b.urgency === 'now' ? 'as soon as possible' : scheduledAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    await alertVendors(this.prisma, this.notifications, b.serviceCode, `New ${service.label.toLowerCase()} job`, `${b.issue} · ${address.city} · ${when}`);
    return this.get(userId, id);
  }

  /** Moves to `status`. With `from`, only if it is still in that status (two polls can race); returns whether it moved. */
  private async step(id: string, status: string, data: Record<string, unknown> = {}, from?: string) {
    const { count } = await this.prisma.booking.updateMany({ where: { id, ...(from ? { status: from } : {}) }, data: { status, ...data } });
    if (count) await this.prisma.bookingEvent.create({ data: { bookingId: id, status } });
    return count > 0;
  }

  private async simulate(id: string) {
    const b = await this.prisma.booking.findUnique({ where: { id }, include: { service: true, vendor: true } });
    if (!b) return;
    if (b.vendor?.userId) return; // a real partner drives this job from the vendor app
    const rule = SIM[b.status];
    // app vendors get the first chance to accept a broadcast
    const wait = b.status === 'BROADCASTING' && (await appVendorsOnline(this.prisma, b.serviceCode)) ? APP_PRIORITY_S : rule?.afterS;
    if (!rule || !wait || (Date.now() - b.updatedAt.getTime()) / 1000 < wait) return;
    if (b.status === 'ACCEPTED' && Date.now() < b.scheduledAt.getTime() - LEAVE_BEFORE_MS) return;
    const label = b.service.label;
    switch (b.status) {
      case 'BROADCASTING': {
        const vendor = await this.prisma.vendor.findFirst({ where: { ...SIM_VENDOR, services: { has: b.serviceCode }, online: true }, orderBy: { rating: 'desc' } });
        if (!vendor) return;
        if (!(await this.step(id, 'ACCEPTED', { vendorId: vendor.id }, b.status))) return;
        await this.notifications.notify(b.userId, 'booking', `${vendor.name.split(' ')[0]} accepted your request`, `${label} · #${id}`, `/booking/${id}`);
        return;
      }
      case 'ACCEPTED':
        if (!(await this.step(id, 'EN_ROUTE', {}, b.status))) return;
        await this.notifications.notify(b.userId, 'booking', `${label} is on the way`, `Share start code ${b.startCode} when they arrive`, `/booking/${id}`);
        return;
      case 'EN_ROUTE':
        if (!(await this.step(id, 'STARTED', {}, b.status))) return;
        if (b.service.requiresQuote) {
          const quote: Line[] = [
            { label: 'Labour (1 hr)', amount: 35000 },
            { label: 'Parts: P-trap pipe', amount: 28000 },
            { label: 'Parts: sealant', amount: 6000 },
          ];
          await this.step(id, 'QUOTE_SENT', { quote: { lines: quote, note: 'Pipe joint is cracked under the sink. Replacing the trap fixes it.' } });
          await this.notifications.notify(b.userId, 'booking', 'Estimate ready', `Review and approve the estimate for #${id}`, `/booking/${id}`);
        } else {
          await this.step(id, 'QUOTE_APPROVED');
        }
        return;
      case 'QUOTE_APPROVED':
        await this.step(id, 'COMPLETED', {}, b.status);
        return;
      case 'COMPLETED': {
        const quoteLines = ((b.quote as { lines?: Line[] } | null)?.lines ?? [{ label: 'Labour (1 hr)', amount: 35000 }]) as Line[];
        const lines: Line[] = [{ label: 'Visit charge', amount: b.service.visitCharge }, ...quoteLines];
        const subtotal = lines.reduce((s, l) => s + l.amount, 0);
        const gst = Math.round((subtotal * GST_PCT) / 10000) * 100; // whole rupees
        if (!(await this.step(id, 'INVOICED', { invoice: { number: `INV-${id.slice(2)}`, lines, subtotal, gst, total: subtotal + gst, photos: 3 } }, b.status))) return;
        await this.notifications.notify(b.userId, 'booking', 'Work completed · invoice ready', `Pay ₹${(subtotal + gst) / 100} for #${id}`, `/booking/${id}`);
        return;
      }
    }
  }

  async list(userId: string) {
    const ids = await this.prisma.booking.findMany({ where: { userId, status: { in: ACTIVE } }, select: { id: true } });
    for (const { id } of ids) await this.simulate(id);
    return this.prisma.booking.findMany({ where: { userId }, include: { service: true, vendor: true }, orderBy: { createdAt: 'desc' } });
  }

  async active(userId: string) {
    const b = await this.prisma.booking.findFirst({ where: { userId, status: { in: ACTIVE } }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    return b ? this.get(userId, b.id) : null;
  }

  async get(userId: string, id: string) {
    await this.simulate(id);
    const b = await this.prisma.booking.findFirst({ where: { id, userId }, include: { service: true, vendor: true, events: { orderBy: { at: 'asc' } } } });
    if (!b) throw notFound('Booking');
    const elapsed = Math.round((Date.now() - b.createdAt.getTime()) / 1000);
    return { ...b, waitingSeconds: elapsed, etaMin: b.status === 'EN_ROUTE' ? 12 : b.status === 'ACCEPTED' ? 18 : null };
  }

  async cancel(userId: string, id: string) {
    const b = await this.get(userId, id);
    if (!['BROADCASTING', 'ACCEPTED', 'EN_ROUTE'].includes(b.status)) throw invalid('CANNOT_CANCEL', 'Work has started, so this booking can no longer be cancelled');
    await this.step(id, 'CANCELLED');
    return this.get(userId, id);
  }

  async quote(userId: string, id: string, approve: boolean) {
    const b = await this.get(userId, id);
    if (b.status !== 'QUOTE_SENT') throw invalid('NO_QUOTE', 'There is no estimate waiting for approval');
    if (approve) await this.step(id, 'QUOTE_APPROVED');
    else {
      // declined: only the visit charge is billed
      await this.step(id, 'COMPLETED', { quote: { lines: [], note: 'Estimate declined' } });
    }
    return this.get(userId, id);
  }

  /** Customer pays the invoice; commission is split off and the vendor wallet credited (flow step 10). */
  async pay(userId: string, id: string, method: 'upi' | 'card' | 'wallet') {
    const b = await this.get(userId, id);
    if (b.status !== 'INVOICED' || !b.invoice) throw invalid('NOT_PAYABLE', 'There is no invoice to pay yet');
    const total = (b.invoice as { total: number }).total;
    const subtotal = (b.invoice as { subtotal: number }).subtotal;
    const vendor = b.vendorId ? await this.prisma.vendor.findUnique({ where: { id: b.vendorId } }) : null;
    const commission = await this.settings.commissionOn(vendor, subtotal);
    await this.prisma.$transaction(async (tx) => {
      const source = method === 'wallet' ? await this.ledger.spendLines(tx, userId, total) : [{ kind: 'gateway_clearing' as const, debit: total }];
      if (!source.length) throw invalid('WALLET_LOW', 'Your wallet balance is not enough', 'payment');
      await this.ledger.post(tx, { type: 'booking', title: `${b.service.label} booking`, ref: id, key: `booking:${id}:pay` }, [
        ...source,
        { kind: 'vendor_earnings', ownerId: b.vendorId, credit: total - commission },
        { kind: 'platform_commission', credit: commission },
      ]);
      await tx.booking.update({ where: { id }, data: { status: 'PAID', events: { create: { status: 'PAID' } } } });
      if (b.vendorId) await tx.vendor.update({ where: { id: b.vendorId }, data: { jobs: { increment: 1 } } });
      await this.notifications.notify(userId, 'booking', 'Payment received', `₹${total / 100} paid for #${id}. Thank you!`, `/booking/${id}`, tx);
    });
    return this.get(userId, id);
  }

  async rate(userId: string, id: string, rating: number, review?: string) {
    const b = await this.get(userId, id);
    if (b.status !== 'PAID') throw invalid('NOT_RATEABLE', 'You can rate after paying');
    await this.step(id, 'CLOSED', { rating, review });
    if (b.vendorId) await applyRating(this.prisma, b.vendorId, rating);
    return this.get(userId, id);
  }
}
