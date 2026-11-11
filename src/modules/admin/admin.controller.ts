import { Body, Controller, Get, Header, Param, Patch, Post, Query } from '@nestjs/common';
import { Allow, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString } from 'class-validator';

import { AdminId, AdminOnly, Public } from '../../common/auth';
import { AdminOpsService, type QueueKind } from './admin-ops.service';
import { AdminService } from './admin.service';

const KINDS: QueueKind[] = ['order', 'booking', 'ride', 'food', 'sos'];
const kind = (k: string) => (KINDS.includes(k as QueueKind) ? (k as QueueKind) : 'order');

class LoginDto {
  @IsString() email!: string;
  @IsString() password!: string;
}
class PasswordDto {
  @IsString() current!: string;
  @IsString() next!: string;
}
class DecisionDto {
  @IsIn(['approve', 'reject', 'suspend', 'reinstate']) decision!: 'approve' | 'reject' | 'suspend' | 'reinstate';
  @IsOptional() @IsString() reason?: string;
}
class DocReviewDto {
  @IsBoolean() ok!: boolean;
  @IsOptional() @IsString() note?: string;
}
class VendorSettingsDto {
  @IsOptional() @IsNumber() commissionPct?: number | null;
  @IsOptional() @IsArray() @IsString({ each: true }) services?: string[];
  @IsOptional() @IsString() warning?: string;
}
class CustomerActionDto {
  @IsOptional() @IsBoolean() blocked?: boolean;
  @IsOptional() @IsBoolean() kycVerified?: boolean;
}
class AdjustDto {
  @IsInt() amount!: number;
  @IsString() reason!: string;
}
class ReasonDto {
  @IsString() reason!: string;
}
class ReassignDto {
  @IsString() vendorId!: string;
}
class PreviewDto {
  @IsInt() netProfit!: number;
}
class ModerateDto {
  @IsOptional() @IsBoolean() verified?: boolean;
  @IsOptional() @IsBoolean() featured?: boolean;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() reason?: string;
}
class CategoryDto {
  @IsOptional() @IsString() id?: string;
  @IsString() name!: string;
  @IsString() photo!: string;
  @IsOptional() @IsInt() sort?: number;
}
class ServiceDto {
  @IsOptional() @IsInt() visitCharge?: number;
  @IsOptional() @IsBoolean() live?: boolean;
  @IsOptional() @IsBoolean() requiresQuote?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) issues?: string[];
}
class CouponDto {
  @IsString() code!: string;
  @IsString() description!: string;
  @IsInt() percent!: number;
  @IsInt() maxDiscount!: number;
  @IsInt() minOrder!: number;
  @IsBoolean() active!: boolean;
}
class ActiveDto {
  @IsBoolean() active!: boolean;
}
class SettingDto {
  @Allow() value!: unknown;
}
class StaffDto {
  @IsString() email!: string;
  @IsString() name!: string;
  @IsString() role!: string;
}
class StaffEditDto {
  @IsOptional() @IsString() role?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
class ReplyDto {
  @IsString() reply!: string;
  @IsBoolean() close!: boolean;
}

/** Admin panel API. Staff tokens only; each route names the permission it needs (ROLE_PERMS). */
@Controller('admin')
export class AdminController {
  constructor(
    private admin: AdminService,
    private ops: AdminOpsService,
  ) {}

  @Public() @Post('auth/login') login(@Body() b: LoginDto) {
    return this.admin.login(b.email, b.password);
  }
  @AdminOnly('dashboard') @Get('me') me(@AdminId() a: string) {
    return this.admin.me(a);
  }
  @AdminOnly('dashboard') @Post('me/password') password(@AdminId() a: string, @Body() b: PasswordDto) {
    return this.admin.changePassword(a, b.current, b.next);
  }
  @AdminOnly('dashboard') @Get('dashboard') dashboard() {
    return this.admin.dashboard();
  }

  // vendors
  @AdminOnly('vendors') @Get('vendors') vendors(@Query() q: { status?: string; category?: string; q?: string; app?: string }) {
    return this.admin.vendors(q);
  }
  @AdminOnly('vendors') @Get('vendors/:id') vendor(@Param('id') id: string) {
    return this.admin.vendor(id);
  }
  @AdminOnly('vendors') @Post('vendors/:id/decision') decide(@AdminId() a: string, @Param('id') id: string, @Body() b: DecisionDto) {
    return this.admin.decideVendor(a, id, b.decision, b.reason);
  }
  @AdminOnly('vendors') @Post('docs/:id/review') reviewDoc(@AdminId() a: string, @Param('id') id: string, @Body() b: DocReviewDto) {
    return this.admin.reviewDoc(a, id, b.ok, b.note);
  }
  @AdminOnly('vendors') @Patch('vendors/:id') vendorSettings(@AdminId() a: string, @Param('id') id: string, @Body() b: VendorSettingsDto) {
    return this.admin.vendorSettings(a, id, b);
  }
  @AdminOnly('vendors') @Get('tickets') tickets() {
    return this.ops.tickets();
  }
  @AdminOnly('vendors') @Post('tickets/:id/reply') reply(@AdminId() a: string, @Param('id') id: string, @Body() b: ReplyDto) {
    return this.ops.replyTicket(a, id, b.reply, b.close);
  }

  // customers
  @AdminOnly('customers') @Get('customers') customers(@Query() q: { q?: string; blocked?: string }) {
    return this.admin.customers(q);
  }
  @AdminOnly('customers') @Get('customers/:id') customer(@Param('id') id: string) {
    return this.admin.customer(id);
  }
  @AdminOnly('customers') @Patch('customers/:id') customerAction(@AdminId() a: string, @Param('id') id: string, @Body() b: CustomerActionDto) {
    return this.admin.customerAction(a, id, b);
  }
  @AdminOnly('finance') @Post('customers/:id/wallet') adjust(@AdminId() a: string, @Param('id') id: string, @Body() b: AdjustDto) {
    return this.admin.adjustWallet(a, id, b.amount, b.reason);
  }

  // orders & dispatch
  @AdminOnly('orders') @Get('queue') queue(@Query() q: { kind?: string; scope?: string; q?: string }) {
    return this.ops.queue(q);
  }
  @AdminOnly('orders') @Get('queue/:kind/:id') item(@Param('kind') k: string, @Param('id') id: string) {
    return this.ops.queueItem(kind(k), id);
  }
  @AdminOnly('orders') @Post('queue/:kind/:id/cancel') cancel(@AdminId() a: string, @Param('kind') k: string, @Param('id') id: string, @Body() b: ReasonDto) {
    return this.ops.cancel(a, kind(k), id, b.reason);
  }
  @AdminOnly('orders') @Post('queue/booking/:id/reassign') reassign(@AdminId() a: string, @Param('id') id: string, @Body() b: ReassignDto) {
    return this.ops.reassign(a, id, b.vendorId);
  }
  @AdminOnly('orders') @Get('dispatch') dispatch() {
    return this.ops.dispatch();
  }

  // income plan
  @AdminOnly('income') @Get('income') income() {
    return this.ops.income();
  }
  @AdminOnly('income') @Post('income/preview') preview(@Body() b: PreviewDto) {
    return this.ops.incomePreview(b.netProfit);
  }

  // finance
  @AdminOnly('finance') @Get('finance') finance() {
    return this.ops.finance();
  }
  @AdminOnly('finance') @Get('finance/ledger') journals() {
    return this.ops.journals();
  }
  @AdminOnly('finance') @Post('finance/payouts/:type/:id/paid') paid(@AdminId() a: string, @Param('type') t: string, @Param('id') id: string) {
    return this.ops.markPaid(a, t === 'member' ? 'member' : 'partner', id);
  }
  @AdminOnly('finance') @Get('finance/payouts.csv') @Header('Content-Type', 'text/csv') csv(@AdminId() a: string) {
    return this.ops.payoutCsv(a);
  }

  // property
  @AdminOnly('property') @Get('listings') listings(@Query('scope') scope = 'pending') {
    return this.ops.listings(scope);
  }
  @AdminOnly('property') @Patch('listings/:id') moderate(@AdminId() a: string, @Param('id') id: string, @Body() b: ModerateDto) {
    return this.ops.moderate(a, id, b);
  }
  @AdminOnly('property') @Get('enquiries') enquiries() {
    return this.ops.enquiries();
  }

  // catalog & content
  @AdminOnly('catalog') @Get('catalog') catalog() {
    return this.ops.catalog();
  }
  @AdminOnly('catalog') @Post('catalog/categories') category(@AdminId() a: string, @Body() b: CategoryDto) {
    return this.ops.saveCategory(a, b);
  }
  @AdminOnly('catalog') @Patch('catalog/services/:code') service(@AdminId() a: string, @Param('code') c: string, @Body() b: ServiceDto) {
    return this.ops.saveService(a, c, b);
  }
  @AdminOnly('catalog') @Post('catalog/coupons') coupon(@AdminId() a: string, @Body() b: CouponDto) {
    return this.ops.saveCoupon(a, b);
  }
  @AdminOnly('catalog') @Patch('catalog/products/:id') product(@AdminId() a: string, @Param('id') id: string, @Body() b: ActiveDto) {
    return this.ops.productActive(a, id, b.active);
  }

  // settings, staff, audit
  @AdminOnly('dashboard') @Get('settings') settings() {
    return this.ops.settingsAll();
  }
  @AdminOnly('settings') @Patch('settings/:key') saveSetting(@AdminId() a: string, @Param('key') key: string, @Body() b: SettingDto) {
    return this.ops.saveSetting(a, key, b.value);
  }
  @AdminOnly('staff') @Get('staff') staff() {
    return this.ops.staff();
  }
  @AdminOnly('staff') @Post('staff') addStaff(@AdminId() a: string, @Body() b: StaffDto) {
    return this.ops.addStaff(a, b);
  }
  @AdminOnly('staff') @Patch('staff/:id') editStaff(@AdminId() a: string, @Param('id') id: string, @Body() b: StaffEditDto) {
    return this.ops.editStaff(a, id, b);
  }
  @AdminOnly('settings') @Get('audit') audit(@Query('action') action?: string) {
    return this.ops.auditLog({ action });
  }
}
