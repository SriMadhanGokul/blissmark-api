import { CanActivate, createParamDecorator, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import { unauthorized } from './errors';

export const IS_PUBLIC = 'isPublic';
/** Marks a route as reachable without a token (OTP, sponsor check, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

type AuthedRequest = Request & { userId?: string };

/** Global guard: every route needs a valid Bearer JWT unless marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private jwt: JwtService,
    private reflector: Reflector,
  ) {}

  canActivate(ctx: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    if (!token) throw unauthorized();
    try {
      const payload = this.jwt.verify<{ sub: string }>(token);
      req.userId = payload.sub;
      return true;
    } catch {
      throw unauthorized();
    }
  }
}

export const UserId = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().userId!);
