import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../common/prisma.service';

/**
 * Account kinds. A member wallet is split so that money a user adds can be spent
 * but not withdrawn (docs 14.3); payouts and refunds are withdrawable.
 */
export type AccountKind =
  | 'wallet_withdrawable'
  | 'wallet_locked'
  | 'vendor_earnings'
  | 'platform_commission'
  | 'income_pool'
  | 'subscription_pool'
  | 'gateway_clearing'
  | 'bank_payouts'
  | 'tds_payable';

type Tx = Prisma.TransactionClient;
type Line = { kind: AccountKind; ownerId?: string | null; debit?: number; credit?: number };

@Injectable()
export class LedgerService {
  constructor(private prisma: PrismaService) {}

  private async account(tx: Tx, kind: AccountKind, ownerId?: string | null) {
    const owner = ownerId ?? null;
    const found = await tx.ledgerAccount.findFirst({ where: { kind, ownerId: owner } });
    return found ?? tx.ledgerAccount.create({ data: { kind, ownerId: owner } });
  }

  /** Posts a balanced journal once per idempotency key. Returns false if it already existed. */
  async post(tx: Tx, journal: { type: string; title: string; ref?: string; key: string }, lines: Line[]) {
    const debit = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
    const credit = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
    if (debit !== credit) throw new Error(`Unbalanced journal ${journal.key}: ${debit} != ${credit}`);
    if (await tx.ledgerJournal.findUnique({ where: { idempotencyKey: journal.key } })) return false;
    const j = await tx.ledgerJournal.create({ data: { type: journal.type, title: journal.title, ref: journal.ref, idempotencyKey: journal.key } });
    for (const l of lines) {
      const acc = await this.account(tx, l.kind, l.ownerId);
      await tx.ledgerEntry.create({ data: { journalId: j.id, accountId: acc.id, debit: l.debit ?? 0, credit: l.credit ?? 0 } });
    }
    return true;
  }

  /** Wallet balances are liabilities to the user: credits − debits. */
  async walletBalance(userId: string, tx: Tx = this.prisma) {
    const rows = await tx.ledgerEntry.groupBy({
      by: ['accountId'],
      where: { account: { ownerId: userId, kind: { in: ['wallet_withdrawable', 'wallet_locked'] } } },
      _sum: { debit: true, credit: true },
    });
    const accounts = await tx.ledgerAccount.findMany({ where: { id: { in: rows.map((r) => r.accountId) } } });
    let withdrawable = 0;
    let locked = 0;
    for (const r of rows) {
      const kind = accounts.find((a) => a.id === r.accountId)?.kind;
      const bal = (r._sum.credit ?? 0) - (r._sum.debit ?? 0);
      if (kind === 'wallet_withdrawable') withdrawable += bal;
      else locked += bal;
    }
    return { total: withdrawable + locked, withdrawable, locked };
  }

  /** Spend from wallet: locked money first, then withdrawable. Returns the lines to debit. */
  async spendLines(tx: Tx, userId: string, amount: number): Promise<Line[]> {
    const bal = await this.walletBalance(userId, tx);
    if (bal.total < amount) return [];
    const fromLocked = Math.min(bal.locked, amount);
    const lines: Line[] = [];
    if (fromLocked > 0) lines.push({ kind: 'wallet_locked', ownerId: userId, debit: fromLocked });
    if (amount - fromLocked > 0) lines.push({ kind: 'wallet_withdrawable', ownerId: userId, debit: amount - fromLocked });
    return lines;
  }

  /** User-facing transaction list: one row per journal touching the user's wallet. */
  async walletHistory(userId: string) {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { account: { ownerId: userId, kind: { in: ['wallet_withdrawable', 'wallet_locked'] } } },
      include: { journal: true },
      orderBy: { journal: { createdAt: 'desc' } },
    });
    const byJournal = new Map<string, { id: string; type: string; title: string; amount: number; at: Date }>();
    for (const e of entries) {
      const row = byJournal.get(e.journalId) ?? { id: e.journalId, type: e.journal.type, title: e.journal.title, amount: 0, at: e.journal.createdAt };
      row.amount += e.credit - e.debit;
      byJournal.set(e.journalId, row);
    }
    return [...byJournal.values()];
  }
}
