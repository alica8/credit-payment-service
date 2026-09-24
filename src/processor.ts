import { PaymentRequest, Prisma } from '@prisma/client';
import { Database } from './database';
import { config } from './config';
import { Failure, isTransientDatabaseError, retryDelay, simulateFailure } from './policy';

type Tx = Prisma.TransactionClient;

export class PaymentProcessor {
  constructor(private readonly db: Database) {}

  private async lock(tx: Tx, id: string) {
    await tx.$queryRaw`SELECT id FROM payment_requests WHERE id = ${id}::uuid FOR UPDATE`;
    return tx.paymentRequest.findUnique({ where: { id } });
  }

  private async fail(tx: Tx, payment: PaymentRequest, attempt: number, failure: Failure) {
    const retry = failure.retryable && attempt < config.maxAttempts;
    await tx.paymentRequest.update({
      where: { id: payment.id },
      data: {
        status: 'FAILED',
        attempts: attempt,
        failureCode: failure.code,
        failureReason: failure.reason,
        retryable: failure.retryable,
        nextAttemptAt: retry
          ? new Date(Date.now() + retryDelay(attempt, config.retryBaseMs))
          : null,
      },
    });
    await tx.paymentEvent.create({
      data: {
        paymentId: payment.id,
        type: 'FAILED',
        details: { ...failure, attempt, retryScheduled: retry },
      },
    });
  }

  async process(id: string): Promise<void> {
    try {
      await this.db.$transaction(
        async (tx) => {
          // Serialize duplicate deliveries on the PAYMENT row, then different payments on the USER row.
          const payment = await this.lock(tx, id);
          if (!payment || payment.status !== 'QUEUED') return;
          const attempt = payment.attempts + 1;
          await tx.paymentRequest.update({
            where: { id },
            data: { status: 'PROCESSING', attempts: attempt },
          });
          await tx.paymentEvent.create({
            data: { paymentId: id, type: 'PROCESSING_STARTED', details: { attempt } },
          });
          const users = await tx.$queryRaw<
            Array<{ balance: bigint }>
          >`SELECT balance FROM users WHERE id = ${payment.userId}::uuid FOR UPDATE`;
          if (!users[0] || users[0].balance < payment.amount) {
            await this.fail(tx, payment, attempt, {
              code: 'INSUFFICIENT_FUNDS',
              reason: 'Insufficient balance',
              retryable: false,
            });
            return;
          }
          const simulated = simulateFailure(payment.reference, payment.amount, attempt, {
            enabled: config.simulationEnabled,
            scale: config.simulationScale,
          });
          if (simulated) {
            await this.fail(tx, payment, attempt, simulated);
            return;
          }
          const changed = await tx.user.updateMany({
            where: { id: payment.userId, balance: { gte: payment.amount } },
            data: { balance: { decrement: payment.amount } },
          });
          if (changed.count !== 1) throw new Error('Balance invariant violated');
          await tx.transaction.create({
            data: {
              userId: payment.userId,
              paymentId: id,
              type: 'DEBIT',
              amount: payment.amount,
              reference: payment.reference,
            },
          });
          await tx.paymentRequest.update({
            where: { id },
            data: {
              status: 'SUCCEEDED',
              failureCode: null,
              failureReason: null,
              retryable: false,
              nextAttemptAt: null,
            },
          });
          await tx.paymentEvent.create({
            data: { paymentId: id, type: 'SUCCEEDED', details: { attempt } },
          });
        },
        { timeout: 15000, maxWait: 15000 },
      );
    } catch (error) {
      // The financial transaction has rolled back. Persist failure separately before acknowledging.
      // If the database is still down this also throws; RabbitMQ retains the message.
      await this.db.$transaction(
        async (tx) => {
          const payment = await this.lock(tx, id);
          if (!payment || payment.status !== 'QUEUED') return;
          const retryable = isTransientDatabaseError(error);
          const attempt = payment.attempts + 1;
          await tx.paymentEvent.create({
            data: { paymentId: id, type: 'PROCESSING_STARTED', details: { attempt } },
          });
          await this.fail(tx, payment, attempt, {
            code: retryable ? 'TECHNICAL_ERROR' : 'INTERNAL_ERROR',
            reason: retryable
              ? 'Temporary database failure'
              : 'Unexpected processing error; inspect worker logs',
            retryable,
          });
        },
        { timeout: 15000, maxWait: 15000 },
      );
      console.error(
        JSON.stringify({ event: 'payment_processing_error', paymentId: id, error: String(error) }),
      );
    }
  }
}
