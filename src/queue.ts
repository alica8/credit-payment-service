import { connect, ChannelModel, ConfirmChannel } from 'amqplib';
import { Database } from './database';
import { config } from './config';
import { PaymentProcessor } from './processor';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class QueueRuntime {
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private stopped = false;
  private consumerTag?: string;
  private active = new Set<Promise<void>>();

  constructor(private readonly db: Database) {}

  async run() {
    while (!this.stopped) {
      try {
        const connection = await connect(config.rabbitUrl, { timeout: 5000 });
        this.connection = connection;
        let closed = false;
        connection.on('error', (error) => console.error('rabbit_connection_error', error.message));
        connection.on('close', () => {
          closed = true;
        });
        const channel = await connection.createConfirmChannel();
        this.channel = channel;
        channel.on('error', (error) => console.error('rabbit_channel_error', error.message));
        channel.on('close', () => {
          closed = true;
        });
        await channel.assertQueue(`${config.queue}.invalid`, { durable: true });
        await channel.assertQueue(config.queue, {
          durable: true,
          arguments: {
            'x-dead-letter-exchange': '',
            'x-dead-letter-routing-key': `${config.queue}.invalid`,
          },
        });
        await channel.prefetch(config.prefetch);
        const processor = new PaymentProcessor(this.db);
        const consumer = await channel.consume(
          config.queue,
          (message) => {
            if (!message) {
              closed = true;
              return;
            }
            const task = (async () => {
              let id: string;
              try {
                const body = JSON.parse(message.content.toString()) as { paymentId?: unknown };
                if (typeof body.paymentId !== 'string' || !uuid.test(body.paymentId))
                  throw new Error('Invalid payment ID');
                id = body.paymentId;
              } catch {
                channel.nack(message, false, false);
                return;
              }
              try {
                await processor.process(id);
                channel.ack(message);
              } catch (error) {
                console.error('payment_delivery_error', id, String(error));
                // Avoid a hot requeue loop when PostgreSQL is unavailable.
                await sleep(1000);
                if (!closed) channel.nack(message, false, true);
              }
            })().catch((error) => console.error('delivery_channel_closed', String(error)));
            this.active.add(task);
            void task.finally(() => this.active.delete(task));
          },
          { noAck: false },
        );
        this.consumerTag = consumer.consumerTag;
        console.log(JSON.stringify({ event: 'worker_ready', queue: config.queue }));
        while (!this.stopped && !closed) {
          try {
            await this.dispatch(channel);
          } catch (error) {
            console.error('dispatch_error', String(error));
          }
          await sleep(config.dispatchIntervalMs);
        }
      } catch (error) {
        console.error('worker_connection_error', String(error));
      } finally {
        await this.connection?.close().catch(() => undefined);
        this.channel = undefined;
        this.connection = undefined;
      }
      if (!this.stopped) await sleep(2000);
    }
  }

  async dispatch(channel: ConfirmChannel) {
    const cutoff = new Date(Date.now() - config.republishAfterMs);
    const due = await this.db.paymentRequest.findMany({
      where: {
        OR: [
          { status: 'PENDING' },
          {
            status: 'QUEUED',
            OR: [{ lastPublishedAt: null }, { lastPublishedAt: { lte: cutoff } }],
          },
          {
            status: 'FAILED',
            retryable: true,
            attempts: { lt: config.maxAttempts },
            nextAttemptAt: { lte: new Date() },
          },
        ],
      },
      orderBy: { updatedAt: 'asc' },
      take: 100,
      select: { id: true },
    });
    for (const item of due) {
      if (this.stopped) break;
      const publish = await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM payment_requests WHERE id = ${item.id}::uuid FOR UPDATE`;
        const payment = await tx.paymentRequest.findUniqueOrThrow({ where: { id: item.id } });
        if (payment.status === 'SUCCEEDED' || payment.status === 'PROCESSING') return false;
        if (
          payment.status === 'FAILED' &&
          (!payment.retryable ||
            payment.attempts >= config.maxAttempts ||
            !payment.nextAttemptAt ||
            payment.nextAttemptAt > new Date())
        )
          return false;
        if (
          payment.status === 'QUEUED' &&
          payment.lastPublishedAt &&
          payment.lastPublishedAt > cutoff
        )
          return false;
        if (payment.status === 'FAILED') {
          await tx.paymentEvent.create({
            data: {
              paymentId: item.id,
              type: 'RETRY_TRIGGERED',
              details: { nextAttempt: payment.attempts + 1 },
            },
          });
        }
        if (payment.status !== 'QUEUED')
          await tx.paymentEvent.create({ data: { paymentId: item.id, type: 'QUEUED' } });
        // A durable dispatch timestamp is a short lease, not proof of RabbitMQ delivery.
        // A crash before/after publish is repaired by scanning stale QUEUED rows.
        await tx.paymentRequest.update({
          where: { id: item.id },
          data: { status: 'QUEUED', lastPublishedAt: new Date(), nextAttemptAt: null },
        });
        return true;
      });
      if (publish) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Publisher confirm timed out')), 5000);
          channel.sendToQueue(
            config.queue,
            Buffer.from(JSON.stringify({ paymentId: item.id })),
            { persistent: true, contentType: 'application/json', messageId: item.id },
            (error) => {
              clearTimeout(timer);
              error ? reject(error) : resolve();
            },
          );
        });
      }
    }
  }

  async stop() {
    this.stopped = true;
    if (this.consumerTag) await this.channel?.cancel(this.consumerTag).catch(() => undefined);
    await Promise.allSettled([...this.active]);
    await this.connection?.close().catch(() => undefined);
  }
}
