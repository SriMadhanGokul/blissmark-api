import { Injectable } from '@nestjs/common';

import { invalid, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { digits } from '../../common/util';
import { NotificationsService } from '../notifications/notifications.service';
import { LedgerService } from '../wallet/ledger.service';

export type Place = { label: string; line1: string; lat: number; lng: number };

/** Popular pickup/drop points in Jaipur (until Google Places autocomplete is wired). */
export const PLACES: Place[] = [
  { label: 'Jaipur Junction', line1: 'Railway Station, Gopalbari', lat: 26.9196, lng: 75.7878 },
  { label: 'Jaipur Airport', line1: 'Sanganer, Terminal 2', lat: 26.8242, lng: 75.8122 },
  { label: 'World Trade Park', line1: 'JLN Marg, Malviya Nagar', lat: 26.8535, lng: 75.8047 },
  { label: 'Hawa Mahal', line1: 'Badi Choupad, Pink City', lat: 26.9239, lng: 75.8267 },
  { label: 'SMS Hospital', line1: 'JLN Marg, Ashok Nagar', lat: 26.9047, lng: 75.8148 },
  { label: 'Vaishali Nagar', line1: 'Amrapali Circle', lat: 26.9124, lng: 75.7395 },
  { label: 'Mansarovar', line1: 'Shipra Path', lat: 26.8505, lng: 75.7628 },
];

/** Fare card per vehicle (paise). Fare = base + per km + per minute, rounded to whole rupees. */
export const VEHICLES = [
  { id: 'bike', label: 'Bike', seats: 1, base: 2500, perKm: 800, perMin: 100, etaMin: 3 },
  { id: 'auto', label: 'Auto', seats: 3, base: 3000, perKm: 1200, perMin: 150, etaMin: 4 },
  { id: 'mini', label: 'Mini', seats: 4, base: 5000, perKm: 1400, perMin: 200, etaMin: 5 },
  { id: 'sedan', label: 'Sedan', seats: 4, base: 7000, perKm: 1800, perMin: 250, etaMin: 6 },
] as const;

const ACTIVE = ['SEARCHING', 'ACCEPTED', 'ARRIVING', 'ON_TRIP'];
/** Simulated driver: seconds after the last step until the next one. */
const SIM: Record<string, { next: string; afterS: number }> = {
  SEARCHING: { next: 'ACCEPTED', afterS: 6 },
  ACCEPTED: { next: 'ARRIVING', afterS: 6 },
  ARRIVING: { next: 'ON_TRIP', afterS: 20 },
  ON_TRIP: { next: 'COMPLETED', afterS: 25 },
};

const km = (a: Place, b: Place) => {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h)) * 1.3; // road factor over straight line
};
const rupee = (p: number) => Math.round(p / 100) * 100;

@Injectable()
export class RidesService {
  constructor(
    private prisma: PrismaService,
    private ledger: LedgerService,
    private notifications: NotificationsService,
  ) {}

  async places(userId: string) {
    const saved = await this.prisma.address.findMany({ where: { userId } });
    return [
      ...saved.filter((a) => a.lat != null && a.lng != null).map((a) => ({ label: a.label, line1: `${a.line1}, ${a.city}`, lat: a.lat!, lng: a.lng!, saved: true })),
      ...PLACES.map((p) => ({ ...p, saved: false })),
    ];
  }

  private check(p: Place, name: string) {
    if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number' || !p.label) throw invalid('PLACE', `Choose a ${name} location`, name);
  }

  estimate(pickup: Place, drop: Place) {
    this.check(pickup, 'pickup');
    this.check(drop, 'drop');
    const distanceKm = Math.max(1, Math.round(km(pickup, drop) * 10) / 10);
    if (distanceKm < 1.05 && pickup.label === drop.label) throw invalid('SAME_PLACE', 'Pickup and drop cannot be the same', 'drop');
    const durationMin = Math.max(5, Math.round((distanceKm / 22) * 60));
    return {
      distanceKm,
      durationMin,
      options: VEHICLES.map((v) => {
        const distance = rupee(v.perKm * distanceKm);
        const time = rupee(v.perMin * durationMin);
        return { vehicle: v.id, label: v.label, seats: v.seats, etaMin: v.etaMin, fare: { base: v.base, distance, time, total: v.base + distance + time } };
      }),
    };
  }

  async create(userId: string, b: { pickup: Place; drop: Place; vehicle: string; paymentMethod: string }) {
    const est = this.estimate(b.pickup, b.drop);
    const opt = est.options.find((o) => o.vehicle === b.vehicle);
    if (!opt) throw invalid('VEHICLE', 'Choose a vehicle', 'vehicle');
    if (await this.prisma.ride.count({ where: { userId, status: { in: ACTIVE } } })) throw invalid('ACTIVE_RIDE', 'You already have a ride in progress');
    const id = `CB${digits(5)}`;
    await this.prisma.ride.create({
      data: {
        id,
        userId,
        vehicle: b.vehicle,
        pickup: b.pickup,
        drop: b.drop,
        distanceKm: est.distanceKm,
        durationMin: est.durationMin,
        fare: opt.fare,
        status: 'SEARCHING',
        otp: digits(4),
        paymentMethod: b.paymentMethod,
        events: [{ status: 'SEARCHING', at: new Date() }],
      },
    });
    return this.get(userId, id);
  }

  /** Moves to `status`. With `from`, only if it is still in that status (two polls can race); returns whether it moved. */
  private async step(id: string, status: string, data: Record<string, unknown> = {}, from?: string) {
    const r = await this.prisma.ride.findUniqueOrThrow({ where: { id } });
    if (from && r.status !== from) return false;
    const events = [...((r.events as { status: string; at: string }[]) ?? []), { status, at: new Date() }];
    const { count } = await this.prisma.ride.updateMany({ where: { id, ...(from ? { status: from } : {}) }, data: { status, events, ...data } });
    return count > 0;
  }

  private async simulate(id: string) {
    const r = await this.prisma.ride.findUnique({ where: { id } });
    const rule = r && SIM[r.status];
    if (!r || !rule || (Date.now() - r.updatedAt.getTime()) / 1000 < rule.afterS) return;
    if (r.status === 'SEARCHING') {
      const d = await this.prisma.vendor.findFirst({ where: { services: { has: `cab:${r.vehicle}` }, online: true }, orderBy: { rating: 'desc' } });
      if (!d) return;
      if (!(await this.step(id, 'ACCEPTED', { driver: { name: d.name, photo: d.photo, rating: d.rating, vehicle: d.vehicle, plate: d.plate, trips: d.jobs } }, r.status))) return;
      await this.notifications.notify(r.userId, 'ride', `${d.name.split(' ')[0]} is coming to pick you up`, `${d.vehicle} · ${d.plate} · OTP ${r.otp}`, `/ride/${id}`);
    } else {
      if (!(await this.step(id, rule.next, {}, r.status))) return;
      if (rule.next === 'COMPLETED') {
        const fare = r.fare as { total: number };
        await this.notifications.notify(r.userId, 'ride', 'You have arrived', `Pay ₹${(fare.total / 100).toLocaleString('en-IN')} for ride #${id}`, `/ride/${id}`);
      }
    }
  }

  async list(userId: string) {
    return this.prisma.ride.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  }

  async get(userId: string, id: string) {
    await this.simulate(id);
    const r = await this.prisma.ride.findFirst({ where: { id, userId } });
    if (!r) throw notFound('Ride');
    const pickupEta = r.status === 'ACCEPTED' ? 5 : r.status === 'ARRIVING' ? 2 : null;
    return { ...r, pickupEta };
  }

  async active(userId: string) {
    const r = await this.prisma.ride.findFirst({ where: { userId, status: { in: [...ACTIVE, 'COMPLETED'] } }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    return r ? this.get(userId, r.id) : null;
  }

  async cancel(userId: string, id: string) {
    const r = await this.get(userId, id);
    if (!['SEARCHING', 'ACCEPTED', 'ARRIVING'].includes(r.status)) throw invalid('CANNOT_CANCEL', 'The trip has started and cannot be cancelled');
    await this.step(id, 'CANCELLED');
    return this.get(userId, id);
  }

  async pay(userId: string, id: string, method: 'upi' | 'card' | 'wallet' | 'cash') {
    const r = await this.get(userId, id);
    if (r.status !== 'COMPLETED') throw invalid('NOT_PAYABLE', 'You can pay when the trip ends');
    const total = (r.fare as { total: number }).total;
    await this.prisma.$transaction(async (tx) => {
      if (method !== 'cash') {
        const source = method === 'wallet' ? await this.ledger.spendLines(tx, userId, total) : [{ kind: 'gateway_clearing' as const, debit: total }];
        if (!source.length) throw invalid('WALLET_LOW', 'Your wallet balance is not enough', 'payment');
        const commission = Math.round(total * 0.15);
        await this.ledger.post(tx, { type: 'ride', title: 'Cab ride', ref: id, key: `ride:${id}:pay` }, [
          ...source,
          { kind: 'vendor_earnings', ownerId: `driver:${(r.driver as { name?: string } | null)?.name ?? 'unknown'}`, credit: total - commission },
          { kind: 'platform_commission', credit: commission },
        ]);
      }
    });
    await this.step(id, 'PAID', { paymentMethod: method });
    return this.get(userId, id);
  }

  async rate(userId: string, id: string, rating: number) {
    const r = await this.get(userId, id);
    if (r.status !== 'PAID') throw invalid('NOT_RATEABLE', 'You can rate after paying');
    await this.prisma.ride.update({ where: { id }, data: { rating } });
    return this.get(userId, id);
  }
}
