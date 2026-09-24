import 'reflect-metadata';
import { Controller, Get, Module, Res, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Response } from 'express';
import helmet from 'helmet';
import { join } from 'node:path';
import { map } from 'rxjs';
import { ApiController } from './api';
import { Database, jsonSafe } from './database';
import { LedgerService } from './ledger.service';
import { ApiGuard } from './security';
import { config, requireApiKey } from './config';

@Controller()
class HealthController {
  constructor(
    private readonly db: Database,
    private readonly security: ApiGuard,
  ) {}
  @Get('healthz') live() {
    return { status: 'ok' };
  }
  @Get('readyz') async ready(@Res() response: Response) {
    const results = await Promise.allSettled([this.db.$queryRaw`SELECT 1`, this.security.ping()]);
    const database = results[0].status === 'fulfilled';
    const redis = results[1].status === 'fulfilled';
    // API can accept durable requests even while RabbitMQ/Worker are unavailable.
    response
      .status(database ? 200 : 503)
      .json({ status: database ? 'ok' : 'unavailable', database, redis });
  }
}

@Module({
  controllers: [ApiController, HealthController],
  providers: [Database, LedgerService, ApiGuard],
})
class AppModule {}

async function bootstrap() {
  requireApiKey();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.use(helmet({ contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } } }));
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalInterceptors({ intercept: (_context, next) => next.handle().pipe(map(jsonSafe)) });
  app.useStaticAssets(join(process.cwd(), 'public'), { prefix: '/admin/' });
  const swagger = new DocumentBuilder()
    .setTitle('User Credit Payments')
    .setDescription(
      'Amounts are positive integer strings. All /api routes use a shared administrative API key. Reports use UTC and [from, to).',
    )
    .setVersion('1.0')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-API-Key' }, 'api-key')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger));
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
}
void bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
