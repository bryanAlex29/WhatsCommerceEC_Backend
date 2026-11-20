import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { Redis } from 'ioredis';
import { validateEnvironment } from '../src/config/environment.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaInvitationDeliveryPort } from '../src/modules/invitations/persistence.js';
import { InvitationCrypto } from '../src/modules/invitations/invitations.js';
import { RedisInvitationLimits } from '../src/modules/invitations/limits.js';
import { mailpitInvitationMailer } from '../src/modules/invitations/mailpit.js';
import { startInvitationWorker } from '../src/modules/invitations/worker.js';

async function main() {
  if (process.argv.length !== 2) throw new Error();
  // Explicit environment only. Never inherit/read a private recovery DEV profile.
  const config = validateEnvironment(process.env);
  if (!config.INVITATIONS_ENABLED) throw new Error();
  const pool = new Pool({ connectionString: config.INVITATION_DELIVERY_DATABASE_URL, max: 2,
    connectionTimeoutMillis: 3000, statement_timeout: 4000, query_timeout: 5000 });
  pool.on('error', () => {});
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: 'app_private', onConnectionError: () => {}, onPoolError: () => {} }), log: [], errorFormat: 'minimal' });
  const redis = new Redis(config.REDIS_URL!, { lazyConnect: true, connectTimeout: 3000, commandTimeout: 3000,
    maxRetriesPerRequest: 0, enableOfflineQueue: false, autoResendUnfulfilledCommands: false, retryStrategy: () => null });
  redis.on('error', () => {});
  let worker: Awaited<ReturnType<typeof startInvitationWorker>> | undefined;
  try {
    await redis.connect();
    const limits = new RedisInvitationLimits({ eval: (script, keys, args) => redis.eval(script, keys.length, ...keys, ...args) }, Buffer.from(config.AUTH_RATE_LIMIT_KEY!, 'base64url'));
    worker = await startInvitationWorker(config.REDIS_URL!, new PrismaInvitationDeliveryPort(prisma),
      new InvitationCrypto(Buffer.from(config.INVITATION_OUTBOX_KEY!, 'base64url')), mailpitInvitationMailer(config.INVITATION_MAILPIT_PORT!), limits);
    let stopping = false;
    const close = async () => {
      if (stopping) return; stopping = true;
      try { await worker!.close(); } finally { redis.disconnect(); await prisma.$disconnect(); await pool.end(); }
    };
    process.once('SIGINT', () => { void close(); }); process.once('SIGTERM', () => { void close(); });
    console.log('INVITATION_WORKER_STARTED capture=loopback. No confirma entrega real.');
  } catch {
    await worker?.close(); redis.disconnect(); await prisma.$disconnect(); await pool.end(); throw new Error();
  }
}
await main().catch(() => { console.error('INVITATION_WORKER_FAILED'); process.exitCode = 1; });
