import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

import { Public, UserId } from '../../common/auth';
import { ShopService, type PaymentMethod } from './shop.service';

class AddItemDto {
  @IsString() productId!: string;
  @IsOptional() @IsString() colour?: string;
  @IsOptional() @IsInt() @Min(1) @Max(10) qty?: number;
}
class QtyDto {
  @IsInt() @Min(0) @Max(10) qty!: number;
}
class CouponDto {
  @IsString() code!: string;
}
class CheckoutDto {
  @IsString() addressId!: string;
  @IsIn(['upi', 'card', 'netbanking', 'wallet', 'cod']) paymentMethod!: PaymentMethod;
}

@Controller()
export class ShopController {
  constructor(private shop: ShopService) {}

  @Public() @Get('categories')
  categories() {
    return this.shop.categories();
  }

  @Public() @Get('products')
  products(@Query() q: { category?: string; q?: string; sort?: string; trending?: string }) {
    return this.shop.products(q);
  }

  @Public() @Get('products/:id')
  product(@Param('id') id: string) {
    return this.shop.product(id);
  }

  @Get('cart')
  cart(@UserId() u: string) {
    return this.shop.cart(u);
  }

  @Post('cart/items')
  add(@UserId() u: string, @Body() b: AddItemDto) {
    return this.shop.addToCart(u, b.productId, b.colour, b.qty);
  }

  @Patch('cart/items/:id')
  qty(@UserId() u: string, @Param('id') id: string, @Body() b: QtyDto) {
    return this.shop.setQty(u, id, b.qty);
  }

  @Delete('cart/items/:id')
  remove(@UserId() u: string, @Param('id') id: string) {
    return this.shop.setQty(u, id, 0);
  }

  @Post('cart/coupon')
  coupon(@UserId() u: string, @Body() b: CouponDto) {
    return this.shop.applyCoupon(u, b.code);
  }

  @Delete('cart/coupon')
  removeCoupon(@UserId() u: string) {
    return this.shop.removeCoupon(u);
  }

  @Post('checkout')
  checkout(@UserId() u: string, @Body() b: CheckoutDto) {
    return this.shop.checkout(u, b.addressId, b.paymentMethod);
  }

  @Get('orders')
  orders(@UserId() u: string) {
    return this.shop.orders(u);
  }

  @Get('orders/:id')
  order(@UserId() u: string, @Param('id') id: string) {
    return this.shop.order(u, id);
  }

  @Post('orders/:id/cancel')
  cancel(@UserId() u: string, @Param('id') id: string) {
    return this.shop.cancel(u, id);
  }
}
