import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../common/prisma.service';

export type NotificationKind = 'order' | 'booking' | 'payout' | 'wallet' | 'offer' | 'account' | 'ride' | 'food' | 'sos' | 'property' | 'partner';

/** In-app inbox. Push (FCM), SMS and WhatsApp fan-out plug in here later. */
@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService) {}

  notify(userId: string, kind: NotificationKind, title: string, body: string, link?: string, tx: Prisma.TransactionClient = this.prisma) {
    return tx.notification.create({ data: { userId, kind, title, body, link } });
  }

  /** A vendor is also a member: the customer inbox leaves out vendor-app alerts and vice versa. */
  private scope(partner: boolean): Prisma.NotificationWhereInput {
    return partner ? { kind: 'partner' } : { kind: { not: 'partner' } };
  }

  list(userId: string, partner = false) {
    return this.prisma.notification.findMany({ where: { userId, ...this.scope(partner) }, orderBy: { createdAt: 'desc' }, take: 50 });
  }

  unread(userId: string, partner = false) {
    return this.prisma.notification.count({ where: { userId, readAt: null, ...this.scope(partner) } });
  }

  async markRead(userId: string, ids?: string[], partner = false) {
    await this.prisma.notification.updateMany({ where: { userId, readAt: null, ...this.scope(partner), ...(ids?.length ? { id: { in: ids } } : {}) }, data: { readAt: new Date() } });
    return { ok: true };
  }
}
