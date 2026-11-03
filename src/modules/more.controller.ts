import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';

import { Public, UserId } from '../common/auth';
import { ActivityService } from './activity.service';
import { FoodService } from './food/food.service';
import { PropertyService } from './property/property.service';
import { RidesService, VEHICLES } from './rides/rides.service';
import { SOS_ISSUES, SosService } from './sos/sos.service';

class PlaceDto {
  @IsString() label!: string;
  @IsString() line1!: string;
  @IsNumber() lat!: number;
  @IsNumber() lng!: number;
}
class EstimateDto {
  @ValidateNested() @Type(() => PlaceDto) pickup!: PlaceDto;
  @ValidateNested() @Type(() => PlaceDto) drop!: PlaceDto;
}
class RideDto extends EstimateDto {
  @IsIn(VEHICLES.map((v) => v.id)) vehicle!: string;
  @IsIn(['upi', 'card', 'wallet', 'cash']) paymentMethod!: string;
}
class PayDto {
  @IsIn(['upi', 'card', 'wallet', 'cash']) method!: 'upi' | 'card' | 'wallet' | 'cash';
}
class RateDto {
  @IsInt() @Min(1) @Max(5) rating!: number;
}
class FoodItemDto {
  @IsString() menuItemId!: string;
  @IsInt() @Min(1) @Max(20) qty!: number;
}
class FoodOrderDto {
  @IsString() restaurantId!: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => FoodItemDto) items!: FoodItemDto[];
  @IsString() addressId!: string;
  @IsIn(['upi', 'card', 'wallet']) paymentMethod!: 'upi' | 'card' | 'wallet';
  @IsOptional() @IsString() scheduledAt?: string;
}
class SosLocationDto {
  @IsString() label!: string;
  @IsNumber() lat!: number;
  @IsNumber() lng!: number;
}
class SosDto {
  @IsIn(['highway', 'health']) type!: 'highway' | 'health';
  @IsString() issue!: string;
  @IsOptional() @IsString() note?: string;
  @ValidateNested() @Type(() => SosLocationDto) location!: SosLocationDto;
}
class EnquiryDto {
  @IsString() message!: string;
  @IsOptional() @IsString() visitAt?: string;
}

@Controller()
export class MoreController {
  constructor(
    private rides: RidesService,
    private food: FoodService,
    private sos: SosService,
    private property: PropertyService,
    private activity: ActivityService,
  ) {}

  /* rides */
  @Get('rides/places') places(@UserId() u: string) { return this.rides.places(u); }
  @Post('rides/estimate') estimate(@Body() b: EstimateDto) { return this.rides.estimate(b.pickup, b.drop); }
  @Post('rides') createRide(@UserId() u: string, @Body() b: RideDto) { return this.rides.create(u, b); }
  @Get('rides') listRides(@UserId() u: string) { return this.rides.list(u); }
  @Get('rides/:id') ride(@UserId() u: string, @Param('id') id: string) { return this.rides.get(u, id); }
  @Post('rides/:id/cancel') cancelRide(@UserId() u: string, @Param('id') id: string) { return this.rides.cancel(u, id); }
  @Post('rides/:id/pay') payRide(@UserId() u: string, @Param('id') id: string, @Body() b: PayDto) { return this.rides.pay(u, id, b.method); }
  @Post('rides/:id/rating') rateRide(@UserId() u: string, @Param('id') id: string, @Body() b: RateDto) { return this.rides.rate(u, id, b.rating); }

  /* food and cloud kitchen */
  @Public() @Get('restaurants') restaurants(@Query('kind') kind?: string, @Query('q') q?: string) { return this.food.restaurants(kind, q); }
  @Public() @Get('restaurants/:id') restaurant(@Param('id') id: string) { return this.food.restaurant(id); }
  @Post('food/orders') placeFood(@UserId() u: string, @Body() b: FoodOrderDto) { return this.food.place(u, b); }
  @Get('food/orders') foodOrders(@UserId() u: string) { return this.food.list(u); }
  @Get('food/orders/:id') foodOrder(@UserId() u: string, @Param('id') id: string) { return this.food.get(u, id); }
  @Post('food/orders/:id/cancel') cancelFood(@UserId() u: string, @Param('id') id: string) { return this.food.cancel(u, id); }

  /* emergencies */
  @Public() @Get('sos/issues') sosIssues() { return SOS_ISSUES; }
  @Post('sos') raiseSos(@UserId() u: string, @Body() b: SosDto) { return this.sos.create(u, b); }
  @Get('sos') listSos(@UserId() u: string) { return this.sos.list(u); }
  @Get('sos/:id') getSos(@UserId() u: string, @Param('id') id: string) { return this.sos.get(u, id); }
  @Post('sos/:id/cancel') cancelSos(@UserId() u: string, @Param('id') id: string) { return this.sos.cancel(u, id); }
  @Post('sos/:id/pay') paySos(@UserId() u: string, @Param('id') id: string, @Body() b: PayDto) { return this.sos.pay(u, id, b.method === 'cash' ? 'upi' : b.method); }

  /* property */
  @Get('properties') properties(@UserId() u: string, @Query() q: { type?: string; bhk?: string; maxPrice?: string; q?: string }) { return this.property.list(u, q); }
  @Get('properties/shortlist') shortlist(@UserId() u: string) { return this.property.shortlist(u); }
  @Get('properties/enquiries') enquiries(@UserId() u: string) { return this.property.enquiries(u); }
  @Get('properties/:id') propertyById(@UserId() u: string, @Param('id') id: string) { return this.property.get(u, id); }
  @Post('properties/:id/shortlist') toggle(@UserId() u: string, @Param('id') id: string) { return this.property.toggleShortlist(u, id); }
  @Delete('properties/:id/shortlist') untoggle(@UserId() u: string, @Param('id') id: string) { return this.property.toggleShortlist(u, id); }
  @Post('properties/:id/enquiries') enquire(@UserId() u: string, @Param('id') id: string, @Body() b: EnquiryDto) { return this.property.enquire(u, id, b); }

  /* unified activity for the Orders tab */
  @Get('activity') feed(@UserId() u: string) { return this.activity.feed(u); }
}
