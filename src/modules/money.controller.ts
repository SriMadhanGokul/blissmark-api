import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { IsIn, IsInt, Min } from 'class-validator';

import { UserId } from '../common/auth';
import { IncomeService } from './income/income.service';
import { SubscriptionService } from './income/subscription.service';
import { WalletService } from './wallet/wallet.service';

class AmountDto {
  @IsInt() @Min(1) amount!: number; // paise
}
class SubscriptionDto {
  @IsIn(['pause', 'resume', 'cancel', 'autoRenewOn', 'autoRenewOff']) action!: 'pause' | 'resume' | 'cancel' | 'autoRenewOn' | 'autoRenewOff';
}

@Controller()
export class MoneyController {
  constructor(
    private wallet: WalletService,
    private income: IncomeService,
    private subscription: SubscriptionService,
  ) {}

  @Get('wallet')
  getWallet(@UserId() u: string, @Query('type') type?: string) {
    return this.wallet.summary(u, type);
  }

  @Post('wallet/topup')
  topup(@UserId() u: string, @Body() b: AmountDto) {
    return this.wallet.topup(u, b.amount);
  }

  @Post('wallet/withdrawals')
  withdraw(@UserId() u: string, @Body() b: AmountDto) {
    return this.wallet.withdraw(u, b.amount);
  }

  @Get('income/summary')
  summary(@UserId() u: string) {
    return this.income.summary(u);
  }

  @Get('income/network/:level')
  network(@UserId() u: string, @Param('level', ParseIntPipe) level: number) {
    return this.income.network(u, Math.min(30, Math.max(1, level)));
  }

  @Get('income/statements/:month')
  statement(@UserId() u: string, @Param('month') month: string) {
    return this.income.statement(u, month);
  }

  @Get('subscription')
  getSubscription(@UserId() u: string) {
    return this.subscription.get(u);
  }

  @Post('subscription')
  updateSubscription(@UserId() u: string, @Body() b: SubscriptionDto) {
    return this.subscription.update(u, b.action);
  }
}
