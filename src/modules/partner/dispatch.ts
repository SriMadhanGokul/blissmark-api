import type { Prisma } from '@prisma/client';

import type { PrismaService } from '../../common/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';

/**
 * Real vendors (signed up through the vendor app) and simulated ones share the Vendor
 * collection. The simulators only ever assign simulated vendors, and wait this long
 * before doing so whenever a matching app vendor is online, so real partners get the job first.
 */
export const APP_PRIORITY_S = 45;

/** Vendors created by the seed: no linked user account. */
export const SIM_VENDOR: Prisma.VendorWhereInput = { OR: [{ userId: null }, { userId: { isSet: false } }] };

/** App vendors who can take work right now. */
export const LIVE_APP_VENDOR: Prisma.VendorWhereInput = { userId: { not: null }, status: 'approved', online: true, holiday: false };

export const appVendorsOnline = (prisma: PrismaService, service: string) => prisma.vendor.count({ where: { ...LIVE_APP_VENDOR, services: { has: service } } });

/** True when this vendor id belongs to a real partner, whose own actions drive the job. */
export async function isAppVendor(prisma: PrismaService, id?: string | null) {
  if (!id) return false;
  const v = await prisma.vendor.findUnique({ where: { id }, select: { userId: true } });
  return !!v?.userId;
}

/** In-app alert to every live app vendor offering `service` (push/FCM plugs in behind notify). */
export async function alertVendors(prisma: PrismaService, notifications: NotificationsService, service: string, title: string, body: string) {
  const vendors = await prisma.vendor.findMany({ where: { ...LIVE_APP_VENDOR, services: { has: service } }, select: { userId: true } });
  await Promise.all(vendors.map((v) => notifications.notify(v.userId!, 'partner', title, body, '/offers')));
}

/** Notifies the app vendor behind a restaurant, seller or agent listing, if there is one. */
export async function alertOwner(prisma: PrismaService, notifications: NotificationsService, where: Prisma.VendorWhereInput, title: string, body: string, link: string) {
  const v = await prisma.vendor.findFirst({ where: { ...where, userId: { not: null } }, select: { userId: true } });
  if (v?.userId) await notifications.notify(v.userId, 'partner', title, body, link);
  return !!v;
}

/** Appends a status event to a document whose `events` field is a JSON array. */
export function withEvent(events: unknown, status: string) {
  return [...((events as { status: string; at: string }[]) ?? []), { status, at: new Date() }];
}
