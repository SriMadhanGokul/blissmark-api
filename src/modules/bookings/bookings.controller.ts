import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

import { Public, UserId } from '../../common/auth';
import { BookingsService } from './bookings.service';

class CreateBookingDto {
  @IsString() serviceCode!: string;
  @IsString() issue!: string;
  @IsIn(['now', 'today', 'schedule']) urgency!: string;
  @IsString() description!: string;
  @IsString() addressId!: string;
  @IsOptional() @IsString() scheduledAt?: string;
}
class PayDto {
  @IsIn(['upi', 'card', 'wallet']) method!: 'upi' | 'card' | 'wallet';
}
class RateDto {
  @IsInt() @Min(1) @Max(5) rating!: number;
  @IsOptional() @IsString() review?: string;
}

@Controller()
export class BookingsController {
  constructor(private bookings: BookingsService) {}

  @Public() @Get('services')
  services() {
    return this.bookings.services();
  }

  @Public() @Get('services/:code')
  service(@Param('code') code: string) {
    return this.bookings.service(code);
  }

  @Post('bookings')
  create(@UserId() u: string, @Body() b: CreateBookingDto) {
    return this.bookings.create(u, b);
  }

  @Get('bookings')
  list(@UserId() u: string) {
    return this.bookings.list(u);
  }

  @Get('bookings/:id')
  get(@UserId() u: string, @Param('id') id: string) {
    return this.bookings.get(u, id);
  }

  @Post('bookings/:id/cancel')
  cancel(@UserId() u: string, @Param('id') id: string) {
    return this.bookings.cancel(u, id);
  }

  @Post('bookings/:id/quote/approve')
  approve(@UserId() u: string, @Param('id') id: string) {
    return this.bookings.quote(u, id, true);
  }

  @Post('bookings/:id/quote/decline')
  decline(@UserId() u: string, @Param('id') id: string) {
    return this.bookings.quote(u, id, false);
  }

  @Post('bookings/:id/pay')
  pay(@UserId() u: string, @Param('id') id: string, @Body() b: PayDto) {
    return this.bookings.pay(u, id, b.method);
  }

  @Post('bookings/:id/rating')
  rate(@UserId() u: string, @Param('id') id: string, @Body() b: RateDto) {
    return this.bookings.rate(u, id, b.rating, b.review);
  }
}
