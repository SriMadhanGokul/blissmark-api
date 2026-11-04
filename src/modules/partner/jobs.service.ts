import { Injectable } from '@nestjs/common';
import type { Vendor } from '@prisma/client';

import { invalid, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { digits } from '../../common/util';
import { COMMISSION_PCT, GST_PCT } from '../bookings/bookings.service';
import { FoodService, RIDER_PAY } from '../food/food.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ShopService } from '../shop/shop.service';
import { PRICE } from '../sos/sos.service';
import { LedgerService } from '../wallet/ledger.service';
import { withEvent } from './dispatch';
import { PartnerService } from './partner.service';

/** One job type per vendor category. */
export type JobKind = 'booking' | 'ride' | 'delivery' | 'kitchen' | 'sos' | 'order' | 'visit';
export const KIND_OF: Record<string, JobKind> = { service: 'booking', driver: 'ride', rider: 'delivery', restaurant: 'kitchen', responder: 'sos', seller: 'order', agent: 'visit' };

type Tone = 'brand' | 'warning' | 'success' | 'danger' | 'neutral';
type Line = { label: string; amount: number };
type Action = { id: string; label: string; tone?: 'primary' | 'secondary' | 'danger'; input?: 'otp' | 'lines' | 'datetime' | 'note'; hint?: string };
type Place = { label: string; line1?: string; city?: string; pincode?: string; lat?: number; lng?: number };

const LABEL: Record<JobKind, Record<string, [string, Tone]>> = {
  booking: {
    BROADCASTING: ['New request', 'warning'], ACCEPTED: ['Accepted', 'brand'], EN_ROUTE: ['On the way', 'brand'], STARTED: ['Work in progress', 'brand'],
    QUOTE_SENT: ['Estimate sent', 'warning'], QUOTE_APPROVED: ['Estimate approved', 'brand'], COMPLETED: ['Send invoice', 'warning'], INVOICED: ['Awaiting payment', 'warning'],
    PAID: ['Paid', 'success'], CLOSED: ['Completed', 'success'], CANCELLED: ['Cancelled', 'danger'],
  },
  ride: { SEARCHING: ['New request', 'warning'], ACCEPTED: ['Go to pickup', 'brand'], ARRIVING: ['At pickup', 'brand'], ON_TRIP: ['On trip', 'brand'], COMPLETED: ['Awaiting payment', 'warning'], PAID: ['Paid', 'success'], CANCELLED: ['Cancelled', 'danger'] },
  delivery: { PREPARING: ['New delivery', 'warning'], RIDER_ASSIGNED: ['Go to restaurant', 'brand'], PICKED_UP: ['Delivering', 'brand'], DELIVERED: ['Delivered', 'success'], CANCELLED: ['Cancelled', 'danger'] },
  kitchen: { PLACED: ['New order', 'warning'], PREPARING: ['Preparing', 'brand'], RIDER_ASSIGNED: ['Rider assigned', 'brand'], PICKED_UP: ['Picked up', 'success'], DELIVERED: ['Delivered', 'success'], CANCELLED: ['Cancelled', 'danger'] },
  sos: { ALERTED: ['SOS alert', 'danger'], RESPONDER_ASSIGNED: ['Assigned', 'danger'], EN_ROUTE: ['En route', 'brand'], ARRIVED: ['On site', 'brand'], RESOLVED: ['Awaiting payment', 'warning'], PAID: ['Paid', 'success'], CANCELLED: ['Cancelled', 'danger'] },
  order: { PLACED: ['To pack', 'warning'], PACKED: ['Ready to ship', 'brand'], SHIPPED: ['Shipped', 'brand'], OUT_FOR_DELIVERY: ['Out for delivery', 'brand'], DELIVERED: ['Delivered', 'success'], CANCELLED: ['Cancelled', 'danger'] },
  visit: { REQUESTED: ['Confirm visit', 'warning'], CONFIRMED: ['Confirmed', 'success'] },
};
const ACTIVE: Record<JobKind, string[]> = {
  booking: ['ACCEPTED', 'EN_ROUTE', 'STARTED', 'QUOTE_SENT', 'QUOTE_APPROVED', 'COMPLETED', 'INVOICED'],
  ride: ['ACCEPTED', 'ARRIVING', 'ON_TRIP', 'COMPLETED'],
  delivery: ['RIDER_ASSIGNED', 'PICKED_UP'],
  kitchen: ['PREPARING', 'RIDER_ASSIGNED'],
  sos: ['RESPONDER_ASSIGNED', 'EN_ROUTE', 'ARRIVED', 'RESOLVED'],
  order: ['PLACED', 'PACKED'],
  visit: ['REQUESTED'],
};

const IST = { timeZone: 'Asia/Kolkata' } as const;
const masked = (phone?: string | null) => (phone ? `+91 ${phone.slice(0, 2)}••••${phone.slice(-4)}` : null);
const share = (amount: number) => amount - Math.round((amount * COMMISSION_PCT) / 100);
const cleanLines = (lines?: Line[]) => {
  const out = (lines ?? []).filter((l) => l?.label?.trim() && Number.isInteger(l.amount) && l.amount > 0).map((l) => ({ label: l.label.trim(), amount: l.amount }));
  if (!out.length) throw invalid('LINES', 'Add at least one item with an amount', 'lines');
  return out;
};

@Injectable()
export class JobsService {
  constructor(
    private prisma: PrismaService,
    private partner: PartnerService,
    private ledger: LedgerService,
    private notifications: NotificationsService,
    private food: FoodService,
    private shop: ShopService,
  ) {}

  /** Within the partner's working days and hours (India time)? */
  private onShift(v: Vendor) {
    const h = (v.hours as { open: string; close: string; days: number[] } | null) ?? { open: '00:00', close: '23:59', days: [0, 1, 2, 3, 4, 5, 6] };
    const now = new Date(Date.now() + 5.5 * 3600000);
    const hm = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
    return h.days.includes(now.getUTCDay()) && hm >= h.open && hm <= h.close;
  }

  private async sellerName(v: Vendor) {
    return v.sellerId ? (await this.prisma.seller.findUnique({ where: { id: v.sellerId } }))?.name ?? null : null;
  }

  /* ---------------- offers (broadcast jobs open to this partner) ---------------- */

  async offers(userId: string) {
    const v = await this.partner.vendor(userId);
    if (v.status !== 'approved' || !v.online) return { online: v.online, onShift: this.onShift(v), offers: [] };
    const notDeclined = { NOT: { declinedBy: { has: v.id } } };
    const fresh = new Date(Date.now() - 6 * 3600000);
    const kind = KIND_OF[v.category];
    let offers: ReturnType<JobsService['summary']>[] = [];
    if (kind === 'booking') {
      const list = await this.prisma.booking.findMany({ where: { status: 'BROADCASTING', serviceCode: { in: v.services }, createdAt: { gte: fresh }, ...notDeclined }, include: { service: true }, orderBy: { createdAt: 'desc' } });
      offers = list.filter((b) => !v.pincodes.length || v.pincodes.includes((b.address as Place).pincode ?? '')).map((b) => this.summary('booking', b));
    } else if (kind === 'ride') {
      const types = v.services.filter((s) => s.startsWith('cab:')).map((s) => s.slice(4));
      const list = await this.prisma.ride.findMany({ where: { status: 'SEARCHING', vehicle: { in: types }, createdAt: { gte: fresh }, ...notDeclined }, orderBy: { createdAt: 'desc' } });
      offers = list.map((r) => this.summary('ride', r));
    } else if (kind === 'delivery') {
      const list = await this.prisma.foodOrder.findMany({ where: { status: 'PREPARING', OR: [{ riderId: null }, { riderId: { isSet: false } }], createdAt: { gte: fresh }, ...notDeclined }, orderBy: { createdAt: 'desc' } });
      offers = list.map((o) => this.summary('delivery', o));
    } else if (kind === 'sos') {
      const type = v.services.includes('ambulance') ? 'health' : 'highway';
      const list = await this.prisma.sosRequest.findMany({ where: { status: 'ALERTED', type, createdAt: { gte: fresh }, ...notDeclined }, orderBy: { createdAt: 'desc' } });
      offers = list.map((s) => this.summary('sos', s));
    } else if (kind === 'kitchen' && v.restaurantId) {
      const list = await this.prisma.foodOrder.findMany({ where: { status: 'PLACED', restaurantId: v.restaurantId }, orderBy: { createdAt: 'desc' } });
      offers = list.map((o) => this.summary('kitchen', o));
    }
    return { online: v.online, onShift: this.onShift(v), offers };
  }

  /** First accept wins: the update only applies while the job is still open. */
  async accept(userId: string, kind: JobKind, id: string) {
    const v = await this.partner.approved(userId);
    if (!v.online) throw invalid('OFFLINE', 'Go online to accept work');
    if (KIND_OF[v.category] !== kind) throw invalid('KIND', 'This job is not for your category');
    const taken = invalid('TAKEN', 'Another partner already took this job');
    const person = { name: v.name, photo: v.photo, rating: v.rating, vehicle: v.vehicle, plate: v.plate };
    const first = v.name.split(' ')[0];

    if (kind === 'booking') {
      const b = await this.prisma.booking.findUnique({ where: { id }, include: { service: true } });
      if (!b || !v.services.includes(b.serviceCode)) throw notFound('Job');
      const { count } = await this.prisma.booking.updateMany({ where: { id, status: 'BROADCASTING' }, data: { status: 'ACCEPTED', vendorId: v.id } });
      if (!count) throw taken;
      await this.prisma.bookingEvent.create({ data: { bookingId: id, status: 'ACCEPTED' } });
      await this.notifications.notify(b.userId, 'booking', `${first} accepted your request`, `${b.service.label} · #${id}`, `/booking/${id}`);
    } else if (kind === 'ride') {
      const r = await this.prisma.ride.findUnique({ where: { id } });
      if (!r || !v.services.includes(`cab:${r.vehicle}`)) throw notFound('Ride');
      const { count } = await this.prisma.ride.updateMany({ where: { id, status: 'SEARCHING' }, data: { status: 'ACCEPTED', driverId: v.id, driver: { ...person, trips: v.jobs }, events: withEvent(r.events, 'ACCEPTED') } });
      if (!count) throw taken;
      await this.notifications.notify(r.userId, 'ride', `${first} is coming to pick you up`, `${v.vehicle} · ${v.plate} · OTP ${r.otp}`, `/ride/${id}`);
    } else if (kind === 'delivery') {
      const o = await this.prisma.foodOrder.findUnique({ where: { id } });
      if (!o) throw notFound('Delivery');
      const { count } = await this.prisma.foodOrder.updateMany({ where: { id, status: 'PREPARING', OR: [{ riderId: null }, { riderId: { isSet: false } }] }, data: { status: 'RIDER_ASSIGNED', riderId: v.id, rider: person, events: withEvent(o.events, 'RIDER_ASSIGNED') } });
      if (!count) throw taken;
      await this.notifications.notify(o.userId, 'food', 'Rider assigned to your order', `${first} will pick up from ${o.restaurantName}`, `/food-order/${id}`);
    } else if (kind === 'sos') {
      const s = await this.prisma.sosRequest.findUnique({ where: { id } });
      if (!s) throw notFound('Emergency');
      const { count } = await this.prisma.sosRequest.updateMany({ where: { id, status: 'ALERTED' }, data: { status: 'RESPONDER_ASSIGNED', responderId: v.id, responder: person, events: withEvent(s.events, 'RESPONDER_ASSIGNED') } });
      if (!count) throw taken;
      await this.notifications.notify(s.userId, 'sos', 'Help is assigned', `${v.businessName ?? v.name} is coming to you`, `/sos/${id}`);
    } else if (kind === 'kitchen') {
      const o = await this.prisma.foodOrder.findUnique({ where: { id } });
      if (!o || o.restaurantId !== v.restaurantId) throw notFound('Order');
      const { count } = await this.prisma.foodOrder.updateMany({ where: { id, status: 'PLACED' }, data: { status: 'PREPARING', events: withEvent(o.events, 'PREPARING') } });
      if (!count) throw invalid('TAKEN', 'This order was already handled');
      await this.notifications.notify(o.userId, 'food', `${o.restaurantName} is preparing your order`, `Order #${id}`, `/food-order/${id}`);
      await this.food.alertRiders(o.restaurantName, id);
    } else throw invalid('KIND', 'This job cannot be accepted');

    await this.prisma.vendor.update({ where: { id: v.id }, data: { accepted: { increment: 1 } } });
    return this.job(userId, kind, id);
  }

  async decline(userId: string, kind: JobKind, id: string) {
    const v = await this.partner.approved(userId);
    if (kind === 'kitchen') {
      // a kitchen saying no cancels the order and refunds the customer
      const o = await this.prisma.foodOrder.findUnique({ where: { id } });
      if (!o || o.restaurantId !== v.restaurantId || o.status !== 'PLACED') throw invalid('NOT_OPEN', 'This order can no longer be declined');
      await this.food.refund(o, `${o.restaurantName} could not take your order`);
    } else {
      const push = { declinedBy: { push: v.id } };
      if (kind === 'booking') await this.prisma.booking.update({ where: { id }, data: push });
      else if (kind === 'ride') await this.prisma.ride.update({ where: { id }, data: push });
      else if (kind === 'delivery') await this.prisma.foodOrder.update({ where: { id }, data: push });
      else if (kind === 'sos') await this.prisma.sosRequest.update({ where: { id }, data: push });
      else throw invalid('KIND', 'This job cannot be declined');
    }
    await this.prisma.vendor.update({ where: { id: v.id }, data: { declined: { increment: 1 } } });
    return { ok: true };
  }

  /* ---------------- my jobs ---------------- */

  async jobs(userId: string, scope: 'active' | 'done') {
    const v = await this.partner.vendor(userId);
    const kind = KIND_OF[v.category];
    const active = ACTIVE[kind];
    const status = scope === 'active' ? { in: active } : { notIn: [...active, ...(kind === 'kitchen' ? ['PLACED'] : [])] };
    const take = 50;
    switch (kind) {
      case 'booking':
        return (await this.prisma.booking.findMany({ where: { vendorId: v.id, status }, include: { service: true }, orderBy: { updatedAt: 'desc' }, take })).map((b) => this.summary('booking', b));
      case 'ride':
        return (await this.prisma.ride.findMany({ where: { driverId: v.id, status }, orderBy: { updatedAt: 'desc' }, take })).map((r) => this.summary('ride', r));
      case 'delivery':
        return (await this.prisma.foodOrder.findMany({ where: { riderId: v.id, status }, orderBy: { updatedAt: 'desc' }, take })).map((o) => this.summary('delivery', o));
      case 'kitchen':
        return (await this.prisma.foodOrder.findMany({ where: { restaurantId: v.restaurantId ?? '-', status }, orderBy: { updatedAt: 'desc' }, take })).map((o) => this.summary('kitchen', o));
      case 'sos':
        return (await this.prisma.sosRequest.findMany({ where: { responderId: v.id, status }, orderBy: { updatedAt: 'desc' }, take })).map((s) => this.summary('sos', s));
      case 'order': {
        const sellerName = await this.sellerName(v);
        return (await this.prisma.order.findMany({ where: { sellerName: sellerName ?? '-', status }, orderBy: { placedAt: 'desc' }, take })).map((o) => this.summary('order', o));
      }
      case 'visit': {
        const props = await this.prisma.property.findMany({ where: { agentId: v.id }, select: { id: true } });
        const list = await this.prisma.enquiry.findMany({ where: { propertyId: { in: props.map((p) => p.id) }, status }, include: { property: true, user: true }, orderBy: { createdAt: 'desc' }, take });
        return list.map((e) => this.summary('visit', e));
      }
    }
  }

  // Summaries take loosely typed rows: each kind reads only its own fields.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  summary(kind: JobKind, x: any) {
    const [label, tone] = LABEL[kind][x.status] ?? [x.status, 'neutral' as Tone];
    const base = { kind, id: x.id as string, status: x.status as string, label, tone, createdAt: (x.createdAt ?? x.placedAt) as Date };
    switch (kind) {
      case 'booking':
        return { ...base, title: `${x.service.label} · ${x.issue}`, subtitle: `${x.address.line1}, ${x.address.city}`, when: x.urgency === 'now' ? null : x.scheduledAt, amount: x.invoice ? share(x.invoice.total) : share(x.service.visitCharge), estimate: !x.invoice };
      case 'ride':
        return { ...base, title: `${x.pickup.label} → ${x.drop.label}`, subtitle: `${x.distanceKm} km · ${x.durationMin} min · ${x.paymentMethod === 'cash' ? 'Cash' : 'Online'}`, when: null, amount: share(x.fare.total), estimate: false };
      case 'delivery':
        return { ...base, title: `Pick up from ${x.restaurantName}`, subtitle: `Drop: ${x.address.line1}, ${x.address.city}`, when: null, amount: RIDER_PAY, estimate: false };
      case 'kitchen':
        return { ...base, title: `#${x.id} · ${x.items.reduce((s: number, i: { qty: number }) => s + i.qty, 0)} item(s)`, subtitle: x.items.map((i: { qty: number; name: string }) => `${i.qty}× ${i.name}`).join(', '), when: x.scheduledAt ?? null, amount: x.total - Math.round(x.subtotal * 0.15), estimate: false };
      case 'sos':
        return { ...base, title: `${x.type === 'health' ? 'Health' : 'Highway'} SOS · ${x.issue}`, subtitle: x.location.label, when: null, amount: x.invoice?.total ?? (PRICE[x.type === 'health' ? 'health' : x.issue] ?? []).reduce((s, l) => s + l.amount, 0), estimate: !x.invoice };
      case 'order':
        return { ...base, title: `#${x.id} · ${x.items.reduce((s: number, i: { qty: number }) => s + i.qty, 0)} item(s)`, subtitle: x.items.map((i: { title: string }) => i.title).join(', '), when: x.expectedAt, amount: x.total, estimate: false };
      case 'visit':
        return { ...base, title: x.property.title, subtitle: `${x.user?.name ?? 'Customer'} · ${x.visitAt ? 'site visit' : 'enquiry'}`, when: x.visitAt, amount: null, estimate: false };
    }
  }

  /* ---------------- job detail ---------------- */

  async job(userId: string, kind: JobKind, id: string) {
    const v = await this.partner.vendor(userId);
    if (KIND_OF[v.category] !== kind) throw notFound('Job');
    const mine = (owner: string | null | undefined) => owner === v.id;
    const customer = (u: { name: string | null; phone: string }) => ({ name: u.name ?? 'Customer', phone: masked(u.phone) });

    if (kind === 'booking') {
      const b = await this.prisma.booking.findUnique({ where: { id }, include: { service: true, user: true, events: { orderBy: { at: 'asc' } } } });
      if (!b || (b.status !== 'BROADCASTING' && !mine(b.vendorId))) throw notFound('Job');
      const quote = b.quote as { lines: Line[]; note?: string } | null;
      const actions: Action[] = [];
      if (b.status === 'ACCEPTED') actions.push({ id: 'start', label: 'Start trip to customer', tone: 'primary' }, { id: 'cancel', label: 'Cancel job', tone: 'danger' });
      if (b.status === 'EN_ROUTE') actions.push({ id: 'arrive', label: 'Arrived · enter start code', tone: 'primary', input: 'otp', hint: 'Ask the customer for the 4-digit start code' }, { id: 'cancel', label: 'Cancel job', tone: 'danger' });
      if (b.status === 'STARTED') {
        actions.push({ id: 'quote', label: 'Send estimate', tone: b.service.requiresQuote ? 'primary' : 'secondary', input: 'lines', hint: 'Parts and labour the customer must approve' });
        if (!b.service.requiresQuote) actions.push({ id: 'complete', label: 'Mark work completed', tone: 'primary' });
      }
      if (b.status === 'QUOTE_APPROVED') actions.push({ id: 'complete', label: 'Mark work completed', tone: 'primary' });
      if (b.status === 'COMPLETED') actions.push({ id: 'invoice', label: 'Send invoice', tone: 'primary', input: 'lines' });
      return {
        ...this.summary('booking', b),
        customer: mine(b.vendorId) ? customer(b.user) : null,
        location: b.address as Place,
        description: b.description,
        lines: (b.invoice as { lines: Line[] } | null)?.lines ?? quote?.lines ?? [],
        invoice: b.invoice,
        quote,
        draftLines: [{ label: 'Visit charge', amount: b.service.visitCharge }, ...(quote?.lines ?? [])],
        gstPct: GST_PCT,
        timeline: b.events.map((e) => ({ status: e.status, label: LABEL.booking[e.status]?.[0] ?? e.status, at: e.at })),
        actions,
      };
    }
    if (kind === 'ride') {
      const r = await this.prisma.ride.findUnique({ where: { id }, include: { user: true } });
      if (!r || (r.status !== 'SEARCHING' && !mine(r.driverId))) throw notFound('Ride');
      const fare = r.fare as { base: number; distance: number; time: number; total: number };
      const actions: Action[] = [];
      if (r.status === 'ACCEPTED') actions.push({ id: 'arrive', label: 'I have reached pickup', tone: 'primary' }, { id: 'cancel', label: 'Cancel ride', tone: 'danger' });
      if (r.status === 'ARRIVING') actions.push({ id: 'start', label: 'Start trip · enter OTP', tone: 'primary', input: 'otp', hint: 'Ask the rider for their 4-digit ride OTP' }, { id: 'cancel', label: 'Cancel ride', tone: 'danger' });
      if (r.status === 'ON_TRIP') actions.push({ id: 'complete', label: 'End trip', tone: 'primary' });
      return {
        ...this.summary('ride', r),
        customer: mine(r.driverId) ? customer(r.user) : null,
        location: r.status === 'ON_TRIP' ? (r.drop as Place) : (r.pickup as Place),
        stops: [r.pickup as Place, r.drop as Place],
        lines: [{ label: 'Base fare', amount: fare.base }, { label: `Distance (${r.distanceKm} km)`, amount: fare.distance }, { label: `Time (${r.durationMin} min)`, amount: fare.time }],
        total: fare.total,
        payment: r.paymentMethod,
        timeline: (r.events as { status: string; at: string }[]).map((e) => ({ status: e.status, label: LABEL.ride[e.status]?.[0] ?? e.status, at: e.at })),
        actions,
      };
    }
    if (kind === 'delivery' || kind === 'kitchen') {
      const o = await this.prisma.foodOrder.findUnique({ where: { id }, include: { user: true } });
      const own = kind === 'kitchen' ? o?.restaurantId === v.restaurantId : o?.status === 'PREPARING' || mine(o?.riderId);
      if (!o || !own) throw notFound('Order');
      const restaurant = await this.prisma.restaurant.findUnique({ where: { id: o.restaurantId } });
      const items = o.items as { name: string; qty: number; price: number; veg: boolean }[];
      const actions: Action[] = [];
      if (kind === 'kitchen' && ['PREPARING', 'RIDER_ASSIGNED'].includes(o.status) && !o.readyAt) actions.push({ id: 'ready', label: 'Food is ready for pickup', tone: 'primary' });
      if (kind === 'delivery' && o.status === 'RIDER_ASSIGNED') actions.push({ id: 'pickup', label: 'Picked up the order', tone: 'primary', hint: o.readyAt ? undefined : 'Wait for the kitchen to mark it ready' });
      if (kind === 'delivery' && o.status === 'PICKED_UP') actions.push({ id: 'deliver', label: 'Delivered to customer', tone: 'primary' });
      const addr = o.address as Place;
      return {
        ...this.summary(kind, o),
        customer: kind === 'kitchen' || mine(o.riderId) ? customer(o.user) : null,
        location: kind === 'delivery' && o.status !== 'PICKED_UP' ? { label: o.restaurantName, line1: restaurant?.locality, city: 'Jaipur' } : addr,
        stops: [{ label: o.restaurantName, line1: restaurant?.locality, city: 'Jaipur' }, addr],
        items: items.map((i) => ({ name: i.name, qty: i.qty, amount: i.price * i.qty, veg: i.veg })),
        lines: [{ label: 'Items', amount: o.subtotal }, { label: 'Taxes', amount: o.taxes }, { label: 'Delivery', amount: o.deliveryFee }],
        total: o.total,
        readyAt: o.readyAt,
        rider: kind === 'kitchen' ? o.rider : null,
        timeline: (o.events as { status: string; at: string }[]).map((e) => ({ status: e.status, label: LABEL[kind][e.status]?.[0] ?? e.status, at: e.at })),
        actions,
      };
    }
    if (kind === 'sos') {
      const s = await this.prisma.sosRequest.findUnique({ where: { id }, include: { user: true } });
      if (!s || (s.status !== 'ALERTED' && !mine(s.responderId))) throw notFound('Emergency');
      const actions: Action[] = [];
      if (s.status === 'RESPONDER_ASSIGNED') actions.push({ id: 'en_route', label: 'Leaving now · en route', tone: 'primary' });
      if (s.status === 'EN_ROUTE') actions.push({ id: 'arrive', label: 'Reached the location', tone: 'primary' });
      if (s.status === 'ARRIVED') actions.push({ id: 'resolve', label: 'Resolved · send bill', tone: 'primary', input: 'lines' });
      return {
        ...this.summary('sos', s),
        customer: mine(s.responderId) ? customer(s.user) : null,
        location: s.location as Place,
        description: s.note,
        lines: (s.invoice as { lines: Line[] } | null)?.lines ?? [],
        draftLines: PRICE[s.type === 'health' ? 'health' : s.issue] ?? [],
        timeline: (s.events as { status: string; at: string }[]).map((e) => ({ status: e.status, label: LABEL.sos[e.status]?.[0] ?? e.status, at: e.at })),
        actions,
      };
    }
    if (kind === 'order') {
      const o = await this.prisma.order.findUnique({ where: { id }, include: { user: true, events: { orderBy: { at: 'asc' } } } });
      if (!o || o.sellerName !== (await this.sellerName(v))) throw notFound('Order');
      const items = o.items as { title: string; qty: number; price: number; colour?: string; photo?: string }[];
      const actions: Action[] = [];
      if (o.status === 'PLACED') actions.push({ id: 'pack', label: 'Mark packed', tone: 'primary' }, { id: 'cancel', label: 'Cancel order', tone: 'danger' });
      if (o.status === 'PACKED') actions.push({ id: 'ship', label: 'Hand over to courier', tone: 'primary' }, { id: 'cancel', label: 'Cancel order', tone: 'danger' });
      return {
        ...this.summary('order', o),
        customer: customer(o.user),
        location: o.address as Place,
        items: items.map((i) => ({ name: `${i.title}${i.colour ? ` · ${i.colour}` : ''}`, qty: i.qty, amount: i.price * i.qty, photo: i.photo })),
        lines: [{ label: 'Items', amount: o.subtotal }, ...(o.discount ? [{ label: 'Discount', amount: -o.discount }] : []), { label: 'Delivery', amount: o.deliveryFee }],
        total: o.total,
        payment: o.paymentMethod,
        shipping: { courier: o.courier, awb: o.awb },
        timeline: o.events.map((e) => ({ status: e.status, label: e.note, at: e.at })),
        actions,
      };
    }
    const e = await this.prisma.enquiry.findUnique({ where: { id }, include: { property: true, user: true } });
    if (!e || e.property.agentId !== v.id) throw notFound('Enquiry');
    const actions: Action[] = e.status === 'REQUESTED' ? [{ id: 'confirm', label: e.visitAt ? 'Confirm this visit' : 'Reply to enquiry', tone: 'primary', input: 'note' }, { id: 'reschedule', label: 'Propose another time', tone: 'secondary', input: 'datetime' }] : [];
    return {
      ...this.summary('visit', e),
      customer: customer(e.user),
      location: { label: e.property.title, line1: e.property.locality, city: e.property.city },
      description: e.message,
      reply: e.reply,
      property: { id: e.property.id, title: e.property.title, price: e.property.price, photo: e.property.photos[0] },
      timeline: [{ status: 'REQUESTED', label: 'Requested', at: e.createdAt }],
      actions,
    };
  }

  /* ---------------- job actions ---------------- */

  async act(userId: string, kind: JobKind, id: string, action: string, body: { otp?: string; lines?: Line[]; note?: string; visitAt?: string }) {
    const v = await this.partner.approved(userId);
    const detail = await this.job(userId, kind, id);
    if (!detail.actions.some((a) => a.id === action)) throw invalid('ACTION', 'That step is not available right now');
    const first = v.name.split(' ')[0];
    const moved = invalid('MOVED', 'This job changed in the meantime. Pull to refresh.');

    if (kind === 'booking') {
      const b = await this.prisma.booking.findUniqueOrThrow({ where: { id }, include: { service: true } });
      const label = b.service.label;
      const to = async (status: string, data: Record<string, unknown> = {}) => {
        const { count } = await this.prisma.booking.updateMany({ where: { id, status: b.status, vendorId: v.id }, data: { status, ...data } });
        if (!count) throw moved;
        await this.prisma.bookingEvent.create({ data: { bookingId: id, status } });
      };
      if (action === 'start') {
        await to('EN_ROUTE');
        await this.notifications.notify(b.userId, 'booking', `${label} is on the way`, `${first} is coming. Share start code ${b.startCode} when they arrive`, `/booking/${id}`);
      } else if (action === 'arrive') {
        if ((body.otp ?? '').trim() !== b.startCode) throw invalid('CODE', 'That start code is not right. Ask the customer again.', 'otp');
        await to('STARTED');
        await this.notifications.notify(b.userId, 'booking', 'Work started', `${first} has started on your ${label.toLowerCase()} job`, `/booking/${id}`);
      } else if (action === 'quote') {
        await to('QUOTE_SENT', { quote: { lines: cleanLines(body.lines), note: body.note?.trim() || 'Estimate for the work needed' } });
        await this.notifications.notify(b.userId, 'booking', 'Estimate ready', `Review and approve the estimate for #${id}`, `/booking/${id}`);
      } else if (action === 'complete') {
        await to('COMPLETED');
        await this.notifications.notify(b.userId, 'booking', 'Work completed', `${first} has finished. The invoice is on its way.`, `/booking/${id}`);
      } else if (action === 'invoice') {
        const lines = cleanLines(body.lines);
        const subtotal = lines.reduce((s, l) => s + l.amount, 0);
        const gst = Math.round((subtotal * GST_PCT) / 10000) * 100;
        await to('INVOICED', { invoice: { number: `INV-${id.slice(2)}`, lines, subtotal, gst, total: subtotal + gst, photos: 0 } });
        await this.notifications.notify(b.userId, 'booking', 'Work completed · invoice ready', `Pay ₹${(subtotal + gst) / 100} for #${id}`, `/booking/${id}`);
      } else if (action === 'cancel') {
        // back to the pool so another pro can take it
        const { count } = await this.prisma.booking.updateMany({ where: { id, status: b.status, vendorId: v.id }, data: { status: 'BROADCASTING', vendorId: null, declinedBy: { push: v.id } } });
        if (!count) throw moved;
        await this.prisma.bookingEvent.create({ data: { bookingId: id, status: 'BROADCASTING' } });
        await this.prisma.vendor.update({ where: { id: v.id }, data: { cancelled: { increment: 1 } } });
        await this.notifications.notify(b.userId, 'booking', 'Finding you another pro', `${first} had to cancel. We are sending your request to other pros.`, `/booking/${id}`);
        return { ok: true, released: true };
      }
    } else if (kind === 'ride') {
      const r = await this.prisma.ride.findUniqueOrThrow({ where: { id } });
      const to = async (status: string, data: Record<string, unknown> = {}) => {
        const { count } = await this.prisma.ride.updateMany({ where: { id, status: r.status, driverId: v.id }, data: { status, events: withEvent(r.events, status), ...data } });
        if (!count) throw moved;
      };
      if (action === 'arrive') {
        await to('ARRIVING');
        await this.notifications.notify(r.userId, 'ride', `${first} has arrived`, `${v.vehicle} · ${v.plate}. Share OTP ${r.otp} to start`, `/ride/${id}`);
      } else if (action === 'start') {
        if ((body.otp ?? '').trim() !== r.otp) throw invalid('CODE', 'That OTP is not right. Ask the rider again.', 'otp');
        await to('ON_TRIP');
      } else if (action === 'complete') {
        await to('COMPLETED');
        const fare = r.fare as { total: number };
        await this.notifications.notify(r.userId, 'ride', 'You have arrived', `Pay ₹${(fare.total / 100).toLocaleString('en-IN')} for ride #${id}`, `/ride/${id}`);
      } else if (action === 'cancel') {
        const { count } = await this.prisma.ride.updateMany({ where: { id, status: r.status, driverId: v.id }, data: { status: 'SEARCHING', driverId: null, driver: null, declinedBy: { push: v.id }, events: withEvent(r.events, 'SEARCHING') } });
        if (!count) throw moved;
        await this.prisma.vendor.update({ where: { id: v.id }, data: { cancelled: { increment: 1 } } });
        await this.notifications.notify(r.userId, 'ride', 'Finding you another driver', `${first} had to cancel. We are looking for a new driver.`, `/ride/${id}`);
        return { ok: true, released: true };
      }
    } else if (kind === 'delivery' || kind === 'kitchen') {
      const o = await this.prisma.foodOrder.findUniqueOrThrow({ where: { id } });
      const to = async (status: string, where: Record<string, unknown>) => {
        const { count } = await this.prisma.foodOrder.updateMany({ where: { id, status: o.status, ...where }, data: { status, events: withEvent(o.events, status) } });
        if (!count) throw moved;
      };
      if (action === 'ready') {
        await this.prisma.foodOrder.update({ where: { id }, data: { readyAt: new Date() } });
        if (o.riderId) {
          const rider = await this.prisma.vendor.findUnique({ where: { id: o.riderId } });
          if (rider?.userId) await this.notifications.notify(rider.userId, 'partner', 'Order is ready', `Pick up #${id} from ${o.restaurantName}`, `/job/delivery/${id}`);
        }
      } else if (action === 'pickup') {
        const kitchenOnApp = await this.prisma.vendor.count({ where: { restaurantId: o.restaurantId, userId: { not: null } } });
        if (kitchenOnApp && !o.readyAt) throw invalid('NOT_READY', 'The kitchen has not marked this order ready yet');
        await to('PICKED_UP', { riderId: v.id });
        await this.notifications.notify(o.userId, 'food', 'Your food is on the way', `${first} picked up your order`, `/food-order/${id}`);
      } else if (action === 'deliver') {
        await to('DELIVERED', { riderId: v.id });
        await this.prisma.$transaction((tx) =>
          this.ledger.post(tx, { type: 'delivery', title: `Delivery #${id}`, ref: id, key: `food:${id}:rider` }, [
            { kind: 'platform_commission', debit: RIDER_PAY },
            { kind: 'vendor_earnings', ownerId: v.id, credit: RIDER_PAY },
          ]),
        );
        await this.prisma.vendor.update({ where: { id: v.id }, data: { jobs: { increment: 1 } } });
        await this.notifications.notify(o.userId, 'food', 'Delivered. Enjoy your meal!', `Order #${id}`, `/food-order/${id}`);
      }
    } else if (kind === 'sos') {
      const s = await this.prisma.sosRequest.findUniqueOrThrow({ where: { id } });
      const to = async (status: string, data: Record<string, unknown> = {}) => {
        const { count } = await this.prisma.sosRequest.updateMany({ where: { id, status: s.status, responderId: v.id }, data: { status, events: withEvent(s.events, status), ...data } });
        if (!count) throw moved;
      };
      if (action === 'en_route') {
        await to('EN_ROUTE');
        await this.notifications.notify(s.userId, 'sos', 'Help is on the way', `${v.businessName ?? v.name} · ${v.vehicle ?? ''} ${v.plate ?? ''}`.trim(), `/sos/${id}`);
      } else if (action === 'arrive') {
        await to('ARRIVED');
        await this.notifications.notify(s.userId, 'sos', 'Help has arrived', `${first} is at your location`, `/sos/${id}`);
      } else if (action === 'resolve') {
        const lines = cleanLines(body.lines);
        const total = lines.reduce((a, l) => a + l.amount, 0);
        await to('RESOLVED', { invoice: { lines, total } });
        await this.prisma.vendor.update({ where: { id: v.id }, data: { jobs: { increment: 1 } } });
        await this.notifications.notify(s.userId, 'sos', 'You are safe', `Pay ₹${(total / 100).toLocaleString('en-IN')} whenever you are ready`, `/sos/${id}`);
      }
    } else if (kind === 'order') {
      const o = await this.prisma.order.findUniqueOrThrow({ where: { id } });
      const to = async (status: string, note: string, data: Record<string, unknown> = {}) => {
        const { count } = await this.prisma.order.updateMany({ where: { id, status: o.status }, data: { status, ...data } });
        if (!count) throw moved;
        await this.prisma.orderEvent.create({ data: { orderId: id, status, note } });
      };
      if (action === 'pack') {
        await to('PACKED', 'Packed by seller');
        await this.notifications.notify(o.userId, 'order', 'Packed by seller', `Order #${id} from ${o.sellerName}`, `/orders/${id}`);
      } else if (action === 'ship') {
        const awb = `BM${digits(10)}`;
        await to('SHIPPED', 'Handed to courier', { courier: 'SwiftShip Logistics', awb });
        await this.notifications.notify(o.userId, 'order', 'Shipped', `Order #${id} · AWB ${awb}`, `/orders/${id}`);
      } else if (action === 'cancel') {
        await this.shop.cancelAndRefund(o, `Cancelled by ${o.sellerName}`);
        await this.prisma.vendor.update({ where: { id: v.id }, data: { cancelled: { increment: 1 } } });
      }
    } else if (kind === 'visit') {
      const e = await this.prisma.enquiry.findUniqueOrThrow({ where: { id }, include: { property: true } });
      let visitAt = e.visitAt;
      if (action === 'reschedule') {
        visitAt = body.visitAt ? new Date(body.visitAt) : null;
        if (!visitAt || isNaN(visitAt.getTime()) || visitAt.getTime() < Date.now() + 3600000) throw invalid('SLOT', 'Pick a time at least an hour from now', 'visitAt');
      }
      const reply = body.note?.trim() || (visitAt ? 'Happy to show you around. See you then.' : 'Thanks for your interest. Happy to help.');
      const { count } = await this.prisma.enquiry.updateMany({ where: { id, status: 'REQUESTED' }, data: { status: 'CONFIRMED', visitAt, reply } });
      if (!count) throw moved;
      const when = visitAt ? visitAt.toLocaleString('en-IN', { ...IST, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : null;
      await this.notifications.notify(e.userId, 'property', when ? (action === 'reschedule' ? 'New visit time proposed' : 'Site visit confirmed') : 'Agent replied', `${v.name}: “${reply}”${when ? ` · ${when}` : ''}`, `/property/${e.propertyId}`);
    }
    return this.job(userId, kind, id);
  }
}
