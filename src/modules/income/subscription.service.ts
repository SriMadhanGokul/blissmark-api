import { Injectable } from '@nestjs/common';

import { invalid, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';

/** Plan B member subscription. Collection runs as a scheduled job (not yet built); this is the member-facing side. */
@Injectable()
export class SubscriptionService {
  constructor(private prisma: PrismaService) {}

  async get(userId: string) {
    const s = await this.prisma.subscription.findUnique({ where: { userId } });
    if (!s) throw notFound('Subscription');
    return s;
  }

  async update(userId: string, action: 'pause' | 'resume' | 'cancel' | 'autoRenewOn' | 'autoRenewOff') {
    const s = await this.get(userId);
    if (s.status === 'cancelled' && action !== 'resume') throw invalid('CANCELLED', 'This subscription is cancelled');
    const data =
      action === 'pause' ? { status: 'paused' } : action === 'resume' ? { status: 'active' } : action === 'cancel' ? { status: 'cancelled', autoRenew: false } : { autoRenew: action === 'autoRenewOn' };
    return this.prisma.subscription.update({ where: { userId }, data });
  }
}
