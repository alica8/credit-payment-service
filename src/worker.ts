import 'reflect-metadata';
import { Database } from './database';
import { QueueRuntime } from './queue';

async function bootstrap() {
  const db = new Database();
  await db.$connect();
  const runtime = new QueueRuntime(db);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await runtime.stop();
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  await runtime.run();
  await db.$disconnect();
}
void bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
