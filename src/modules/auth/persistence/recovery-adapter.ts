import type { PrismaClient } from '../../../generated/prisma/client.js';
import { unavailable } from '../errors.js';
import { uuid } from '../input.js';
import type { RecoveryPort, RecoveryDeliveryPort, SealedRecovery } from '../recovery.js';
import { ScopedPersistence } from './adapters.js';

function one(rows: unknown): unknown {
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object') return unavailable();
  return (rows[0] as { result?: unknown }).result;
}
function envelope(rows: unknown): string {
  const value = one(rows);
  if (!value || typeof value !== 'object' || typeof (value as { code?: unknown }).code !== 'string') return unavailable();
  return (value as { code: string }).code;
}
export class PrismaRecoveryPort extends ScopedPersistence implements RecoveryPort {
  constructor(client: PrismaClient) { super(client, 'wc_identity'); }
  async request(email: string, id: string, mac: string, sealed: SealedRecovery): Promise<void> {
    await this.transaction('recovery_request', undefined, undefined, async tx => {
      const code = envelope(await tx.$queryRaw`SELECT app_api.recovery_request(${email}::text,${id}::uuid,${mac}::text,
        ${sealed.payload}::text,${sealed.nonce}::text,${sealed.tag}::text) AS result`);
      if (code !== 'OK') unavailable();
    });
  }
  reset(email: string, mac: string, passwordHash: string): Promise<boolean> {
    return this.transaction('recovery_reset', undefined, undefined, async tx => {
      const code = envelope(await tx.$queryRaw`SELECT app_api.recovery_reset(${email}::text,${mac}::text,${passwordHash}::text) AS result`);
      if (code !== 'OK' && code !== 'INVALID_RECOVERY_CODE') return unavailable();
      return code === 'OK';
    });
  }
}
export class PrismaRecoveryDeliveryPort extends ScopedPersistence implements RecoveryDeliveryPort {
  constructor(client: PrismaClient) { super(client, 'wc_delivery'); }
  pending(): Promise<string[]> {
    return this.transaction('recovery_pending', undefined, undefined, async tx => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT app_api.recovery_pending() AS id`;
      if (rows.length > 20 || rows.some(row => !uuid.test(row.id))) return unavailable();
      return rows.map(row => row.id);
    });
  }
  claim(id: string, lease: string): Promise<SealedRecovery | null> {
    if (!uuid.test(id) || !uuid.test(lease)) return Promise.reject(new Error('Referencia inválida'));
    return this.transaction('recovery_claim', undefined, undefined, async tx => {
      const value = one(await tx.$queryRaw`SELECT app_api.recovery_claim(${id}::uuid,${lease}::uuid) AS result`);
      if (value === null) return null;
      if (!value || typeof value !== 'object') return unavailable();
      const row = value as Record<string, unknown>;
      if (typeof row.payload !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(row.payload) ||
        typeof row.nonce !== 'string' || !/^[0-9a-f]{24}$/.test(row.nonce) || typeof row.tag !== 'string' || !/^[0-9a-f]{32}$/.test(row.tag)) return unavailable();
      return { payload: row.payload, nonce: row.nonce, tag: row.tag };
    });
  }
  async finish(id: string, lease: string, accepted: boolean): Promise<void> {
    await this.transaction('recovery_finish', undefined, undefined, async tx => {
      await tx.$queryRaw`SELECT app_api.recovery_finish(${id}::uuid,${lease}::uuid,${accepted}::boolean)::text AS result`;
    });
  }
}
