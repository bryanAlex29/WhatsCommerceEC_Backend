import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { Queue, Worker } from 'bullmq';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaRecoveryDeliveryPort } from '../src/modules/auth/persistence/recovery-adapter.js';
import { deliverRecovery, RecoveryCrypto } from '../src/modules/auth/recovery.js';
import { gmailRecoveryMailer } from '../src/modules/auth/recovery-mailer.js';
import { recoveryConfig } from './recovery-config.js';
import { GmailApiMailer, GmailApiError } from '../src/modules/auth/gmail-api-mailer.js';

async function main() {
  if (process.argv.length !== 2) throw new Error();
  const { config } = recoveryConfig(fileURLToPath(new URL('../', import.meta.url)));
  const pool = new Pool({ connectionString: config.RECOVERY_DELIVERY_DATABASE_URL, max: 2,
    connectionTimeoutMillis: 3000, statement_timeout: 4000, query_timeout: 5000 });
  pool.on('error', () => {});
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: 'app_private', onConnectionError: () => {}, onPoolError: () => {} }), log: [] });
  const port = new PrismaRecoveryDeliveryPort(prisma);
  const crypto = new RecoveryCrypto(Buffer.from(config.RECOVERY_MAC_KEY!, 'base64url'), Buffer.from(config.RECOVERY_ENCRYPTION_KEY!, 'base64url'));
  const provider = config.RECOVERY_MAIL_TRANSPORT === 'gmail-api' ? new GmailApiMailer({
    sender: config.SMTP_USER!, clientId: config.GMAIL_OAUTH_CLIENT_ID!, clientSecret: config.GMAIL_OAUTH_CLIENT_SECRET!, refreshToken: config.GMAIL_OAUTH_REFRESH_TOKEN!,
  }) : gmailRecoveryMailer(config.SMTP_USER!, config.SMTP_APP_PASSWORD!);
  const mailer = { async send(email: string, code: string) {
    try { return await provider.send(email, code); }
    catch (error) {
      // Código allowlist sin direcciones, cuerpo, tokens ni diagnóstico HTTP crudo.
      const safeCode = error instanceof GmailApiError ? error.code : 'RECOVERY_DELIVERY_UNCONFIRMED';
      console.error(safeCode); return false;
    }
  } };
  const redis = new URL(config.REDIS_URL!);
  const connection = { host: redis.hostname, port: Number(redis.port || '6379'),
    username: redis.username ? decodeURIComponent(redis.username) : undefined,
    password: redis.password ? decodeURIComponent(redis.password) : undefined,
    db: Number(redis.pathname.slice(1) || '0'), ...(redis.protocol === 'rediss:' ? { tls: {} } : {}) };
  const queue = new Queue('wc-password-recovery', { connection });
  const worker = new Worker<{ id: string }>('wc-password-recovery', async job => {
    // No payloads ni correos/códigos en BullMQ. La DB revalida lease/vigencia.
    if (typeof job.data.id !== 'string' || !/^[0-9a-f-]{36}$/.test(job.data.id)) return;
    await deliverRecovery(job.data.id, port, crypto, mailer);
  }, { connection, concurrency: 1 });
  queue.on('error', () => {}); worker.on('error', () => {}); worker.on('failed', () => {});
  let stopping = false; let reconciling = false;
  const reconcile = async () => {
    if (stopping || reconciling) return;
    reconciling = true;
    try { for (const id of await port.pending()) await queue.add('deliver', { id }, { jobId: id, removeOnComplete: true, removeOnFail: true }); }
    catch { console.error('RECOVERY_RECONCILIATION_UNAVAILABLE'); }
    finally { reconciling = false; }
  };
  const timer = setInterval(() => { void reconcile(); }, 5000);
  const close = async () => {
    if (stopping) return;
    stopping = true; clearInterval(timer);
    await worker.close(); await queue.close(); await prisma.$disconnect(); await pool.end();
  };
  process.once('SIGINT', () => { void close(); }); process.once('SIGTERM', () => { void close(); });
  await reconcile();
  console.log(`RECOVERY_WORKER_STARTED transport=${config.RECOVERY_MAIL_TRANSPORT ?? 'smtp'}. No confirma entrega de mensajes.`);
}
await main().catch(() => { console.error('RECOVERY_WORKER_FAILED'); process.exitCode = 1; });
