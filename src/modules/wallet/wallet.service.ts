import { Injectable } from '@nestjs/common';

import { invalid } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LedgerService } from './ledger.service';

const MIN_WITHDRAWAL = 10000; // ₹100
const MAX_TOPUP = 1000000; // ₹10,000

@Injectable()
export class WalletService {
  constructor(
    private prisma: PrismaService,
    private ledger: LedgerService,
    private notifications: NotificationsService,
  ) {}

  async summary(userId: string, filter?: string) {
    const [bal, user, history] = await Promise.all([
      this.ledger.walletBalance(userId),
      this.prisma.user.findUniqueOrThrow({ where: { id: userId } }),
      this.ledger.walletHistory(userId),
    ]);
    const transactions = history.filter((t) =>
      filter === 'credits' ? t.amount > 0 : filter === 'debits' ? t.amount < 0 : filter === 'payouts' ? t.type === 'payout' : true,
    );
    return { balance: bal.total, withdrawable: bal.withdrawable, locked: bal.locked, kycVerified: user.kycVerified, bankLast4: user.kycVerified ? '4821' : null, transactions };
  }

  /** Mock gateway top-up. Added money is spendable but not withdrawable. */
  async topup(userId: string, amount: number) {
    if (amount < 10000 || amount > MAX_TOPUP) throw invalid('AMOUNT', 'Add between ₹100 and ₹10,000', 'amount');
    await this.prisma.$transaction((tx) =>
      this.ledger.post(tx, { type: 'topup', title: 'Added to wallet', key: `topup:${userId}:${Date.now()}` }, [
        { kind: 'gateway_clearing', debit: amount },
        { kind: 'wallet_locked', ownerId: userId, credit: amount },
      ]),
    );
    await this.notifications.notify(userId, 'wallet', 'Money added', `₹${amount / 100} added to your Blissmark wallet`, '/wallet');
    return this.summary(userId);
  }

  async withdraw(userId: string, amount: number) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.kycVerified) throw invalid('KYC', 'Complete KYC to withdraw', 'amount');
    if (amount < MIN_WITHDRAWAL) throw invalid('AMOUNT', 'Minimum withdrawal is ₹100', 'amount');
    const bal = await this.ledger.walletBalance(userId);
    if (amount > bal.withdrawable) throw invalid('AMOUNT', `You can withdraw up to ₹${(bal.withdrawable / 100).toLocaleString('en-IN')}`, 'amount');
    const w = await this.prisma.$transaction(async (tx) => {
      const row = await tx.withdrawal.create({ data: { userId, amount, tds: 0, net: amount, bankLast4: '4821', status: 'processing' } });
      await this.ledger.post(tx, { type: 'withdrawal', title: 'Withdrawal to bank', ref: row.id, key: `withdrawal:${row.id}` }, [
        { kind: 'wallet_withdrawable', ownerId: userId, debit: amount },
        { kind: 'bank_payouts', credit: amount },
      ]);
      return row;
    });
    await this.notifications.notify(userId, 'wallet', 'Withdrawal requested', `₹${amount / 100} to XXXX 4821. You will be notified when it is paid.`, '/wallet');
    return { withdrawal: w, wallet: await this.summary(userId) };
  }
}
