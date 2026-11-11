import { CanActivate, createParamDecorator, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import { forbidden, unauthorized } from './errors';

export const IS_PUBLIC = 'isPublic';
/** Marks a route as reachable without a token (OTP, sponsor check, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ADMIN_PERM = 'adminPerm';
/** Admin-panel route: needs a staff token whose role grants `perm`. */
export const AdminOnly = (perm: Perm) => SetMetadata(ADMIN_PERM, perm);

/** What each staff role may do (proposal 05: admin, operations, support, accounting). */
export type Perm = 'dashboard' | 'vendors' | 'customers' | 'orders' | 'catalog' | 'income' | 'finance' | 'property' | 'settings' | 'staff';
export const ROLE_PERMS: Record<string, Perm[]> = {
  owner: ['dashboard', 'vendors', 'customers', 'orders', 'catalog', 'income', 'finance', 'property', 'settings', 'staff'],
  ops: ['dashboard', 'vendors', 'orders', 'catalog', 'property'],
  support: ['dashboard', 'customers', 'orders', 'vendors'],
  finance: ['dashboard', 'finance', 'income', 'customers'],
};

type AuthedRequest = Request & { userId?: string; adminId?: string; adminRole?: string };

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
    const perm = this.reflector.getAllAndOverride<Perm | undefined>(ADMIN_PERM, [ctx.getHandler(), ctx.getClass()]);
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    if (!token) throw unauthorized();
    let payload: { sub: string; admin?: boolean; role?: string };
    try {
      payload = this.jwt.verify(token);
    } catch {
      throw unauthorized();
    }
    // staff tokens only open admin routes, and member tokens never do
    if (!!payload.admin !== !!perm) throw unauthorized();
    if (perm) {
      if (!ROLE_PERMS[payload.role ?? '']?.includes(perm)) throw forbidden();
      req.adminId = payload.sub;
      req.adminRole = payload.role;
      return true;
    }
    req.userId = payload.sub;
    return true;
  }
}

export const UserId = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().userId!);

export const AdminId = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().adminId!);
