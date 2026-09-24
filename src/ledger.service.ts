import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaymentRequest, Prisma, Transaction, TransactionType } from '@prisma/client';
import { Database } from './database';
import { CreditDto, PageDto, PaymentDto, ReportDto } from './dto';

export function idempotencyKey(value?: string): string {
  if (!value || !/^[A-Za-z0-9._:-]{1,100}$/.test(value)) {
    throw new BadRequestException(
      'Idempotency-Key must be 1-100 letters, digits, dots, underscores, colons or hyphens',
    );
  }
  return value;
}

function isUniqueConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class LedgerService {
  constructor(private readonly db: Database) {}

  createUser(name: string) {
    return this.db.user.create({ data: { name: name.trim() } });
  }

  async user(id: string) {
    const user = await this.db.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async users(query: PageDto) {
    const [items, total] = await this.db.$transaction([
      this.db.user.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.db.user.count(),
    ]);
    return { items, total, ...query };
  }

  async credit(userId: string, body: CreditDto, key: string) {
    const match = (entry: Transaction) => {
      if (
        entry.userId !== userId ||
        entry.amount !== BigInt(body.amount) ||
        entry.reference !== body.reference
      )
        throw new ConflictException('Idempotency key already used with different credit data');
      return entry;
    };
    const prior = await this.db.transaction.findUnique({ where: { idempotencyKey: key } });
    if (prior) return match(prior);
    await this.user(userId);
    try {
      return await this.db.$transaction(async (tx) => {
        // Unique key and balance increment commit together; a concurrent duplicate rolls both back.
        const entry = await tx.transaction.create({
          data: {
            userId,
            amount: BigInt(body.amount),
            reference: body.reference,
            type: 'CREDIT',
            idempotencyKey: key,
          },
        });
        await tx.user.update({
          where: { id: userId },
          data: { balance: { increment: BigInt(body.amount) } },
        });
        return entry;
      });
    } catch (error) {
      if (isUniqueConflict(error)) {
        const entry = await this.db.transaction.findUnique({ where: { idempotencyKey: key } });
        if (entry) return match(entry);
      }
      throw error;
    }
  }

  async submit(body: PaymentDto, key: string) {
    const match = (entry: PaymentRequest) => {
      if (
        entry.userId !== body.userId ||
        entry.amount !== BigInt(body.amount) ||
        entry.reference !== body.reference ||
        entry.description !== body.description
      )
        throw new ConflictException('Idempotency key already used with different payment data');
      return entry;
    };
    const prior = await this.db.paymentRequest.findUnique({ where: { idempotencyKey: key } });
    if (prior) return match(prior);
    await this.user(body.userId);
    try {
      return await this.db.paymentRequest.create({
        data: {
          ...body,
          amount: BigInt(body.amount),
          idempotencyKey: key,
          events: { create: { type: 'CREATED' } },
        },
      });
    } catch (error) {
      if (isUniqueConflict(error)) {
        const entry = await this.db.paymentRequest.findUnique({ where: { idempotencyKey: key } });
        if (entry) return match(entry);
      }
      throw error;
    }
  }

  async payment(id: string) {
    const payment = await this.db.paymentRequest.findUnique({
      where: { id },
      include: { transaction: true },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    return payment;
  }

  async events(id: string, query: PageDto) {
    await this.payment(id);
    const where = { paymentId: id };
    const [items, total] = await this.db.$transaction([
      this.db.paymentEvent.findMany({
        where,
        orderBy: { id: 'asc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.db.paymentEvent.count({ where }),
    ]);
    return { items, total, ...query };
  }

  async transactions(userId: string, query: PageDto) {
    await this.user(userId);
    const where = { userId };
    const [items, total] = await this.db.$transaction([
      this.db.transaction.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.db.transaction.count({ where }),
    ]);
    return { items, total, ...query };
  }

  async report(query: ReportDto) {
    const now = new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const to = query.to ? new Date(query.to) : now;
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to)
      throw new BadRequestException('from must be before to');
    const buckets = await this.db.$queryRaw<
      Array<{ period: Date; credits: string; debits: string }>
    >(Prisma.sql`
      SELECT date_trunc(${query.period}, created_at AT TIME ZONE 'UTC') AS period,
        COALESCE(SUM(amount) FILTER (WHERE type = 'CREDIT'), 0)::text AS credits,
        COALESCE(SUM(amount) FILTER (WHERE type = 'DEBIT'), 0)::text AS debits
      FROM transactions WHERE created_at >= ${from} AND created_at < ${to}
      GROUP BY 1 ORDER BY 1`);
    const totals = buckets.reduce(
      (acc, row) => ({
        credits: acc.credits + BigInt(row.credits),
        debits: acc.debits + BigInt(row.debits),
      }),
      { credits: 0n, debits: 0n },
    );
    return { from, to, timezone: 'UTC', period: query.period, buckets, totals };
  }

  async usage(userId: string, query: ReportDto) {
    const user = await this.user(userId);
    const now = new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const to = query.to ? new Date(query.to) : now;
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to)
      throw new BadRequestException('from must be before to');
    const sums = await this.db.transaction.groupBy({
      by: ['type'],
      where: { userId, createdAt: { gte: from, lt: to } },
      _sum: { amount: true },
      _count: true,
    });
    const total = (type: TransactionType) =>
      sums.find((item) => item.type === type)?._sum.amount ?? 0n;
    return {
      user,
      from,
      to,
      credits: total('CREDIT'),
      debits: total('DEBIT'),
      successfulPayments: sums.find((item) => item.type === 'DEBIT')?._count ?? 0,
    };
  }
}
