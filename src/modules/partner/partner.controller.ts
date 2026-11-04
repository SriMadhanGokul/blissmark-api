import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';

import { UserId } from '../../common/auth';
import { CatalogService } from './catalog.service';
import { JobsService, type JobKind } from './jobs.service';
import { CAB_TYPES, CATEGORIES, PartnerService, type Category } from './partner.service';

const KINDS: JobKind[] = ['booking', 'ride', 'delivery', 'kitchen', 'sos', 'order', 'visit'];

class RestaurantDto {
  @IsIn(['restaurant', 'kitchen']) kind!: 'restaurant' | 'kitchen';
  @IsString() cuisine!: string;
  @IsString() locality!: string;
  @IsInt() @Min(0) costForTwo!: number;
  @IsOptional() @IsBoolean() pureVeg?: boolean;
}
class ProfileDto {
  @IsIn(Object.keys(CATEGORIES)) category!: Category;
  @IsString() name!: string;
  @IsOptional() @IsString() businessName?: string;
  @IsOptional() @IsString() district?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) services?: string[];
  @IsOptional() @IsIn(CAB_TYPES) cabType?: (typeof CAB_TYPES)[number];
  @IsOptional() @IsIn(['tow', 'ambulance']) responderType?: 'tow' | 'ambulance';
  @IsOptional() @IsString() vehicle?: string;
  @IsOptional() @IsString() plate?: string;
  @IsOptional() @ValidateNested() @Type(() => RestaurantDto) restaurant?: RestaurantDto;
}
class DocDto {
  @IsString() kind!: string;
  @IsString() number!: string;
  @IsOptional() @IsString() image?: string;
}
class OnlineDto {
  @IsBoolean() online!: boolean;
}
class HoursDto {
  @IsString() open!: string;
  @IsString() close!: string;
  @IsArray() @IsInt({ each: true }) days!: number[];
}
class AvailabilityDto {
  @IsOptional() @ValidateNested() @Type(() => HoursDto) hours?: HoursDto;
  @IsOptional() @IsInt() radiusKm?: number;
  @IsOptional() @IsArray() @IsString({ each: true }) pincodes?: string[];
  @IsOptional() @IsBoolean() holiday?: boolean;
}
class LineDto {
  @IsString() label!: string;
  @IsInt() amount!: number;
}
class ActionDto {
  @IsOptional() @IsString() otp?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => LineDto) lines?: LineDto[];
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsString() visitAt?: string;
}
class BankDto {
  @IsString() holder!: string;
  @IsString() account!: string;
  @IsString() ifsc!: string;
}
class WithdrawDto {
  @IsInt() @Min(1) amount!: number;
}
class TicketDto {
  @IsString() subject!: string;
  @IsString() message!: string;
}
class ReadDto {
  @IsOptional() @IsArray() @IsString({ each: true }) ids?: string[];
}
class ProductDto {
  @IsString() title!: string;
  @IsOptional() @IsString() brand?: string;
  @IsString() description!: string;
  @IsString() categoryId!: string;
  @IsInt() price!: number;
  @IsInt() mrp!: number;
  @IsInt() @Min(0) stock!: number;
  @IsOptional() @IsString() photo?: string;
}
class ProductEditDto {
  @IsOptional() @IsInt() price?: number;
  @IsOptional() @IsInt() mrp?: number;
  @IsOptional() @IsInt() stock?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}
class MenuItemDto {
  @IsString() section!: string;
  @IsString() name!: string;
  @IsOptional() @IsString() description!: string;
  @IsInt() price!: number;
  @IsBoolean() veg!: boolean;
  @IsOptional() @IsString() photo?: string;
}
class MenuEditDto {
  @IsOptional() @IsInt() price?: number;
  @IsOptional() @IsBoolean() available?: boolean;
}
class KitchenDto {
  @IsOptional() @IsInt() etaMin?: number;
  @IsOptional() @IsInt() costForTwo?: number;
}
class ListingDto {
  @IsString() title!: string;
  @IsIn(['apartment', 'villa', 'plot']) type!: string;
  @IsOptional() @IsInt() @Min(1) @Max(10) bhk?: number;
  @IsInt() areaSqft!: number;
  @IsInt() price!: number;
  @IsString() locality!: string;
  @IsString() description!: string;
  @IsOptional() @IsArray() @IsString({ each: true }) amenities?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) photos?: string[];
}
class ListingEditDto {
  @IsOptional() @IsInt() price?: number;
  @IsOptional() @IsIn(['active', 'paused', 'sold']) status?: string;
}

/** Vendor app API. Every route needs the member's token; vendor checks happen in the services. */
@Controller('partner')
export class PartnerController {
  constructor(
    private partner: PartnerService,
    private jobs: JobsService,
    private catalog: CatalogService,
  ) {}

  @Get('categories') categories() {
    return Object.entries(CATEGORIES).map(([id, c]) => ({ id, label: c.label, docs: c.docs }));
  }

  @Get('me') me(@UserId() u: string) {
    return this.partner.me(u);
  }
  @Post('profile') profile(@UserId() u: string, @Body() b: ProfileDto) {
    return this.partner.saveProfile(u, b);
  }
  @Post('docs') doc(@UserId() u: string, @Body() b: DocDto) {
    return this.partner.saveDoc(u, b);
  }
  @Post('submit') submit(@UserId() u: string) {
    return this.partner.submit(u);
  }

  /** Dashboard in one call: profile, earnings, live work and open offers. */
  @Get('home') async home(@UserId() u: string) {
    const me = await this.partner.me(u);
    if (me.status !== 'approved') return { me, offers: [], active: [], today: 0, week: 0, balance: 0, onShift: true };
    const v = await this.partner.vendor(u);
    const [offers, active, wallet] = await Promise.all([this.jobs.offers(u), this.jobs.jobs(u, 'active'), this.partner.wallet(u)]);
    return { me, offers: offers.offers, onShift: offers.onShift, active, today: wallet.today, week: wallet.week, balance: wallet.balance, acceptance: v.accepted + v.declined ? Math.round((v.accepted / (v.accepted + v.declined)) * 100) : 100 };
  }
  @Post('online') online(@UserId() u: string, @Body() b: OnlineDto) {
    return this.partner.setOnline(u, b.online);
  }
  @Patch('availability') availability(@UserId() u: string, @Body() b: AvailabilityDto) {
    return this.partner.availability(u, b);
  }

  @Get('offers') offers(@UserId() u: string) {
    return this.jobs.offers(u);
  }
  @Post('offers/:kind/:id/accept') accept(@UserId() u: string, @Param('kind') kind: JobKind, @Param('id') id: string) {
    return this.jobs.accept(u, this.kind(kind), id);
  }
  @Post('offers/:kind/:id/decline') decline(@UserId() u: string, @Param('kind') kind: JobKind, @Param('id') id: string) {
    return this.jobs.decline(u, this.kind(kind), id);
  }
  @Get('jobs') list(@UserId() u: string, @Query('scope') scope = 'active') {
    return this.jobs.jobs(u, scope === 'done' ? 'done' : 'active');
  }
  @Get('jobs/:kind/:id') job(@UserId() u: string, @Param('kind') kind: JobKind, @Param('id') id: string) {
    return this.jobs.job(u, this.kind(kind), id);
  }
  @Post('jobs/:kind/:id/:action') act(@UserId() u: string, @Param('kind') kind: JobKind, @Param('id') id: string, @Param('action') action: string, @Body() b: ActionDto) {
    return this.jobs.act(u, this.kind(kind), id, action, b);
  }

  @Get('wallet') wallet(@UserId() u: string) {
    return this.partner.wallet(u);
  }
  @Post('bank') bank(@UserId() u: string, @Body() b: BankDto) {
    return this.partner.saveBank(u, b);
  }
  @Post('withdrawals') withdraw(@UserId() u: string, @Body() b: WithdrawDto) {
    return this.partner.withdraw(u, b.amount);
  }
  @Get('performance') performance(@UserId() u: string) {
    return this.partner.performance(u);
  }
  @Get('referral') referral(@UserId() u: string) {
    return this.partner.referral(u);
  }
  @Get('support') tickets(@UserId() u: string) {
    return this.partner.tickets(u);
  }
  @Post('support') raise(@UserId() u: string, @Body() b: TicketDto) {
    return this.partner.raiseTicket(u, b);
  }
  @Get('notifications') inbox(@UserId() u: string) {
    return this.partner.inbox(u);
  }
  @Post('notifications/read') read(@UserId() u: string, @Body() b: ReadDto) {
    return this.partner.readNotifications(u, b.ids);
  }

  @Get('catalog/categories') productCategories() {
    return this.catalog.categories();
  }
  @Get('products') products(@UserId() u: string) {
    return this.catalog.products(u);
  }
  @Post('products') addProduct(@UserId() u: string, @Body() b: ProductDto) {
    return this.catalog.addProduct(u, b);
  }
  @Patch('products/:id') editProduct(@UserId() u: string, @Param('id') id: string, @Body() b: ProductEditDto) {
    return this.catalog.editProduct(u, id, b);
  }
  @Get('menu') menu(@UserId() u: string) {
    return this.catalog.menu(u);
  }
  @Post('menu') addItem(@UserId() u: string, @Body() b: MenuItemDto) {
    return this.catalog.addItem(u, b);
  }
  @Patch('menu/:id') editItem(@UserId() u: string, @Param('id') id: string, @Body() b: MenuEditDto) {
    return this.catalog.editItem(u, id, b);
  }
  @Patch('kitchen') kitchen(@UserId() u: string, @Body() b: KitchenDto) {
    return this.catalog.kitchenSettings(u, b);
  }
  @Get('listings') listings(@UserId() u: string) {
    return this.catalog.listings(u);
  }
  @Post('listings') addListing(@UserId() u: string, @Body() b: ListingDto) {
    return this.catalog.addListing(u, b);
  }
  @Patch('listings/:id') editListing(@UserId() u: string, @Param('id') id: string, @Body() b: ListingEditDto) {
    return this.catalog.editListing(u, id, b);
  }

  private kind(k: string): JobKind {
    return (KINDS.includes(k as JobKind) ? k : 'booking') as JobKind;
  }
}
