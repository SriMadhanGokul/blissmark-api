import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { invalid, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { addDays, digits } from '../../common/util';
import { NotificationsService } from '../notifications/notifications.service';
import { UsersService } from '../users/users.service';
import { LedgerService } from '../wallet/ledger.service';

export const FREE_DELIVERY_FROM = 49900;
export const DELIVERY_FEE = 4000;
export type PaymentMethod = 'upi' | 'card' | 'netbanking' | 'wallet' | 'cod';

/** Shipment steps and the demo delay (minutes after placing) at which each one happens. */
const TIMELINE: { status: string; note: string; afterMin: number }[] = [
  { status: 'PLACED', note: 'Order placed', afterMin: 0 },
  { status: 'PACKED', note: 'Packed by seller', afterMin: 2 },
  { status: 'SHIPPED', note: 'Handed to courier', afterMin: 5 },
  { status: 'OUT_FOR_DELIVERY', note: 'Out for delivery', afterMin: 9 },
  { status: 'DELIVERED', note: 'Delivered', afterMin: 14 },
];

@Injectable()
export class ShopService {
  constructor(
    private prisma: PrismaService,
    private ledger: LedgerService,
    private users: UsersService,
    private notifications: NotificationsService,
  ) {}

  /* ---------------- catalog ---------------- */

  categories() {
    return this.prisma.category.findMany({ orderBy: { sort: 'asc' } });
  }

  products(q: { category?: string; q?: string; sort?: string; trending?: string }) {
    const orderBy: Prisma.ProductOrderByWithRelationInput =
      q.sort === 'price_asc' ? { price: 'asc' } : q.sort === 'price_desc' ? { price: 'desc' } : q.sort === 'rating' ? { rating: 'desc' } : { reviews: 'desc' };
    return this.prisma.product.findMany({
      where: {
        ...(q.category ? { categoryId: q.category } : {}),
        ...(q.trending ? { trending: true } : {}),
        ...(q.q ? { OR: [{ title: { contains: q.q, mode: 'insensitive' } }, { brand: { contains: q.q, mode: 'insensitive' } }] } : {}),
      },
      include: { seller: true },
      orderBy,
    });
  }

  async product(id: string) {
    const p = await this.prisma.product.findUnique({ where: { id }, include: { seller: true, category: true } });
    if (!p) throw notFound('Product');
    const similar = await this.prisma.product.findMany({ where: { categoryId: p.categoryId, id: { not: id } }, take: 6 });
    return { ...p, similar };
  }

  /* ---------------- cart ---------------- */

  async cart(userId: string) {
    const [items, user] = await Promise.all([
      this.prisma.cartItem.findMany({ where: { userId }, include: { product: { include: { seller: true } } }, orderBy: { id: 'asc' } }),
      this.prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    ]);
    const lines = items.map((i) => ({
      id: i.id,
      productId: i.productId,
      title: i.product.title,
      photo: i.product.photos[0],
      colour: i.colour,
      seller: i.product.seller.name,
      price: i.product.price,
      mrp: i.product.mrp,
      qty: i.qty,
    }));
    const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
    let discount = 0;
    let coupon: { code: string; description: string } | null = null;
    if (user.coupon) {
      const c = await this.prisma.coupon.findUnique({ where: { code: user.coupon } });
      if (c && c.active && subtotal >= c.minOrder) {
        discount = Math.min(Math.round((subtotal * c.percent) / 10000) * 100, c.maxDiscount); // whole rupees
        coupon = { code: c.code, description: c.description };
      }
    }
    const delivery = subtotal === 0 || subtotal - discount >= FREE_DELIVERY_FROM ? 0 : DELIVERY_FEE;
    return { items: lines, count: lines.reduce((s, l) => s + l.qty, 0), subtotal, discount, coupon, delivery, total: subtotal - discount + delivery };
  }

  async addToCart(userId: string, productId: string, colour: string | undefined, qty = 1) {
    const p = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!p) throw notFound('Product');
    const existing = await this.prisma.cartItem.findFirst({ where: { userId, productId, colour: colour ?? null } });
    if (existing) await this.prisma.cartItem.update({ where: { id: existing.id }, data: { qty: Math.min(10, existing.qty + qty) } });
    else await this.prisma.cartItem.create({ data: { userId, productId, colour: colour ?? null, qty } });
    return this.cart(userId);
  }

  async setQty(userId: string, itemId: string, qty: number) {
    const item = await this.prisma.cartItem.findFirst({ where: { id: itemId, userId } });
    if (!item) throw notFound('Cart item');
    if (qty <= 0) await this.prisma.cartItem.delete({ where: { id: itemId } });
    else await this.prisma.cartItem.update({ where: { id: itemId }, data: { qty: Math.min(10, qty) } });
    return this.cart(userId);
  }

  async applyCoupon(userId: string, raw: string) {
    const c = await this.prisma.coupon.findUnique({ where: { code: raw.trim().toUpperCase() } });
    if (!c || !c.active || c.vertical !== 'shopping') throw invalid('COUPON_INVALID', 'This coupon is not valid for shopping', 'code');
    const { subtotal } = await this.cart(userId);
    if (subtotal < c.minOrder) throw invalid('COUPON_MIN', `Add items worth ₹${(c.minOrder - subtotal) / 100} more to use this coupon`, 'code');
    await this.prisma.user.update({ where: { id: userId }, data: { coupon: c.code } });
    return this.cart(userId);
  }

  async removeCoupon(userId: string) {
    await this.prisma.user.update({ where: { id: userId }, data: { coupon: null } });
    return this.cart(userId);
  }

  /* ---------------- checkout ---------------- */

  /**
   * Splits the cart into one order per seller (docs 12.1), takes payment, clears the cart.
   * Online methods go through a mock gateway until Razorpay keys are configured.
   */
  async checkout(userId: string, addressId: string, method: PaymentMethod) {
    const cart = await this.cart(userId);
    if (!cart.items.length) throw invalid('CART_EMPTY', 'Your cart is empty');
    const address = await this.prisma.address.findFirst({ where: { id: addressId, userId } });
    if (!address) throw invalid('ADDRESS', 'Choose a delivery address', 'address');
    if (method === 'cod' && cart.total > 1000000) throw invalid('COD_LIMIT', 'Cash on delivery is available up to ₹10,000', 'payment');

    const bySeller = new Map<string, typeof cart.items>();
    cart.items.forEach((i) => bySeller.set(i.seller, [...(bySeller.get(i.seller) ?? []), i]));

    const orders = await this.prisma.$transaction(async (tx) => {
      if (method === 'wallet') {
        const lines = await this.ledger.spendLines(tx, userId, cart.total);
        if (!lines.length) throw invalid('WALLET_LOW', 'Your wallet balance is not enough for this order', 'payment');
      }
      const created = [];
      let remainingDiscount = cart.discount;
      const sellers = [...bySeller.entries()];
      for (const [idx, [seller, items]] of sellers.entries()) {
        const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
        const discount = idx === sellers.length - 1 ? remainingDiscount : Math.round((cart.discount * subtotal) / cart.subtotal);
        remainingDiscount -= discount;
        const deliveryFee = idx === 0 ? cart.delivery : 0;
        const total = subtotal - discount + deliveryFee;
        const id = `BM${digits(5)}`;
        const order = await tx.order.create({
          data: {
            id,
            userId,
            sellerName: seller,
            status: 'PLACED',
            items: items.map(({ productId, title, photo, colour, price, qty }) => ({ productId, title, photo, colour, price, qty })),
            address: { label: address.label, line1: address.line1, city: address.city, pincode: address.pincode },
            subtotal,
            discount,
            deliveryFee,
            total,
            paymentMethod: method,
            courier: 'SwiftShip Logistics',
            awb: `EL${digits(10)}`,
            expectedAt: addDays(new Date(), 3),
            events: { create: { status: 'PLACED', note: 'Order placed' } },
          },
        });
        if (method !== 'cod') {
          const source = method === 'wallet' ? await this.ledger.spendLines(tx, userId, total) : [{ kind: 'gateway_clearing' as const, debit: total }];
          await this.ledger.post(tx, { type: 'order', title: `Order ${id}`, ref: id, key: `order:${id}:pay` }, [
            ...source,
            { kind: 'vendor_earnings', ownerId: `seller:${seller}`, credit: total },
          ]);
        }
        await this.notifications.notify(userId, 'order', 'Order placed', `${items.length} item(s) from ${seller} · #${id}`, `/orders/${id}`, tx);
        created.push(order);
      }
      await tx.cartItem.deleteMany({ where: { userId } });
      await tx.user.update({ where: { id: userId }, data: { coupon: null } });
      return created;
    });
    return { orders: orders.map((o) => ({ id: o.id, total: o.total, expectedAt: o.expectedAt })), total: cart.total, method };
  }

  /* ---------------- orders ---------------- */

  /** Advances the demo timeline: writes any shipment events whose time has come. */
  private async advance(orderId: string) {
    const o = await this.prisma.order.findUnique({ where: { id: orderId }, include: { events: true } });
    if (!o || o.status === 'CANCELLED' || o.status === 'DELIVERED') return;
    const elapsedMin = (Date.now() - o.placedAt.getTime()) / 60000;
    const due = TIMELINE.filter((t) => t.afterMin <= elapsedMin && !o.events.some((e) => e.status === t.status));
    for (const t of due) {
      await this.prisma.orderEvent.create({ data: { orderId, status: t.status, note: t.note, at: new Date(o.placedAt.getTime() + t.afterMin * 60000) } });
      if (t.status === 'OUT_FOR_DELIVERY' || t.status === 'DELIVERED') {
        await this.notifications.notify(o.userId, 'order', t.note, `Order #${o.id} from ${o.sellerName}`, `/orders/${o.id}`);
      }
    }
    if (due.length) await this.prisma.order.update({ where: { id: orderId }, data: { status: due[due.length - 1].status } });
  }

  async orders(userId: string) {
    const ids = await this.prisma.order.findMany({ where: { userId }, select: { id: true } });
    await Promise.all(ids.map((o) => this.advance(o.id)));
    return this.prisma.order.findMany({ where: { userId }, orderBy: { placedAt: 'desc' } });
  }

  async order(userId: string, id: string) {
    await this.advance(id);
    const o = await this.prisma.order.findFirst({ where: { id, userId }, include: { events: { orderBy: { at: 'asc' } } } });
    if (!o) throw notFound('Order');
    const steps = TIMELINE.map((t) => {
      const e = o.events.find((ev) => ev.status === t.status);
      return { status: t.status, label: t.note, at: e?.at ?? null, done: !!e };
    });
    return { ...o, steps };
  }

  async cancel(userId: string, id: string) {
    const o = await this.order(userId, id);
    if (!['PLACED', 'PACKED'].includes(o.status)) throw invalid('CANNOT_CANCEL', 'This order has already shipped and cannot be cancelled');
    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id }, data: { status: 'CANCELLED', events: { create: { status: 'CANCELLED', note: 'Cancelled by you' } } } });
      if (o.paymentMethod !== 'cod') {
        await this.ledger.post(tx, { type: 'refund', title: `Refund: order ${id}`, ref: id, key: `order:${id}:refund` }, [
          { kind: 'vendor_earnings', ownerId: `seller:${o.sellerName}`, debit: o.total },
          { kind: 'wallet_withdrawable', ownerId: userId, credit: o.total },
        ]);
      }
      await this.notifications.notify(userId, 'order', 'Order cancelled', o.paymentMethod === 'cod' ? `#${id} was cancelled` : `₹${o.total / 100} refunded to your wallet`, '/wallet', tx);
    });
    return this.order(userId, id);
  }

  async defaultAddress(userId: string) {
    return this.users.defaultAddress(userId);
  }
}
