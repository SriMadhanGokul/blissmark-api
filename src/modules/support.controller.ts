import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsIn, IsString, MaxLength } from 'class-validator';

import { UserId } from '../common/auth';
import { invalid } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { NotificationsService } from './notifications/notifications.service';

export const SUPPORT_TOPICS = ['order', 'booking', 'wallet', 'income', 'account', 'other'] as const;

class MemberTicketDto {
  @IsIn(SUPPORT_TOPICS as unknown as string[]) topic!: (typeof SUPPORT_TOPICS)[number];
  @IsString() @MaxLength(120) subject!: string;
  @IsString() @MaxLength(1000) message!: string;
}

/** Help and support for members: the customer app raises tickets, the admin panel's Support page answers them. */
@Controller('support')
export class SupportController {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  @Get() list(@UserId() userId: string) {
    return this.prisma.supportTicket.findMany({
      where: { userId },
      select: { id: true, topic: true, subject: true, message: true, status: true, reply: true, repliedAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  @Post() async raise(@UserId() userId: string, @Body() b: MemberTicketDto) {
    const subject = b.subject.trim();
    const message = b.message.trim();
    if (subject.length < 3) throw invalid('SUBJECT', 'Add a short subject', 'subject');
    if (message.length < 10) throw invalid('MESSAGE', 'Tell us a little more so we can help', 'message');
    const open = await this.prisma.supportTicket.count({ where: { userId, status: 'open' } });
    if (open >= 5) throw invalid('TOO_MANY', 'You already have 5 open requests. We will reply to those first.', 'message');
    await this.prisma.supportTicket.create({ data: { userId, topic: b.topic, subject, message } });
    await this.notifications.notify(userId, 'account', 'Request received', 'Our support team replies within 24 hours.', '/support');
    return this.list(userId);
  }
}
