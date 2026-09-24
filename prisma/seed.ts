import 'dotenv/config';
import { Database } from '../src/database';
import { LedgerService } from '../src/ledger.service';

async function main() {
  const db = new Database();
  try {
    const user = await db.user.upsert({ where: { id: '11111111-1111-4111-8111-111111111111' }, update: {}, create: { id: '11111111-1111-4111-8111-111111111111', name: 'Demo User' } });
    await new LedgerService(db).credit(user.id, { amount: '100000', reference: 'SEED' }, 'seed-demo-credit');
    console.log(`Demo user: ${user.id}; seed is idempotent`);
  } finally { await db.$disconnect(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
