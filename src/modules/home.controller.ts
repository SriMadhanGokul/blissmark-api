import { Controller, Get, Query } from '@nestjs/common';

import { Public, UserId } from '../common/auth';
import { PrismaService } from '../common/prisma.service';
import { ActivityService } from './activity.service';
import { SettingsService } from './admin/settings.service';
import { IncomeService } from './income/income.service';
import { NotificationsService } from './notifications/notifications.service';
import { UsersService } from './users/users.service';
import { LedgerService } from './wallet/ledger.service';

@Controller()
export class HomeController {
  constructor(
    private prisma: PrismaService,
    private users: UsersService,
    private ledger: LedgerService,
    private notifications: NotificationsService,
    private activity: ActivityService,
    private income: IncomeService,
    private settings: SettingsService,
  ) {}

  /** One call for the whole Home screen. Money is in paise, like every other endpoint. */
  @Get('home')
  async home(@UserId() userId: string) {
    const [user, address, wallet, unread, services, active, rep, shopBanner] = await Promise.all([
      this.users.dto(userId),
      this.users.defaultAddress(userId),
      this.ledger.walletBalance(userId),
      this.notifications.unread(userId),
      this.prisma.service.findMany({ where: { live: true }, orderBy: { sort: 'asc' } }),
      this.activity.live(userId),
      this.income.repurchase(userId),
      this.settings.get('shopBanner'),
    ]);
    const tiles = services.filter((s) => s.group === 'home');
    return {
      greetingName: user.name?.split(' ')[0] ?? 'there',
      city: address ? `${address.city}, Rajasthan` : 'Jaipur, Rajasthan',
      walletBalance: wallet.total,
      unreadNotifications: unread,
      services: tiles.map((s) => ({ code: s.code, label: s.label, photo: s.photo })),
      shopBanner,
      liveBooking: active
        ? { kind: active.kind, id: active.id, title: active.title, vendor: active.subtitle, label: active.label, rating: 0, etaMin: 0, photo: active.photo ?? '', step: active.step }
        : null,
      income: { repurchase: rep.amount, threshold: rep.threshold, daysLeft: rep.daysLeft, referralCode: user.referralCode },
      more: services
        .filter((s) => s.group === 'rides' || s.group === 'property' || s.group === 'emergency')
        .map((s) => ({ code: s.code, label: s.label, photo: s.photo })),
    };
  }

  @Get('search')
  async search(@Query('q') q = '') {
    const term = q.trim();
    if (term.length < 2) return { products: [], services: [] };
    const [products, services] = await Promise.all([
      this.prisma.product.findMany({ where: { OR: [{ title: { contains: term, mode: 'insensitive' } }, { brand: { contains: term, mode: 'insensitive' } }] }, take: 12 }),
      this.prisma.service.findMany({ where: { live: true, OR: [{ label: { contains: term, mode: 'insensitive' } }, { issues: { has: term } }] } }),
    ]);
    return { products, services };
  }

  @Public() @Get('health')
  health() {
    return { ok: true, at: new Date().toISOString() };
  }
}
