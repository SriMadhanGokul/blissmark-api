import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';

import { AuthGuard } from './common/auth';
import { ErrorFilter } from './common/errors';
import { PrismaService } from './common/prisma.service';
import { AuthController } from './modules/auth/auth.controller';
import { AuthService } from './modules/auth/auth.service';
import { BookingsController } from './modules/bookings/bookings.controller';
import { BookingsService } from './modules/bookings/bookings.service';
import { HomeController } from './modules/home.controller';
import { IncomeService } from './modules/income/income.service';
import { SubscriptionService } from './modules/income/subscription.service';
import { ActivityService } from './modules/activity.service';
import { FoodService } from './modules/food/food.service';
import { MoneyController } from './modules/money.controller';
import { MoreController } from './modules/more.controller';
import { PropertyService } from './modules/property/property.service';
import { RidesService } from './modules/rides/rides.service';
import { SosService } from './modules/sos/sos.service';
import { NotificationsService } from './modules/notifications/notifications.service';
import { CatalogService } from './modules/partner/catalog.service';
import { JobsService } from './modules/partner/jobs.service';
import { PartnerController } from './modules/partner/partner.controller';
import { PartnerService } from './modules/partner/partner.service';
import { ShopController } from './modules/shop/shop.controller';
import { ShopService } from './modules/shop/shop.service';
import { UsersService } from './modules/users/users.service';
import { LedgerService } from './modules/wallet/ledger.service';
import { WalletService } from './modules/wallet/wallet.service';

@Module({
  imports: [JwtModule.register({ global: true, secret: process.env.JWT_SECRET })],
  controllers: [AuthController, HomeController, ShopController, BookingsController, MoneyController, MoreController, PartnerController],
  providers: [
    PrismaService,
    LedgerService,
    NotificationsService,
    UsersService,
    AuthService,
    ShopService,
    BookingsService,
    WalletService,
    IncomeService,
    SubscriptionService,
    RidesService,
    FoodService,
    SosService,
    PropertyService,
    ActivityService,
    PartnerService,
    JobsService,
    CatalogService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
export class AppModule {}
