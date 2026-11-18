import { randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '../../../generated/prisma/client.js';
import type { Principal } from '../crypto.js';
import { AuthError, unavailable } from '../errors.js';
import { uuid } from '../input.js';
import type { IdentityPort, TenantPort, SessionRecord, RotationResult, UserSelf, CompanySelection, CompanyBasic, CompanyFull } from '../ports.js';

export interface CompanyCursorPort {
  decode(cursor: string, principal: Principal): { createdAt: string; id: string };
  encode(position: { createdAt: string; id: string }, principal: Principal): string;
}
type Tx = Prisma.TransactionClient;
type Json = Record<string, unknown>;
const hashPattern = /^[0-9a-f]{64}$/;
const utcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function object(value: unknown): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return unavailable();
  return value as Json;
}
function text(value: unknown): string { if (typeof value !== 'string') return unavailable(); return value; }
function id(value: unknown): string { const result = text(value); if (!uuid.test(result)) return unavailable(); return result; }
function date(value: unknown): string {
  const result = text(value);
  if (!utcPattern.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) return unavailable();
  return result;
}
function assertHash(value: string): void { if (!hashPattern.test(value)) unavailable(); }
function user(value: unknown): UserSelf {
  const row = object(value);
  if (row.platformRole !== null && row.platformRole !== 'PLATFORM_ADMIN') return unavailable();
  return { id: id(row.id), email: text(row.email), platformRole: row.platformRole };
}
function session(value: unknown): SessionRecord {
  const row = object(value); const principal = object(row.principal);
  const result = { principal: { userId: id(principal.userId), sessionId: id(principal.sessionId) },
    user: user(row.user), absoluteExpiresAt: new Date(date(row.absoluteExpiresAt)) };
  if (result.user.id !== result.principal.userId) return unavailable();
  return result;
}
const knownErrors: Record<string, number> = {
  INVALID_CREDENTIALS: 401,
  UNAUTHENTICATED: 401, SESSION_EXPIRED: 401, SESSION_REVOKED: 401,
  RESOURCE_NOT_FOUND: 404, COMPANY_SUSPENDED: 403, COMPANY_PENDING_ACTIVATION: 403,
};
function result(rows: unknown): Json {
  if (!Array.isArray(rows) || rows.length !== 1) return unavailable();
  return object(object(rows[0]).result);
}
function value(rows: unknown): unknown {
  const envelope = result(rows);
  if (envelope.code !== 'OK') {
    const code = text(envelope.code); const status = knownErrors[code];
    if (!status) return unavailable();
    throw new AuthError(status, code, code === 'INVALID_CREDENTIALS' ? 'Credenciales inválidas' : code === 'RESOURCE_NOT_FOUND' ? 'Recurso no encontrado' : 'Solicitud no autorizada');
  }
  return envelope.value;
}

/** No datasource/model access here. Client must be built from an explicit scoped runtime URL.
 * A is trusted-backend context transport, not a cryptographic assertion against SQL injection. */
export abstract class ScopedPersistence {
  constructor(protected readonly client: PrismaClient, private readonly role: 'wc_identity' | 'wc_tenant' | 'wc_delivery' | 'wc_platform') {}
  protected async transaction<T>(operation: string, principal: Principal | undefined, companyId: string | undefined,
    work: (tx: Tx) => Promise<T>): Promise<T> {
    if (principal) { id(principal.userId); id(principal.sessionId); }
    if (companyId) id(companyId);
    try {
      return await this.client.$transaction(async tx => {
        const checks = await tx.$queryRaw<Array<{ safe: boolean }>>`
          SELECT (current_user = ${this.role} AND session_user = ${this.role}
            AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole
            AND NOT r.rolcreatedb AND NOT r.rolreplication AND NOT r.rolinherit
            AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid)
            AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner = r.oid)
            AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner = r.oid)
            AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner = r.oid)
            AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database d WHERE d.datdba = r.oid)
            AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type t WHERE t.typowner = r.oid)
            AND coalesce(pg_catalog.current_setting('wc.user_id', true), '') = ''
            AND coalesce(pg_catalog.current_setting('wc.session_id', true), '') = ''
            AND coalesce(pg_catalog.current_setting('wc.company_id', true), '') = ''
            AND coalesce(pg_catalog.current_setting('wc.operation', true), '') = ''
            AND coalesce(pg_catalog.current_setting('wc.tx_marker', true), '') = '') AS safe
          FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;
        if (checks.length !== 1 || checks[0]?.safe !== true) return unavailable();
        await tx.$queryRaw`
          SELECT pg_catalog.set_config('wc.user_id', ${principal?.userId ?? ''}, true),
            pg_catalog.set_config('wc.session_id', ${principal?.sessionId ?? ''}, true),
            pg_catalog.set_config('wc.company_id', ${companyId ?? ''}, true),
            pg_catalog.set_config('wc.operation', ${operation}, true),
            pg_catalog.set_config('wc.tx_marker', pg_catalog.txid_current()::text, true)`;
        return work(tx);
      }, { isolationLevel: 'ReadCommitted', maxWait: 3000, timeout: 5000 });
    } catch (error) {
      if (error instanceof AuthError) throw error;
      return unavailable(); // Never forward SQL, credentials or driver diagnostics.
    }
  }
}

export class PrismaIdentityPort extends ScopedPersistence implements IdentityPort {
  constructor(client: PrismaClient, private readonly cursor: CompanyCursorPort, private readonly checkedSessions = true) { super(client, 'wc_identity'); }
  credential(email: string): ReturnType<IdentityPort['credential']> {
    return this.transaction('credential', undefined, undefined, async tx => {
      const row = value(await tx.$queryRaw`SELECT app_api.identity_credential(${email}::text) AS result`);
      if (row === null) return null;
      const credential = object(row);
      return { userId: id(credential.userId), passwordHash: text(credential.passwordHash) };
    });
  }
  createSession(userId: string, refreshHash: string, expectedPasswordHash: string): Promise<SessionRecord> {
    assertHash(refreshHash);
    const sessionId = randomUUID(); const historyId = randomUUID();
    return this.transaction('create_session', { userId, sessionId }, undefined, async tx => {
      // Compatibilidad SOLO antes de activar recuperación/aplicar005. Tras005,
      // el grant anterior está revocado: configuración antigua falla cerrado.
      if (!this.checkedSessions) return session(value(await tx.$queryRaw`SELECT app_api.identity_create_session(${userId}::uuid,
        ${sessionId}::uuid,${historyId}::uuid,${refreshHash}::text) AS result`));
      return session(value(await tx.$queryRaw`SELECT app_api.identity_create_session_checked(${userId}::uuid, ${sessionId}::uuid,
        ${historyId}::uuid, ${refreshHash}::text, ${expectedPasswordHash}::text) AS result`));
    });
  }
  refreshSession(refreshHash: string): Promise<string | null> {
    assertHash(refreshHash);
    return this.transaction('refresh_lookup', undefined, undefined, async tx => {
      const row = value(await tx.$queryRaw`SELECT app_api.identity_refresh_session(${refreshHash}::text) AS result`);
      return row === null ? null : id(row);
    });
  }
  rotate(refreshHash: string, replacementHash: string): Promise<RotationResult> {
    assertHash(refreshHash); assertHash(replacementHash);
    const historyId = randomUUID();
    // Do not throw on a business failure inside this transaction: reuse revocation must commit.
    return this.transaction('rotate', undefined, undefined, async tx => {
      const row = result(await tx.$queryRaw`SELECT app_api.identity_rotate(${refreshHash}::text,
        ${replacementHash}::text, ${historyId}::uuid) AS result`);
      if (row.code === 'OK') return { code: 'OK', session: session(row.value) };
      if (row.code === 'INVALID_REFRESH_TOKEN' || row.code === 'SESSION_REVOKED' || row.code === 'SESSION_EXPIRED') return { code: row.code };
      return unavailable();
    });
  }
  async logout(refreshHash: string): Promise<void> {
    assertHash(refreshHash);
    await this.transaction('logout', undefined, undefined, async tx => {
      value(await tx.$queryRaw`SELECT app_api.identity_logout(${refreshHash}::text) AS result`);
    });
  }
  self(principal: Principal): Promise<UserSelf> {
    return this.transaction('self', principal, undefined, async tx =>
      user(value(await tx.$queryRaw`SELECT app_api.identity_self(${principal.userId}::uuid, ${principal.sessionId}::uuid) AS result`)));
  }
  async companies(principal: Principal, cursor?: string): ReturnType<IdentityPort['companies']> {
    const position = cursor === undefined ? undefined : this.cursor.decode(cursor, principal);
    if (position) { date(position.createdAt); id(position.id); }
    const page = await this.transaction('companies', principal, undefined, async tx => {
      const row = object(value(await tx.$queryRaw`SELECT app_api.identity_companies(${principal.userId}::uuid,
        ${principal.sessionId}::uuid, ${position?.createdAt ?? null}::timestamptz,
        ${position?.id ?? null}::uuid) AS result`));
      if (!Array.isArray(row.items) || row.items.length > 20 || typeof row.hasMore !== 'boolean') return unavailable();
      const items: CompanySelection[] = row.items.map(item => {
        const selection = object(item);
        if (selection.status !== 'ACTIVE' && selection.status !== 'SUSPENDED' && selection.status !== 'PENDING_ACTIVATION') return unavailable();
        if (selection.role !== 'SELLER' && selection.role !== 'COMPANY_ADMIN') return unavailable();
        return { companyId: id(selection.companyId), tradeName: text(selection.tradeName), status: selection.status, role: selection.role };
      });
      const last = row.lastPosition === null ? null : object(row.lastPosition);
      if (row.hasMore && (items.length !== 20 || !last)) return unavailable();
      return { items, lastPosition: last ? { createdAt: date(last.createdAt), id: id(last.id) } : null, hasMore: row.hasMore };
    });
    return { items: page.items, nextCursor: page.hasMore && page.lastPosition ? this.cursor.encode(page.lastPosition, principal) : null };
  }
}

export class PrismaTenantPort extends ScopedPersistence implements TenantPort {
  constructor(client: PrismaClient) { super(client, 'wc_tenant'); }
  company(principal: Principal, companyId: string): ReturnType<TenantPort['company']> {
    return this.transaction('company', principal, companyId, async tx => {
      const row = object(value(await tx.$queryRaw`SELECT app_api.tenant_company(${principal.userId}::uuid,
        ${principal.sessionId}::uuid, ${companyId}::uuid) AS result`));
      if (row.status !== 'ACTIVE' || row.id !== companyId) return unavailable();
      const basic = { id: id(row.id), tradeName: text(row.tradeName), status: 'ACTIVE' as const };
      if (row.representation === 'BASIC') {
        if (Object.keys(row).some(key => !['representation', 'id', 'tradeName', 'status'].includes(key))) return unavailable();
        return { representation: 'BASIC', ...basic } satisfies CompanyBasic;
      }
      if (row.representation !== 'FULL') return unavailable();
      return { representation: 'FULL', ...basic, legalName: text(row.legalName), ruc: text(row.ruc),
        taxAddress: text(row.taxAddress), contactEmail: text(row.contactEmail), contactPhone: text(row.contactPhone),
        createdAt: date(row.createdAt), updatedAt: date(row.updatedAt) } satisfies CompanyFull;
    });
  }
}
