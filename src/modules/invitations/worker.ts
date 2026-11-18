import { Queue, Worker } from 'bullmq';
import { uuid } from '../auth/input.js';
import type { DeliveryPort, InvitationCrypto, InvitationMailer, ReservationLimits } from './invitations.js';
import { deliverInvitation, reconcileReservations } from './invitations.js';

/** PG reserva intentos/backoff; BullMQ solo transporta referencias recuperables. */
export async function startInvitationWorker(redisUrl: string, port: DeliveryPort, crypto: InvitationCrypto,
  mailer: InvitationMailer, limits: ReservationLimits) {
  const redis = new URL(redisUrl);
  if (!['redis:', 'rediss:'].includes(redis.protocol)) throw new Error('INVITATION_QUEUE_CONFIG_INVALID');
  const connection = { host: redis.hostname, port: Number(redis.port || '6379'),
    username: redis.username ? decodeURIComponent(redis.username) : undefined,
    password: redis.password ? decodeURIComponent(redis.password) : undefined,
    db: Number(redis.pathname.slice(1) || '0'), ...(redis.protocol === 'rediss:' ? { tls: {} } : {}) };
  const queue = new Queue('wc-initial-invitations', { connection });
  const worker = new Worker<{ id: string; generation: number }>('wc-initial-invitations', async job => {
    if (typeof job.data.id !== 'string' || !uuid.test(job.data.id) || !Number.isSafeInteger(job.data.generation) || job.data.generation < 1) return;
    await deliverInvitation(job.data.id, job.data.generation, port, crypto, mailer);
  }, { connection, concurrency: 1 });
  queue.on('error', () => {}); worker.on('error', () => {}); worker.on('failed', () => {});
  let stopping = false; let reconciling = false;
  const reconcile = async () => {
    if (stopping || reconciling) return;
    reconciling = true;
    try {
      await reconcileReservations(limits, port);
      for (const { id, generation } of await port.pending()) {
        await queue.add('deliver', { id, generation }, { jobId: `${id}-${generation}`, removeOnComplete: true, removeOnFail: true });
      }
    } catch { console.error('INVITATION_RECONCILIATION_UNAVAILABLE'); }
    finally { reconciling = false; }
  };
  // Always reconcile, even after publication: lost Redis jobs cannot lose PG work.
  const timer = setInterval(() => { void reconcile(); }, 5000);
  await reconcile();
  return { reconcile, async close() {
    if (stopping) return;
    stopping = true; clearInterval(timer);
    while (reconciling) await new Promise<void>(resolve => setImmediate(resolve));
    await worker.close(); await queue.close();
  } };
}
