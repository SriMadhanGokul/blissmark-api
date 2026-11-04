import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { invalid, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { digits } from '../../common/util';
import { NotificationsService } from '../notifications/notifications.service';
import { alertOwner, isAppVendor } from '../partner/dispatch';

/** Listing engine: browse, shortlist, enquire and book a site visit with the listing's own agent. */
@Injectable()
export class PropertyService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  async list(userId: string, q: { type?: string; bhk?: string; maxPrice?: string; q?: string }) {
    const where: Prisma.PropertyWhereInput = {
      status: 'active',
      ...(q.type ? { type: q.type } : {}),
      ...(q.bhk ? { bhk: q.bhk === '4' ? { gte: 4 } : Number(q.bhk) } : {}),
      ...(q.maxPrice ? { price: { lte: Number(q.maxPrice) } } : {}),
      ...(q.q ? { OR: [{ title: { contains: q.q, mode: 'insensitive' } }, { locality: { contains: q.q, mode: 'insensitive' } }] } : {}),
    };
    const [list, saved] = await Promise.all([
      this.prisma.property.findMany({ where, orderBy: { listedAt: 'desc' } }),
      this.prisma.shortlist.findMany({ where: { userId }, select: { propertyId: true } }),
    ]);
    const ids = new Set(saved.map((s) => s.propertyId));
    return list.map((p) => ({ ...p, shortlisted: ids.has(p.id) }));
  }

  async get(userId: string, id: string) {
    const p = await this.prisma.property.findUnique({ where: { id } });
    if (!p) throw notFound('Property');
    const [saved, enquiry] = await Promise.all([
      this.prisma.shortlist.findFirst({ where: { userId, propertyId: id } }),
      this.prisma.enquiry.findFirst({ where: { userId, propertyId: id }, orderBy: { createdAt: 'desc' } }),
    ]);
    return { ...p, shortlisted: !!saved, enquiry: enquiry ? await this.confirm(enquiry.id) : null };
  }

  async toggleShortlist(userId: string, id: string) {
    const existing = await this.prisma.shortlist.findFirst({ where: { userId, propertyId: id } });
    if (existing) await this.prisma.shortlist.delete({ where: { id: existing.id } });
    else {
      if (!(await this.prisma.property.findUnique({ where: { id } }))) throw notFound('Property');
      await this.prisma.shortlist.create({ data: { userId, propertyId: id } });
    }
    return { shortlisted: !existing };
  }

  async shortlist(userId: string) {
    const rows = await this.prisma.shortlist.findMany({ where: { userId }, include: { property: true }, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => ({ ...r.property, shortlisted: true }));
  }

  async enquire(userId: string, id: string, b: { message: string; visitAt?: string }) {
    const p = await this.prisma.property.findUnique({ where: { id } });
    if (!p) throw notFound('Property');
    if (!b.message || b.message.trim().length < 5) throw invalid('MESSAGE', 'Write a short message for the agent', 'message');
    let visitAt: Date | undefined;
    if (b.visitAt) {
      visitAt = new Date(b.visitAt);
      if (isNaN(visitAt.getTime()) || visitAt.getTime() < Date.now() + 2 * 3600000) throw invalid('SLOT', 'Pick a visit time at least 2 hours from now', 'visitAt');
    }
    const enquiry = await this.prisma.enquiry.create({
      data: { id: `PR${digits(5)}`, userId, propertyId: id, message: b.message.trim(), visitAt, status: 'REQUESTED' },
    });
    await this.notifications.notify(userId, 'property', visitAt ? 'Site visit requested' : 'Enquiry sent', `${p.agentName} will get back to you about ${p.title}`, `/property/${id}`);
    if (p.agentId) {
      const when = visitAt ? visitAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : 'no visit time yet';
      await alertOwner(this.prisma, this.notifications, { id: p.agentId }, visitAt ? 'New site visit request' : 'New enquiry', `${p.title} · ${when}`, '/jobs');
    }
    return enquiry;
  }

  /** Simulated agent confirms the request after a short while; agents on the vendor app confirm it themselves. */
  private async confirm(enquiryId: string) {
    const e = await this.prisma.enquiry.findUniqueOrThrow({ where: { id: enquiryId }, include: { property: true } });
    if (e.status === 'REQUESTED' && Date.now() - e.createdAt.getTime() > 10000 && !(await isAppVendor(this.prisma, e.property.agentId))) {
      await this.notifications.notify(e.userId, 'property', e.visitAt ? 'Site visit confirmed' : 'Agent replied', `${e.property.agentName}: “Happy to help. See you then.”`, `/property/${e.propertyId}`);
      return this.prisma.enquiry.update({ where: { id: e.id }, data: { status: 'CONFIRMED' } });
    }
    return e;
  }

  async enquiries(userId: string) {
    const list = await this.prisma.enquiry.findMany({ where: { userId }, include: { property: true }, orderBy: { createdAt: 'desc' } });
    return Promise.all(list.map(async (e) => ({ ...(await this.confirm(e.id)), property: e.property })));
  }
}
