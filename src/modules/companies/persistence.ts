import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Principal } from '../auth/crypto.js';
import { CompanyCursor } from '../auth/cursor.js';
import { AuthError, unavailable } from '../auth/errors.js';
import { uuid } from '../auth/input.js';
import { ScopedPersistence } from '../auth/persistence/adapters.js';
import type { Branch, BranchInput, CompaniesPort, Company, CompanyAction, CompanyInput, CompanyPatch, Page } from './ports.js';

type Json = Record<string, unknown>;
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable();
  return value as Json;
}
function text(value: unknown): string { if (typeof value !== 'string') return unavailable(); return value; }
function id(value: unknown): string { const v = text(value); if (!uuid.test(v)) return unavailable(); return v; }
function date(value: unknown): string {
  const v = text(value); const d = new Date(v);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) || !Number.isFinite(d.getTime()) || d.toISOString() !== v) return unavailable();
  return v;
}
const errors: Record<string, number> = {
  UNAUTHENTICATED: 401, SESSION_EXPIRED: 401, SESSION_REVOKED: 401, FORBIDDEN: 403,
  RESOURCE_NOT_FOUND: 404, COMPANY_SUSPENDED: 403, COMPANY_PENDING_ACTIVATION: 403, RUC_ALREADY_EXISTS: 409,
};
function value(rows: unknown): unknown {
  if (!Array.isArray(rows) || rows.length !== 1) return unavailable();
  const result = object(object(rows[0]).result);
  if (result.code !== 'OK') {
    const code = text(result.code); const status = errors[code];
    if (!status) return unavailable();
    throw new AuthError(status, code, code === 'RESOURCE_NOT_FOUND' ? 'Recurso no encontrado' :
      code === 'RUC_ALREADY_EXISTS' ? 'El RUC ya está registrado.' : 'Solicitud no autorizada');
  }
  return result.value;
}
export function company(value: unknown): Company {
  const c = object(value);
  if (c.representation !== 'FULL' || !['ACTIVE', 'PENDING_ACTIVATION', 'SUSPENDED'].includes(text(c.status))) return unavailable();
  return { representation: 'FULL', id: id(c.id), status: c.status as Company['status'], tradeName: text(c.tradeName),
    legalName: text(c.legalName), ruc: text(c.ruc), taxAddress: text(c.taxAddress), contactEmail: text(c.contactEmail),
    contactPhone: text(c.contactPhone), createdAt: date(c.createdAt), updatedAt: date(c.updatedAt) };
}
function branch(value: unknown, companyId: string): Branch {
  const b = object(value);
  if (b.companyId !== companyId) return unavailable();
  return { id: id(b.id), companyId, name: text(b.name), address: text(b.address), email: b.email === null ? null : text(b.email),
    phone: b.phone === null ? null : text(b.phone), createdAt: date(b.createdAt), updatedAt: date(b.updatedAt) };
}
class PlatformPersistence extends ScopedPersistence {
  constructor(client: PrismaClient, private readonly key: Uint8Array) { super(client, 'wc_platform'); }
  async list(principal: Principal, cursor?: string): Promise<Page<Company>> {
    const codec = new CompanyCursor(this.key, undefined, 'platform-companies:PLATFORM_ADMIN');
    const position = cursor === undefined ? undefined : codec.decode(cursor, principal);
    return this.transaction('platform_companies', principal, undefined, async tx => page(value(await tx.$queryRaw`
      SELECT app_api.platform_companies(${principal.userId}::uuid,${principal.sessionId}::uuid,
        ${position?.createdAt ?? null}::timestamptz,${position?.id ?? null}::uuid) AS result`), company, codec, principal));
  }
  create(principal: Principal, input: CompanyInput): Promise<Company> {
    const cid = randomUUID();
    return this.transaction('platform_create_company', principal, undefined, async tx => {
      const result = company(value(await tx.$queryRaw`SELECT app_api.platform_create_company(${principal.userId}::uuid,
        ${principal.sessionId}::uuid,${cid}::uuid,${JSON.stringify(input)}::jsonb) AS result`));
      if (result.id !== cid || result.status !== 'PENDING_ACTIVATION') return unavailable();
      return result;
    });
  }
  company(principal: Principal, cid: string, action: CompanyAction, patch: CompanyPatch = {}): Promise<Company> {
    return this.transaction(`platform_company_${action}`, principal, cid, async tx => {
      const result = company(value(await tx.$queryRaw`SELECT app_api.platform_company(${principal.userId}::uuid,
        ${principal.sessionId}::uuid,${cid}::uuid,${action}::text,${JSON.stringify(patch)}::jsonb) AS result`));
      if (result.id !== cid) return unavailable();
      return result;
    });
  }
  async branches(principal: Principal, cid: string, cursor?: string): Promise<Page<Branch>> {
    const codec = new CompanyCursor(this.key, undefined, `platform-branches:${cid}:PLATFORM_ADMIN`);
    const position = cursor === undefined ? undefined : codec.decode(cursor, principal);
    return this.transaction('platform_branches', principal, cid, async tx => page(value(await tx.$queryRaw`
      SELECT app_api.platform_branches(${principal.userId}::uuid,${principal.sessionId}::uuid,${cid}::uuid,
        ${position?.createdAt ?? null}::timestamptz,${position?.id ?? null}::uuid) AS result`), v => branch(v, cid), codec, principal));
  }
  branch(principal: Principal, cid: string, bid: string | undefined, input: Partial<BranchInput>): Promise<Branch> {
    const branchId = bid ?? randomUUID(); const action = bid === undefined ? 'create' : 'patch';
    return this.transaction(`platform_branch_${action}`, principal, cid, async tx => {
      const result = branch(value(await tx.$queryRaw`SELECT app_api.platform_branch(${principal.userId}::uuid,
        ${principal.sessionId}::uuid,${cid}::uuid,${branchId}::uuid,${action}::text,${JSON.stringify(input)}::jsonb) AS result`), cid);
      if (result.id !== branchId) return unavailable();
      return result;
    });
  }
}
class TenantBranchesPersistence extends ScopedPersistence {
  constructor(client: PrismaClient, private readonly key: Uint8Array) { super(client, 'wc_tenant'); }
  async branches(principal: Principal, cid: string, cursor?: string): Promise<Page<Branch>> {
    const codec = new CompanyCursor(this.key, undefined, `tenant-branches:${cid}:COMPANY_ADMIN`);
    const position = cursor === undefined ? undefined : codec.decode(cursor, principal);
    return this.transaction('tenant_branches', principal, cid, async tx => page(value(await tx.$queryRaw`
      SELECT app_api.tenant_branches(${principal.userId}::uuid,${principal.sessionId}::uuid,${cid}::uuid,
        ${position?.createdAt ?? null}::timestamptz,${position?.id ?? null}::uuid) AS result`), v => branch(v, cid), codec, principal));
  }
}
function page<T>(value: unknown, project: (item: unknown) => T, codec: CompanyCursor, principal: Principal): Page<T> {
  const p = object(value);
  if (!Array.isArray(p.items) || p.items.length > 20 || typeof p.hasMore !== 'boolean') return unavailable();
  const items = p.items.map(project);
  const last = p.lastPosition === null ? null : object(p.lastPosition);
  if (p.hasMore && (items.length !== 20 || !last)) return unavailable();
  return { items, nextCursor: p.hasMore && last ? codec.encode({ createdAt: date(last.createdAt), id: id(last.id) }, principal) : null };
}
export class PrismaCompaniesPort implements CompaniesPort {
  private readonly platform: PlatformPersistence;
  private readonly tenant: TenantBranchesPersistence;
  constructor(platform: PrismaClient, tenant: PrismaClient, key: Uint8Array) {
    this.platform = new PlatformPersistence(platform, key); this.tenant = new TenantBranchesPersistence(tenant, key);
  }
  list(principal: Principal, cursor?: string) { return this.platform.list(principal, cursor); }
  create(principal: Principal, input: CompanyInput) { return this.platform.create(principal, input); }
  company(principal: Principal, cid: string, action: CompanyAction, patch?: CompanyPatch) { return this.platform.company(principal, cid, action, patch); }
  branches(principal: Principal, cid: string, platform: boolean, cursor?: string) {
    return (platform ? this.platform : this.tenant).branches(principal, cid, cursor);
  }
  branch(principal: Principal, cid: string, bid: string | undefined, input: Partial<BranchInput>) { return this.platform.branch(principal, cid, bid, input); }
}
