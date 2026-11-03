import { Injectable } from '@nestjs/common';

import { PrismaService } from '../common/prisma.service';
import { BookingsService } from './bookings/bookings.service';
import { FoodService } from './food/food.service';
import { RidesService } from './rides/rides.service';
import { SosService } from './sos/sos.service';

export type ActivityItem = {
  kind: 'booking' | 'ride' | 'food' | 'sos';
  id: string;
  title: string;
  subtitle: string;
  status: string;
  tone: 'brand' | 'warning' | 'success' | 'danger';
  label: string;
  amount: number | null;
  photo: string | null;
  createdAt: Date;
  active: boolean;
  step: 0 | 1 | 2 | 3;
};

const DONE = ['PAID', 'CLOSED', 'DELIVERED', 'CANCELLED'];
const LABEL: Record<string, [string, ActivityItem['tone']]> = {
  BROADCASTING: ['Finding a pro', 'warning'],
  ACCEPTED: ['Accepted', 'brand'],
  EN_ROUTE: ['On the way', 'brand'],
  STARTED: ['In progress', 'brand'],
  QUOTE_SENT: ['Estimate ready', 'warning'],
  QUOTE_APPROVED: ['In progress', 'brand'],
  COMPLETED: ['Pay now', 'warning'],
  INVOICED: ['Pay now', 'warning'],
  PAID: ['Paid', 'success'],
  CLOSED: ['Completed', 'success'],
  CANCELLED: ['Cancelled', 'danger'],
  SEARCHING: ['Finding a driver', 'warning'],
  ARRIVING: ['Driver arriving', 'brand'],
  ON_TRIP: ['On trip', 'brand'],
  PLACED: ['Placed', 'brand'],
  PREPARING: ['Preparing', 'brand'],
  RIDER_ASSIGNED: ['Rider assigned', 'brand'],
  PICKED_UP: ['On the way', 'brand'],
  DELIVERED: ['Delivered', 'success'],
  ALERTED: ['Alerting help', 'danger'],
  RESPONDER_ASSIGNED: ['Help assigned', 'danger'],
  ARRIVED: ['Help arrived', 'brand'],
  RESOLVED: ['Pay now', 'warning'],
};
const STEP: Record<string, 0 | 1 | 2 | 3> = {
  BROADCASTING: 0, ACCEPTED: 0, SEARCHING: 0, ALERTED: 0, PLACED: 0,
  EN_ROUTE: 1, ARRIVING: 1, RESPONDER_ASSIGNED: 1, PREPARING: 1, RIDER_ASSIGNED: 1,
  STARTED: 2, QUOTE_SENT: 2, QUOTE_APPROVED: 2, ON_TRIP: 2, ARRIVED: 2, PICKED_UP: 2,
  COMPLETED: 3, INVOICED: 3, RESOLVED: 3,
};

const IMG = {
  cab: 'https://images.unsplash.com/photo-1449965408869-eaa3f722e40d?w=300&q=70',
  highway: 'https://images.unsplash.com/photo-1600320254374-ce2d293c324e?w=300&q=70',
  health: 'https://images.unsplash.com/photo-1587745416684-47953f16f02f?w=300&q=70',
};

/** One feed across bookings, rides, food and SOS, newest first. Also drives Home's live card. */
@Injectable()
export class ActivityService {
  constructor(
    private prisma: PrismaService,
    private bookings: BookingsService,
    private rides: RidesService,
    private food: FoodService,
    private sos: SosService,
  ) {}

  async feed(userId: string): Promise<ActivityItem[]> {
    // advance anything live first so the feed is current
    await Promise.all([this.bookings.list(userId), this.rides.active(userId), this.food.active(userId), this.sos.active(userId)]);
    const [bookings, rides, foods, sos] = await Promise.all([
      this.prisma.booking.findMany({ where: { userId }, include: { service: true, vendor: true } }),
      this.prisma.ride.findMany({ where: { userId } }),
      this.prisma.foodOrder.findMany({ where: { userId }, include: { user: false } }),
      this.prisma.sosRequest.findMany({ where: { userId } }),
    ]);
    const restaurants = await this.prisma.restaurant.findMany({ where: { id: { in: foods.map((f) => f.restaurantId) } }, select: { id: true, photo: true } });
    const item = (kind: ActivityItem['kind'], id: string, title: string, subtitle: string, status: string, amount: number | null, photo: string | null, createdAt: Date): ActivityItem => {
      const [label, tone] = LABEL[status] ?? [status, 'brand'];
      return { kind, id, title, subtitle, status, label, tone, amount, photo, createdAt, active: !DONE.includes(status), step: STEP[status] ?? 3 };
    };
    return [
      ...bookings.map((b) => item('booking', b.id, b.service.label, `${b.issue} · ${b.vendor?.name ?? `${b.notified} pros notified`}`, b.status, (b.invoice as { total?: number } | null)?.total ?? null, b.service.photo, b.createdAt)),
      ...rides.map((r) => item('ride', r.id, `${r.vehicle[0].toUpperCase()}${r.vehicle.slice(1)} ride`, `${(r.pickup as { label: string }).label} → ${(r.drop as { label: string }).label}`, r.status, (r.fare as { total: number }).total, IMG.cab, r.createdAt)),
      ...foods.map((f) => item('food', f.id, f.restaurantName, `${(f.items as unknown[]).length} item(s)${f.kind === 'kitchen' ? ' · cloud kitchen' : ''}`, f.status, f.total, restaurants.find((r) => r.id === f.restaurantId)?.photo ?? null, f.createdAt)),
      ...sos.map((s) => item('sos', s.id, s.type === 'health' ? 'Health SOS' : 'Highway SOS', s.issue, s.status, (s.invoice as { total?: number } | null)?.total ?? null, s.type === 'health' ? IMG.health : IMG.highway, s.createdAt)),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async live(userId: string) {
    const all = await this.feed(userId);
    // emergencies always win the Home live card
    return all.find((a) => a.active && a.kind === 'sos') ?? all.find((a) => a.active) ?? null;
  }
}
