import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
const schema = 'test_' + randomUUID().replaceAll('-', '');
const url = new URL(process.env.DATABASE_URL);
url.searchParams.set('schema', schema);
const env = { ...process.env, DATABASE_URL: url.toString(), SIMULATION_ENABLED: 'false' };
const db = new PrismaClient({ datasourceUrl: url.toString() });
try {
  const migrate = spawnSync(
    process.execPath,
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
    { env, stdio: 'inherit' },
  );
  if (migrate.status !== 0) throw new Error('Test schema migration failed');
  const tests = spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=1', 'dist/test/integration.test.js'],
    { env, stdio: 'inherit' },
  );
  process.exitCode = tests.status ?? 1;
} finally {
  // Schema name is generated here, never taken from user input. Application data is untouched.
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await db.$disconnect();
}
