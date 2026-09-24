import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  OnModuleDestroy,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import Redis from 'ioredis';
import { Request, Response } from 'express';
import { config } from './config';

@Injectable()
export class ApiGuard implements CanActivate, OnModuleDestroy {
  private readonly redis = new Redis(config.redisUrl, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  constructor() {
    this.redis.on('error', (error) => console.error('redis_error', error.message));
  }

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    const given = request.header('x-api-key') ?? '';
    const expected = config.apiKey;
    if (
      !expected ||
      Buffer.byteLength(given) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(given), Buffer.from(expected))
    ) {
      throw new UnauthorizedException('Valid X-API-Key required');
    }
    // Atomic increment + expiry avoids immortal counters after a crash.
    const key = `rate:${request.ip}:${Math.floor(Date.now() / 60000)}`;
    try {
      const count = Number(
        await this.redis.eval(
          "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n",
          1,
          key,
        ),
      );
      if (count > config.rateLimit) {
        context.switchToHttp().getResponse<Response>().setHeader('Retry-After', '60');
        throw new HttpException('Rate limit exceeded', 429);
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      // Rate limiting fails open; money safety is enforced by PostgreSQL, never Redis.
      console.error('rate_limit_unavailable');
    }
    return true;
  }
  async ping() {
    return this.redis.ping();
  }
  async onModuleDestroy() {
    this.redis.disconnect();
  }
}
