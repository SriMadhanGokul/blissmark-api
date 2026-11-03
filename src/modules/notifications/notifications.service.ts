import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../common/prisma.service';

export type NotificationKind = 'order' | 'booking' | 'payout' | 'wallet' | 'offer' | 'account' | 'ride' | 'food' | 'sos' | 'property';

/** In-app inbox. Push (FCM), SMS and WhatsApp fan-out plug in here later. */
@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService) {}

  notify(userId: string, kind: NotificationKind, title: string, body: string, link?: string, tx: Prisma.TransactionClient = this.prisma) {
    return tx.notification.create({ data: { userId, kind, title, body, link } });
  }

  list(userId: string) {
    return this.prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 50 });
  }

  unread(userId: string) {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }

  async markRead(userId: string, ids?: string[]) {
    await this.prisma.notification.updateMany({ where: { userId, readAt: null, ...(ids?.length ? { id: { in: ids } } : {}) }, data: { readAt: new Date() } });
    return { ok: true };
  }
}
