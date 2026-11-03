import { Injectable } from '@nestjs/common';
import type { Language } from '@prisma/client';

import { invalid, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';

export type UserDto = {
  id: string;
  phone: string;
  name: string | null;
  photo: string | null;
  city: string;
  language: Language;
  referralCode: string;
  sponsorName: string;
  kycVerified: boolean;
};

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async dto(userId: string): Promise<UserDto> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { member: { include: { sponsor: { include: { user: true } } } } },
    });
    if (!u) throw notFound('User');
    return {
      id: u.id,
      phone: u.phone,
      name: u.name,
      photo: u.photo,
      city: u.city,
      language: u.language,
      referralCode: u.member?.referralCode ?? '',
      sponsorName: u.member?.sponsor?.user.name ?? 'Blissmark',
      kycVerified: u.kycVerified,
    };
  }

  async update(userId: string, patch: { name?: string; language?: Language; city?: string }) {
    if (patch.name !== undefined && patch.name.trim().length < 2) throw invalid('NAME_SHORT', 'Please enter your full name', 'name');
    await this.prisma.user.update({ where: { id: userId }, data: { ...patch, name: patch.name?.trim() } });
    return this.dto(userId);
  }

  addresses(userId: string) {
    return this.prisma.address.findMany({ where: { userId }, orderBy: [{ isDefault: 'desc' }, { label: 'asc' }] });
  }

  async addAddress(userId: string, a: { label: string; line1: string; city: string; pincode: string; isDefault?: boolean }) {
    if (!/^\d{6}$/.test(a.pincode)) throw invalid('PINCODE', 'Enter a valid 6-digit pincode', 'pincode');
    const count = await this.prisma.address.count({ where: { userId } });
    const makeDefault = a.isDefault || count === 0;
    if (makeDefault) await this.prisma.address.updateMany({ where: { userId }, data: { isDefault: false } });
    return this.prisma.address.create({ data: { ...a, userId, isDefault: makeDefault } });
  }

  async setDefaultAddress(userId: string, id: string) {
    const a = await this.prisma.address.findFirst({ where: { id, userId } });
    if (!a) throw notFound('Address');
    await this.prisma.address.updateMany({ where: { userId }, data: { isDefault: false } });
    return this.prisma.address.update({ where: { id }, data: { isDefault: true } });
  }

  async deleteAddress(userId: string, id: string) {
    const a = await this.prisma.address.findFirst({ where: { id, userId } });
    if (!a) throw notFound('Address');
    await this.prisma.address.delete({ where: { id } });
    if (a.isDefault) {
      const next = await this.prisma.address.findFirst({ where: { userId } });
      if (next) await this.prisma.address.update({ where: { id: next.id }, data: { isDefault: true } });
    }
    return { ok: true };
  }

  async defaultAddress(userId: string) {
    return (await this.prisma.address.findFirst({ where: { userId, isDefault: true } })) ?? this.prisma.address.findFirst({ where: { userId } });
  }
}
