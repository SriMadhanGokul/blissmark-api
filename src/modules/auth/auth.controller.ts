import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString, Length } from 'class-validator';

import { Public, UserId } from '../../common/auth';
import { NotificationsService } from '../notifications/notifications.service';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';

class SendOtpDto {
  @IsString() phone!: string;
  @IsOptional() @IsIn(['sms', 'whatsapp']) channel?: 'sms' | 'whatsapp';
}
class VerifyOtpDto {
  @IsString() phone!: string;
  @IsString() otp!: string;
}
class RegisterDto {
  @IsString() signupToken!: string;
  @IsString() sponsorCode!: string;
}
class UpdateMeDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsIn(['en', 'hi']) language?: 'en' | 'hi';
  @IsOptional() @IsString() city?: string;
}
class AddressDto {
  @IsString() @Length(1, 30) label!: string;
  @IsString() @Length(3, 200) line1!: string;
  @IsString() city!: string;
  @IsString() pincode!: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

@Controller()
export class AuthController {
  constructor(
    private auth: AuthService,
    private users: UsersService,
    private notifications: NotificationsService,
  ) {}

  @Public() @Post('auth/otp/send')
  send(@Body() b: SendOtpDto) {
    return this.auth.sendOtp(b.phone, b.channel ?? 'sms');
  }

  @Public() @Post('auth/otp/verify')
  verify(@Body() b: VerifyOtpDto) {
    return this.auth.verifyOtp(b.phone, b.otp);
  }

  @Public() @Get('referrals/validate')
  validate(@Query('code') c: string) {
    return this.auth.validateSponsor(c);
  }

  @Public() @Post('auth/register')
  register(@Body() b: RegisterDto) {
    return this.auth.register(b.signupToken, b.sponsorCode);
  }

  @Get('me')
  me(@UserId() id: string) {
    return this.users.dto(id);
  }

  @Patch('me')
  update(@UserId() id: string, @Body() b: UpdateMeDto) {
    return this.users.update(id, b);
  }

  @Get('me/addresses')
  addresses(@UserId() id: string) {
    return this.users.addresses(id);
  }

  @Post('me/addresses')
  addAddress(@UserId() id: string, @Body() b: AddressDto) {
    return this.users.addAddress(id, b);
  }

  @Post('me/addresses/:addressId/default')
  setDefault(@UserId() id: string, @Param('addressId') addressId: string) {
    return this.users.setDefaultAddress(id, addressId);
  }

  @Delete('me/addresses/:addressId')
  deleteAddress(@UserId() id: string, @Param('addressId') addressId: string) {
    return this.users.deleteAddress(id, addressId);
  }

  @Get('notifications')
  notificationsList(@UserId() id: string) {
    return this.notifications.list(id);
  }

  @Post('notifications/read')
  read(@UserId() id: string, @Body() b: { ids?: string[] }) {
    return this.notifications.markRead(id, b?.ids);
  }
}
