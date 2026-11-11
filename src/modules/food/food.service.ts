import { Injectable } from '@nestjs/common';

import { invalid, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { digits } from '../../common/util';
import { NotificationsService } from '../notifications/notifications.service';
import { APP_PRIORITY_S, SIM_VENDOR, alertOwner, alertVendors, appVendorsOnline, isAppVendor } from '../partner/dispatch';
import { SettingsService } from '../admin/settings.service';
import { LedgerService } from '../wallet/ledger.service';

const TAX_PCT = 5;
const DELIVERY_FEE = 3000;
const FREE_DELIVERY_FROM = 49900;
/** Flat payout to a delivery partner per completed drop, paid from platform commission. */
export const RIDER_PAY = 4000;
const ACTIVE = ['PLACED', 'PREPARING', 'RIDER_ASSIGNED', 'PICKED_UP'];
/** Simulated kitchen and rider. Scheduled orders start preparing 30 min before the slot. */
const SIM: Record<string, { next: string; afterS: number }> = {
  PLACED: { next: 'PREPARING', afterS: 8 },
  PREPARING: { next: 'RIDER_ASSIGNED', afterS: 15 },
  RIDER_ASSIGNED: { next: 'PICKED_UP', afterS: 15 },
  PICKED_UP: { next: 'DELIVERED', afterS: 25 },
};
const NOTE: Record<string, string> = {
  PREPARING: 'is preparing your order',
  RIDER_ASSIGNED: 'Rider assigned to your order',
  PICKED_UP: 'Your food is on the way',
  DELIVERED: 'Delivered. Enjoy your meal!',
};

@Injectable()
export class FoodService {
  constructor(
    private prisma: PrismaService,
    private ledger: LedgerService,
    private notifications: NotificationsService,
    private settings: SettingsService,
  ) {}

  restaurants(kind?: string, q?: string) {
    return this.prisma.restaurant.findMany({
      where: { ...(kind ? { kind } : {}), ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { cuisine: { contains: q, mode: 'insensitive' } }] } : {}) },
      orderBy: { sort: 'asc' },
    });
  }

  async restaurant(id: string) {
    const r = await this.prisma.restaurant.findUnique({ where: { id }, include: { menu: { where: { available: true } } } });
    if (!r) throw notFound('Restaurant');
    return r;
  }

  async place(
    userId: string,
    b: { restaurantId: string; items: { menuItemId: string; qty: number }[]; addressId: string; paymentMethod: 'upi' | 'card' | 'wallet'; scheduledAt?: string },
  ) {
    const r = await this.restaurant(b.restaurantId);
    if (!r.open) throw invalid('CLOSED', `${r.name} is closed right now`);
    if (!b.items?.length) throw invalid('EMPTY', 'Add at least one item');
    const address = await this.prisma.address.findFirst({ where: { id: b.addressId, userId } });
    if (!address) throw invalid('ADDRESS', 'Choose a delivery address', 'address');
    let scheduledAt: Date | undefined;
    if (b.scheduledAt) {
      scheduledAt = new Date(b.scheduledAt);
      if (isNaN(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now() + 45 * 60 * 1000) throw invalid('SLOT', 'Schedule at least 45 minutes ahead', 'scheduledAt');
      if (scheduledAt.getTime() > Date.now() + 3 * 86400000) throw invalid('SLOT', 'You can schedule up to 3 days ahead', 'scheduledAt');
    }
    const lines = b.items.map((i) => {
      const m = r.menu.find((x) => x.id === i.menuItemId);
      if (!m) throw invalid('ITEM', 'An item is no longer available');
      const qty = Math.max(1, Math.min(20, Math.floor(i.qty)));
      return { menuItemId: m.id, name: m.name, veg: m.veg, price: m.price, qty };
    });
    const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
    const taxes = Math.round((subtotal * TAX_PCT) / 10000) * 100;
    const deliveryFee = subtotal >= FREE_DELIVERY_FROM ? 0 : DELIVERY_FEE;
    const total = subtotal + taxes + deliveryFee;
    const id = `FD${digits(5)}`;
    const kitchen = await this.prisma.vendor.findFirst({ where: { restaurantId: r.id } });
    const commission = await this.settings.commissionOn(kitchen ?? { category: 'restaurant', commissionPct: null }, subtotal);

    await this.prisma.$transaction(async (tx) => {
      const source = b.paymentMethod === 'wallet' ? await this.ledger.spendLines(tx, userId, total) : [{ kind: 'gateway_clearing' as const, debit: total }];
      if (!source.length) throw invalid('WALLET_LOW', 'Your wallet balance is not enough', 'payment');
      await tx.foodOrder.create({
        data: {
          id,
          userId,
          restaurantId: r.id,
          restaurantName: r.name,
          kind: r.kind,
          items: lines,
          subtotal,
          taxes,
          deliveryFee,
          total,
          commission,
          paymentMethod: b.paymentMethod,
          address: { label: address.label, line1: address.line1, city: address.city, pincode: address.pincode },
          scheduledAt,
          status: 'PLACED',
          events: [{ status: 'PLACED', at: new Date() }],
        },
      });
      await this.ledger.post(tx, { type: 'food', title: r.name, ref: id, key: `food:${id}:pay` }, [
        ...source,
        { kind: 'vendor_earnings', ownerId: `restaurant:${r.id}`, credit: total - commission },
        { kind: 'platform_commission', credit: commission },
      ]);
      await this.notifications.notify(userId, 'food', 'Order placed', `${r.name} · #${id}${scheduledAt ? ' · scheduled' : ''}`, `/food-order/${id}`, tx);
    });
    await alertOwner(this.prisma, this.notifications, { restaurantId: r.id }, 'New order', `#${id} · ${lines.length} item(s) · ₹${total / 100}`, '/offers');
    return this.get(userId, id);
  }

  /** Moves to `status`. With `from`, only if it is still in that status (two polls can race); returns whether it moved. */
  private async step(id: string, status: string, data: Record<string, unknown> = {}, from?: string) {
    const o = await this.prisma.foodOrder.findUniqueOrThrow({ where: { id } });
    if (from && o.status !== from) return false;
    const events = [...((o.events as { status: string; at: string }[]) ?? []), { status, at: new Date() }];
    const { count } = await this.prisma.foodOrder.updateMany({ where: { id, ...(from ? { status: from } : {}) }, data: { status, events, ...data } });
    return count > 0;
  }

  private async simulate(id: string) {
    const o = await this.prisma.foodOrder.findUnique({ where: { id } });
    const rule = o && SIM[o.status];
    if (!o || !rule || (await isAppVendor(this.prisma, o.riderId))) return; // a real rider reports pickup and drop
    // a kitchen on the vendor app accepts orders and marks them ready itself
    const appKitchen = await this.prisma.vendor.count({ where: { restaurantId: o.restaurantId, userId: { not: null } } });
    if (appKitchen && (o.status === 'PLACED' || (o.status === 'PREPARING' && !o.readyAt))) return;
    const since = o.status === 'PREPARING' && o.readyAt ? o.readyAt : o.updatedAt;
    const wait = o.status === 'PREPARING' && (await appVendorsOnline(this.prisma, 'rider')) ? APP_PRIORITY_S : rule.afterS;
    if ((Date.now() - since.getTime()) / 1000 < wait) return;
    if (o.status === 'PLACED' && o.scheduledAt && Date.now() < o.scheduledAt.getTime() - 30 * 60 * 1000) return;
    if (rule.next === 'RIDER_ASSIGNED') {
      const v = await this.prisma.vendor.findFirst({ where: { ...SIM_VENDOR, services: { has: 'rider' }, online: true }, orderBy: { rating: 'desc' } });
      if (!(await this.step(id, rule.next, { riderId: v?.id, rider: v ? { name: v.name, photo: v.photo, rating: v.rating, vehicle: v.vehicle, plate: v.plate } : null }, o.status))) return;
    } else if (!(await this.step(id, rule.next, {}, o.status))) return;
    if (rule.next === 'PREPARING') await this.alertRiders(o.restaurantName, id);
    const note = NOTE[rule.next];
    if (note) await this.notifications.notify(o.userId, 'food', rule.next === 'PREPARING' ? `${o.restaurantName} ${note}` : note, `Order #${id}`, `/food-order/${id}`);
  }

  /** Offers a freshly accepted order to delivery partners on the vendor app. */
  alertRiders(restaurantName: string, id: string) {
    return alertVendors(this.prisma, this.notifications, 'rider', 'New delivery nearby', `Pick up from ${restaurantName} · #${id}`);
  }

  async list(userId: string) {
    return this.prisma.foodOrder.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  }

  async get(userId: string, id: string) {
    await this.simulate(id);
    const o = await this.prisma.foodOrder.findFirst({ where: { id, userId } });
    if (!o) throw notFound('Order');
    const etaMin = o.status === 'PICKED_UP' ? 12 : o.status === 'RIDER_ASSIGNED' ? 22 : o.status === 'PREPARING' ? 30 : null;
    return { ...o, etaMin };
  }

  async active(userId: string) {
    const o = await this.prisma.foodOrder.findFirst({ where: { userId, status: { in: ACTIVE } }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    return o ? this.get(userId, o.id) : null;
  }

  async cancel(userId: string, id: string) {
    const o = await this.get(userId, id);
    if (o.status !== 'PLACED') throw invalid('CANNOT_CANCEL', 'The kitchen has started preparing your food');
    await this.refund(o, 'Order cancelled');
    return this.get(userId, id);
  }

  /** Cancels a placed order and returns the money to the customer's wallet (customer or kitchen). */
  async refund(o: { id: string; userId: string; restaurantId: string; restaurantName: string; total: number; subtotal: number; commission?: number | null }, title: string) {
    const { id, userId } = o;
    const commission = o.commission ?? Math.round(o.subtotal * 0.15); // orders before configurable commission used 15%
    await this.prisma.$transaction(async (tx) => {
      await this.ledger.post(tx, { type: 'refund', title: `Refund: ${o.restaurantName}`, ref: id, key: `food:${id}:refund` }, [
        { kind: 'vendor_earnings', ownerId: `restaurant:${o.restaurantId}`, debit: o.total - commission },
        { kind: 'platform_commission', debit: commission },
        { kind: 'wallet_withdrawable', ownerId: userId, credit: o.total },
      ]);
    });
    await this.step(id, 'CANCELLED');
    await this.notifications.notify(userId, 'food', title, `₹${o.total / 100} refunded to your wallet`, '/wallet');
  }
}
