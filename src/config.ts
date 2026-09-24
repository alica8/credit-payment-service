import 'dotenv/config';

function integer(name: string, fallback: number, min = 1): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`Invalid ${name}`);
  return value;
}

export const config = {
  port: integer('PORT', 3000),
  apiKey: process.env.API_KEY ?? '',
  rabbitUrl: process.env.RABBITMQ_URL ?? 'amqp://credit:credit_local@localhost:5672',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  maxAttempts: integer('MAX_ATTEMPTS', 3),
  retryBaseMs: integer('RETRY_BASE_MS', 1000),
  dispatchIntervalMs: integer('DISPATCH_INTERVAL_MS', 1000),
  republishAfterMs: integer('REPUBLISH_AFTER_MS', 10000),
  prefetch: integer('WORKER_PREFETCH', 8),
  rateLimit: integer('RATE_LIMIT_PER_MINUTE', 120),
  simulationEnabled: process.env.SIMULATION_ENABLED === 'true',
  simulationScale: integer('SIMULATION_SCALE_AMOUNT', 100000),
  queue: 'credit.payments',
};

export function requireApiKey() {
  if (config.apiKey.length < 16) throw new Error('API_KEY must contain at least 16 characters');
}
