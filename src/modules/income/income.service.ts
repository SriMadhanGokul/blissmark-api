import { Injectable } from '@nestjs/common';

import { notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { monthKey } from '../../common/util';

/** Plan A level shares of company net profit (docs 13.1). Admin-configurable later. */
export const LEVEL_PCT = [10, 7, 6, 5, 4, 3, 2, 1, 1, 1, ...Array(20).fill(0.5)];
export const REPURCHASE_THRESHOLD = 100000; // ₹1,000 (open decision: what counts, see docs 23.4)

@Injectable()
export class IncomeService {
  constructor(private prisma: PrismaService) {}

  private async member(userId: string) {
    const m = await this.prisma.member.findUnique({ where: { userId } });
    if (!m) throw notFound('Member');
    return m;
  }

  /** Repurchase this month = paid shopping orders + paid service bookings (excluding cancelled). */
  async repurchase(userId: string, now = new Date()) {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const [orders, bookings] = await Promise.all([
      this.prisma.order.aggregate({ where: { userId, placedAt: { gte: start }, status: { not: 'CANCELLED' } }, _sum: { total: true } }),
      this.prisma.booking.findMany({ where: { userId, createdAt: { gte: start }, status: { in: ['PAID', 'CLOSED'] } }, select: { invoice: true } }),
    ]);
    const services = bookings.reduce((s, b) => s + ((b.invoice as { total?: number } | null)?.total ?? 0), 0);
    const amount = (orders._sum.total ?? 0) + services;
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return { amount, threshold: REPURCHASE_THRESHOLD, daysLeft: end.getDate() - now.getDate(), qualified: amount >= REPURCHASE_THRESHOLD };
  }

  async levels(memberId: string) {
    const rows = await this.prisma.referralClosure.findMany({ where: { ancestorId: memberId, depth: { gt: 0 } }, include: { descendant: { select: { active: true } } } });
    const levels = Array.from({ length: 30 }, (_, i) => ({ level: i + 1, members: 0, active: 0, pct: LEVEL_PCT[i] }));
    for (const r of rows) {
      const l = levels[r.depth - 1];
      if (!l) continue;
      l.members += 1;
      if (r.descendant.active) l.active += 1;
    }
    return levels;
  }

  async summary(userId: string) {
    const m = await this.member(userId);
    const [levels, statements, rep] = await Promise.all([
      this.levels(m.id),
      this.prisma.incomeStatement.findMany({ where: { memberId: m.id }, orderBy: { month: 'desc' } }),
      this.repurchase(userId),
    ]);
    const last = statements[0];
    return {
      referralCode: m.referralCode,
      lastPayout: last ? { month: last.month, amount: last.total, creditedAt: last.creditedAt } : null,
      totalEarned: statements.reduce((s, x) => s + x.total, 0),
      repurchase: rep,
      stats: { network: levels.reduce((s, l) => s + l.members, 0), level1: levels[0].members, active: levels.reduce((s, l) => s + l.active, 0) },
      levels,
      months: statements.map((s) => s.month),
    };
  }

  /** Level detail. Names are shown for level 1 only; deeper levels show counts (privacy, docs 20.2). */
  async network(userId: string, level: number) {
    const m = await this.member(userId);
    const levels = await this.levels(m.id);
    if (level !== 1) return { ...levels[level - 1], members: [] as unknown[], total: levels[level - 1]?.members ?? 0 };
    const rows = await this.prisma.referralClosure.findMany({
      where: { ancestorId: m.id, depth: 1 },
      include: { descendant: { include: { user: true } } },
      orderBy: { descendant: { joinedAt: 'desc' } },
    });
    return {
      level: 1,
      total: rows.length,
      active: rows.filter((r) => r.descendant.active).length,
      members: rows.map((r) => ({ id: r.descendant.id, name: r.descendant.user.name ?? 'New member', joinedAt: r.descendant.joinedAt, active: r.descendant.active })),
    };
  }

  async statement(userId: string, month: string) {
    const m = await this.member(userId);
    const s = await this.prisma.incomeStatement.findUnique({ where: { memberId_month: { memberId: m.id, month } } });
    if (!s) throw notFound('Statement');
    return s;
  }

  currentMonth() {
    return monthKey(new Date());
  }
}
