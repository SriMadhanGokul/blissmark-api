import { Injectable } from '@nestjs/common';

import { invalid, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { digits } from '../../common/util';
import { NotificationsService } from '../notifications/notifications.service';
import { LedgerService } from '../wallet/ledger.service';

export const SOS_ISSUES = {
  highway: ['Tow', 'Flat tyre', 'Out of fuel', 'Breakdown', 'Accident'],
  health: ['Breathing difficulty', 'Chest pain', 'Injury', 'Unconscious', 'Other'],
} as const;

/** Charges billed after the rescue (paise). */
const PRICE: Record<string, { label: string; amount: number }[]> = {
  Tow: [{ label: 'Towing (up to 10 km)', amount: 120000 }],
  'Flat tyre': [{ label: 'Tyre change / puncture', amount: 45000 }],
  'Out of fuel': [{ label: 'Fuel delivery charge', amount: 30000 }, { label: 'Fuel (5 L)', amount: 52500 }],
  Breakdown: [{ label: 'On-road mechanic', amount: 60000 }],
  Accident: [{ label: 'Towing + first response', amount: 150000 }],
  health: [{ label: 'Ambulance (basic life support)', amount: 150000 }, { label: 'Paramedic and oxygen', amount: 30000 }],
};

const ACTIVE = ['ALERTED', 'RESPONDER_ASSIGNED', 'EN_ROUTE', 'ARRIVED'];
const SIM: Record<string, { next: string; afterS: number }> = {
  ALERTED: { next: 'RESPONDER_ASSIGNED', afterS: 5 },
  RESPONDER_ASSIGNED: { next: 'EN_ROUTE', afterS: 4 },
  EN_ROUTE: { next: 'ARRIVED', afterS: 25 },
  ARRIVED: { next: 'RESOLVED', afterS: 30 },
};

@Injectable()
export class SosService {
  constructor(
    private prisma: PrismaService,
    private ledger: LedgerService,
    private notifications: NotificationsService,
  ) {}

  async create(userId: string, b: { type: 'highway' | 'health'; issue: string; note?: string; location: { label: string; lat: number; lng: number } }) {
    if (!SOS_ISSUES[b.type]) throw invalid('TYPE', 'Choose highway or health emergency');
    if (!(SOS_ISSUES[b.type] as readonly string[]).includes(b.issue)) throw invalid('ISSUE', 'Choose what happened', 'issue');
    if (!b.location || typeof b.location.lat !== 'number') throw invalid('LOCATION', 'Location is needed to send help', 'location');
    const open = await this.prisma.sosRequest.findFirst({ where: { userId, status: { in: ACTIVE } } });
    if (open) return this.get(userId, open.id); // never create a second alert by accident
    const id = `SOS${digits(4)}`;
    await this.prisma.sosRequest.create({
      data: { id, userId, type: b.type, issue: b.issue, note: b.note, location: b.location, status: 'ALERTED', contactsNotified: 2, events: [{ status: 'ALERTED', at: new Date() }] },
    });
    await this.notifications.notify(userId, 'sos', b.type === 'health' ? 'Ambulance requested' : 'Roadside help requested', 'Blissmark control room and your 2 emergency contacts are alerted.', `/sos/${id}`);
    return this.get(userId, id);
  }

  private async step(id: string, status: string, data: Record<string, unknown> = {}) {
    const s = await this.prisma.sosRequest.findUniqueOrThrow({ where: { id } });
    const events = [...((s.events as { status: string; at: string }[]) ?? []), { status, at: new Date() }];
    await this.prisma.sosRequest.update({ where: { id }, data: { status, events, ...data } });
  }

  private async simulate(id: string) {
    const s = await this.prisma.sosRequest.findUnique({ where: { id } });
    const rule = s && SIM[s.status];
    if (!s || !rule || (Date.now() - s.updatedAt.getTime()) / 1000 < rule.afterS) return;
    if (rule.next === 'RESPONDER_ASSIGNED') {
      const v = await this.prisma.vendor.findFirst({ where: { services: { has: s.type === 'health' ? 'ambulance' : 'tow' }, online: true }, orderBy: { rating: 'desc' } });
      await this.step(id, rule.next, { responder: v ? { name: v.name, photo: v.photo, rating: v.rating, vehicle: v.vehicle, plate: v.plate } : null });
      await this.notifications.notify(s.userId, 'sos', 'Help is assigned', `${v?.name ?? 'A responder'} is coming to you`, `/sos/${id}`);
    } else if (rule.next === 'RESOLVED') {
      const lines = PRICE[s.type === 'health' ? 'health' : s.issue] ?? [];
      const total = lines.reduce((a, l) => a + l.amount, 0);
      await this.step(id, 'RESOLVED', { invoice: { lines, total } });
      await this.notifications.notify(s.userId, 'sos', 'You are safe', `Pay ₹${(total / 100).toLocaleString('en-IN')} whenever you are ready`, `/sos/${id}`);
    } else {
      await this.step(id, rule.next);
    }
  }

  list(userId: string) {
    return this.prisma.sosRequest.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  }

  async get(userId: string, id: string) {
    await this.simulate(id);
    const s = await this.prisma.sosRequest.findFirst({ where: { id, userId } });
    if (!s) throw notFound('Emergency');
    return { ...s, etaMin: s.status === 'EN_ROUTE' ? 9 : s.status === 'RESPONDER_ASSIGNED' ? 12 : null };
  }

  async active(userId: string) {
    const s = await this.prisma.sosRequest.findFirst({ where: { userId, status: { in: [...ACTIVE, 'RESOLVED'] } }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    return s ? this.get(userId, s.id) : null;
  }

  async cancel(userId: string, id: string) {
    const s = await this.get(userId, id);
    if (!['ALERTED', 'RESPONDER_ASSIGNED', 'EN_ROUTE'].includes(s.status)) throw invalid('CANNOT_CANCEL', 'Help has already reached you');
    await this.step(id, 'CANCELLED');
    return this.get(userId, id);
  }

  /** Payment is requested only after the rescue (flow PDF rule). */
  async pay(userId: string, id: string, method: 'upi' | 'card' | 'wallet') {
    const s = await this.get(userId, id);
    const total = (s.invoice as { total?: number } | null)?.total;
    if (s.status !== 'RESOLVED' || !total) throw invalid('NOT_PAYABLE', 'There is nothing to pay yet');
    await this.prisma.$transaction(async (tx) => {
      const source = method === 'wallet' ? await this.ledger.spendLines(tx, userId, total) : [{ kind: 'gateway_clearing' as const, debit: total }];
      if (!source.length) throw invalid('WALLET_LOW', 'Your wallet balance is not enough', 'payment');
      await this.ledger.post(tx, { type: 'sos', title: s.type === 'health' ? 'Ambulance' : 'Roadside assistance', ref: id, key: `sos:${id}:pay` }, [
        ...source,
        { kind: 'vendor_earnings', ownerId: `responder:${(s.responder as { name?: string } | null)?.name ?? 'unknown'}`, credit: total },
      ]);
    });
    await this.step(id, 'PAID');
    return this.get(userId, id);
  }
}
