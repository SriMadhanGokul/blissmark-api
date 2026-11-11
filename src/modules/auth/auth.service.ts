import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';

import { invalid, unauthorized } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { addDays, code, digits } from '../../common/util';
import { NotificationsService } from '../notifications/notifications.service';
import { UsersService } from '../users/users.service';

const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_AFTER_S = 30;
const MAX_ATTEMPTS = 5;
const MAX_DEPTH = 30;

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private users: UsersService,
    private notifications: NotificationsService,
  ) {}

  private normalize(phone: string) {
    const p = (phone ?? '').replace(/\D/g, '').slice(-10);
    if (!/^[6-9]\d{9}$/.test(p)) throw invalid('PHONE_INVALID', 'Enter a valid 10-digit mobile number', 'phone');
    return p;
  }

  async sendOtp(phone: string, channel: 'sms' | 'whatsapp') {
    const p = this.normalize(phone);
    const existing = await this.prisma.otp.findUnique({ where: { id: p } });
    if (existing && existing.expiresAt.getTime() - OTP_TTL_MS + RESEND_AFTER_S * 1000 > Date.now()) {
      throw invalid('OTP_TOO_SOON', 'Please wait a few seconds before asking for a new code', 'phone');
    }
    const otp = process.env.DEV_OTP || digits(6);
    await this.prisma.otp.upsert({
      where: { id: p },
      create: { id: p, codeHash: hash(otp), expiresAt: new Date(Date.now() + OTP_TTL_MS) },
      update: { codeHash: hash(otp), attempts: 0, expiresAt: new Date(Date.now() + OTP_TTL_MS) },
    });
    // TODO(MSG91): send `otp` over SMS / WhatsApp. In development the code is DEV_OTP.
    if (!process.env.DEV_OTP) console.log(`[otp] ${channel} ${p}: ${otp}`);
    return { resendIn: RESEND_AFTER_S };
  }

  async verifyOtp(phone: string, otp: string) {
    const p = this.normalize(phone);
    const row = await this.prisma.otp.findUnique({ where: { id: p } });
    const wrong = invalid('OTP_INVALID', 'That code is not right. Please try again.', 'otp');
    if (!row || row.expiresAt < new Date()) throw invalid('OTP_EXPIRED', 'This code has expired. Ask for a new one.', 'otp');
    if (row.attempts >= MAX_ATTEMPTS) throw invalid('OTP_LOCKED', 'Too many wrong attempts. Ask for a new code.', 'otp');
    if (row.codeHash !== hash(otp ?? '')) {
      await this.prisma.otp.update({ where: { id: p }, data: { attempts: { increment: 1 } } });
      throw wrong;
    }
    await this.prisma.otp.delete({ where: { id: p } });
    const user = await this.prisma.user.findUnique({ where: { phone: p }, include: { member: true } });
    if (user?.blocked) throw invalid('BLOCKED', 'This account is blocked. Contact Blissmark support.', 'phone');
    if (user?.member) return { status: 'existing' as const, token: this.token(user.id), user: await this.users.dto(user.id) };
    return { status: 'new' as const, signupToken: this.jwt.sign({ phone: p, purpose: 'signup' }, { expiresIn: '15m' }) };
  }

  async validateSponsor(raw: string) {
    const c = (raw ?? '').trim().toUpperCase();
    const m = await this.prisma.member.findUnique({ where: { referralCode: c }, include: { user: true } });
    if (!m || !m.active) throw invalid('SPONSOR_INVALID', 'We could not find this sponsor code', 'code');
    return { code: m.referralCode, name: m.user.name ?? 'Blissmark member', city: m.user.city, memberSince: String(m.joinedAt.getFullYear()), photo: m.user.photo };
  }

  /** Creates the user and binds the sponsor: one transaction builds the 30-level lineage. */
  async register(signupToken: string, sponsorCode: string) {
    let phone: string;
    try {
      const payload = this.jwt.verify<{ phone: string; purpose: string }>(signupToken);
      if (payload.purpose !== 'signup') throw new Error();
      phone = payload.phone;
    } catch {
      throw unauthorized();
    }
    const sponsor = await this.prisma.member.findUnique({ where: { referralCode: sponsorCode.trim().toUpperCase() } });
    if (!sponsor) throw invalid('SPONSOR_INVALID', 'We could not find this sponsor code', 'code');

    const userId = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { phone }, include: { member: true } });
      if (existing?.member) return existing.id; // already registered: idempotent
      const user = existing ?? (await tx.user.create({ data: { phone } }));
      let referralCode = `BLISS-${code(6)}`;
      while (await tx.member.findUnique({ where: { referralCode } })) referralCode = `BLISS-${code(6)}`;
      const member = await tx.member.create({ data: { userId: user.id, referralCode, sponsorId: sponsor.id } });
      // lineage: self (depth 0) + every ancestor of the sponsor shifted by one level, capped at 30
      const ancestors = await tx.referralClosure.findMany({ where: { descendantId: sponsor.id, depth: { lt: MAX_DEPTH } } });
      await tx.referralClosure.createMany({
        data: [
          { ancestorId: member.id, descendantId: member.id, depth: 0 },
          ...ancestors.map((a) => ({ ancestorId: a.ancestorId, descendantId: member.id, depth: a.depth + 1 })),
        ],
      });
      await tx.subscription.create({ data: { userId: user.id, amount: 9900, status: 'active', nextBilling: addDays(new Date(), 30) } });
      await this.notifications.notify(user.id, 'account', 'Welcome to Blissmark', 'Your account is ready. Share your referral code to grow your network.', '/income', tx);
      return user.id;
    });
    return { token: this.token(userId), user: await this.users.dto(userId) };
  }

  private token(userId: string) {
    return this.jwt.sign({ sub: userId }, { expiresIn: '30d' });
  }
}
