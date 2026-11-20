import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Principal } from '../auth/crypto.js';
import { AuthError, unavailable } from '../auth/errors.js';
import { canonicalEmail, uuid } from '../auth/input.js';
import { ScopedPersistence } from '../auth/persistence/adapters.js';
import { RateLimitError } from '../auth/rate-limit.js';
import type { Acceptance, Claimed, DeliveryPort, InvitationPort, Plan, Receipt, Sealed } from './invitations.js';

function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return unavailable();
  return v as Record<string, unknown>;
}
function id(v: unknown): string { if (typeof v !== 'string' || !uuid.test(v)) return unavailable(); return v; }
function generation(v: unknown): number { if (!Number.isSafeInteger(v) || Number(v) < 1 || Number(v) > 2147483647) return unavailable(); return Number(v); }
function date(v: unknown): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) return unavailable();
  return v;
}
function one(rows: unknown): unknown {
  if (!Array.isArray(rows) || rows.length !== 1) return unavailable();
  return object(rows[0]).result;
}
function value(rows: unknown): unknown {
  const result = object(one(rows));
  if (result.code === 'OK') return result.value;
  if (result.code === 'RATE_LIMITED' && Number.isSafeInteger(result.retryAfter) && Number(result.retryAfter) >= 1) throw new RateLimitError(Number(result.retryAfter));
  const statuses: Record<string, number> = { UNAUTHENTICATED: 401, SESSION_EXPIRED: 401, SESSION_REVOKED: 401, FORBIDDEN: 403,
    RESOURCE_NOT_FOUND: 404, INVITATION_NOT_FOUND: 404, COMPANY_SUSPENDED: 403, STATE_CONFLICT: 409, INVITATION_REQUIRES_LOGIN: 409 };
  if (typeof result.code !== 'string' || !statuses[result.code]) return unavailable();
  throw new AuthError(statuses[result.code]!, result.code, result.code === 'INVITATION_NOT_FOUND' ? 'Invitación no disponible' : 'No se pudo completar la operación');
}
class InvitationPersistence extends ScopedPersistence {
  constructor(client: PrismaClient, role: 'wc_identity' | 'wc_platform') { super(client, role); }
  prepare(p: Principal, cid: string, email?: string): Promise<Plan> {
    return this.transaction('invitation_prepare', p, cid, async tx => {
      const v = object(value(await tx.$queryRaw`SELECT app_api.invitation_prepare(${p.userId}::uuid,${p.sessionId}::uuid,${cid}::uuid,${email ?? null}::text) AS result`));
      if (typeof v.email !== 'string' || canonicalEmail(v.email) !== v.email) return unavailable();
      return { invitationId: id(v.invitationId), generation: generation(v.generation), email: v.email };
    });
  }
  emit(p: Principal, cid: string, operationId: string, plan: Plan, hash: string, sealed: Sealed, resend: boolean): Promise<Receipt> {
    return this.transaction('invitation_emit', p, cid, async tx => {
      const v = object(value(await tx.$queryRaw`SELECT app_api.invitation_emit(${p.userId}::uuid,${p.sessionId}::uuid,${cid}::uuid,${operationId}::uuid,
        ${plan.invitationId}::uuid,${plan.generation}::int,${plan.email}::text,${hash}::text,${sealed.payload}::text,
        ${sealed.nonce}::text,${sealed.tag}::text,${resend}::boolean) AS result`));
      if (v.invitationId !== plan.invitationId) return unavailable();
      return { invitationId: id(v.invitationId), expiresAt: date(v.expiresAt) };
    });
  }
  accept(hash: string, p?: Principal, passwordHash?: string): Promise<Acceptance> {
    return this.transaction(p ? 'invitation_accept_existing' : 'invitation_accept_new', p, undefined, async tx => {
      const v = object(value(await tx.$queryRaw`SELECT app_api.invitation_accept(${hash}::text,${p?.userId ?? null}::uuid,${p?.sessionId ?? null}::uuid,
        ${passwordHash ?? null}::text,${randomUUID()}::uuid,${randomUUID()}::uuid) AS result`));
      if (v.role !== 'COMPANY_ADMIN' || v.companyStatus !== 'ACTIVE' || (p && v.userId !== p.userId)) return unavailable();
      return { userId: id(v.userId), companyId: id(v.companyId), role: 'COMPANY_ADMIN', companyStatus: 'ACTIVE' };
    });
  }
}
export class PrismaInvitationPort implements InvitationPort {
  private readonly platform: InvitationPersistence;
  private readonly identity: InvitationPersistence;
  constructor(platform: PrismaClient, identity: PrismaClient) {
    this.platform = new InvitationPersistence(platform, 'wc_platform'); this.identity = new InvitationPersistence(identity, 'wc_identity');
  }
  prepare(p: Principal, cid: string, email?: string) { return this.platform.prepare(p, cid, email); }
  emit(p: Principal, cid: string, op: string, plan: Plan, hash: string, sealed: Sealed, resend: boolean) { return this.platform.emit(p, cid, op, plan, hash, sealed, resend); }
  accept(hash: string, p?: Principal, passwordHash?: string) { return this.identity.accept(hash, p, passwordHash); }
}
export class PrismaInvitationDeliveryPort extends ScopedPersistence implements DeliveryPort {
  constructor(client: PrismaClient) { super(client, 'wc_delivery'); }
  pending(): ReturnType<DeliveryPort['pending']> {
    return this.transaction('invitation_pending', undefined, undefined, async tx => {
      const rows = await tx.$queryRaw<Array<{ id: string; generation: number }>>`SELECT * FROM app_api.invitation_pending()`;
      if (rows.length > 20) return unavailable();
      return rows.map(row => ({ id: id(row.id), generation: generation(row.generation) }));
    });
  }
  claim(oid: string, gen: number, lease: string): Promise<Claimed | null> {
    id(oid); id(lease); generation(gen);
    return this.transaction('invitation_claim', undefined, undefined, async tx => {
      const raw = one(await tx.$queryRaw`SELECT app_api.invitation_claim(${oid}::uuid,${gen}::int,${lease}::uuid) AS result`);
      if (raw === null) return null;
      const v = object(raw);
      if (v.generation !== gen || v.keyId !== 'v1' || typeof v.payload !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(v.payload) ||
        typeof v.nonce !== 'string' || !/^[0-9a-f]{24}$/.test(v.nonce) || typeof v.tag !== 'string' || !/^[0-9a-f]{32}$/.test(v.tag)) return unavailable();
      return { invitationId: id(v.invitationId), generation: gen, expiresAt: date(v.expiresAt), payload: v.payload, nonce: v.nonce, tag: v.tag, keyId: 'v1' };
    });
  }
  canSend(oid: string, gen: number, lease: string): Promise<boolean> {
    id(oid); id(lease); generation(gen);
    return this.transaction('invitation_can_send', undefined, undefined, async tx => {
      const v = one(await tx.$queryRaw`SELECT app_api.invitation_can_send(${oid}::uuid,${gen}::int,${lease}::uuid) AS result`);
      if (typeof v !== 'boolean') return unavailable(); return v;
    });
  }
  async finish(oid: string, gen: number, lease: string, accepted: boolean): Promise<void> {
    id(oid); id(lease); generation(gen);
    await this.transaction('invitation_finish', undefined, undefined, async tx => {
      await tx.$queryRaw`SELECT app_api.invitation_finish(${oid}::uuid,${gen}::int,${lease}::uuid,${accepted}::boolean)::text AS result`;
    });
  }
  emitted(operationId: string): Promise<boolean> {
    id(operationId);
    return this.transaction('invitation_emitted', undefined, undefined, async tx => {
      const v = one(await tx.$queryRaw`SELECT app_api.invitation_emitted(${operationId}::uuid) AS result`);
      if (typeof v !== 'boolean') return unavailable(); return v;
    });
  }
}
