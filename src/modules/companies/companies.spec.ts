import { randomBytes } from 'node:crypto';
import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { CompanyCursor } from '../auth/cursor.js';
import { branchInput, companyInput, cursorQuery, identifier } from './input.js';
import { PrismaCompaniesPort } from './persistence.js';
import { CompaniesRuntime } from './runtime.js';
import { validateEnvironment } from '../../config/environment.js';

const principal = { userId: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222' };
const cid = '33333333-3333-4333-8333-333333333333';
const bid = '44444444-4444-4444-8444-444444444444';
const date = '2026-11-10T12:00:00.000Z';
const input = { tradeName: 'Synthetic', legalName: 'Synthetic Legal', ruc: '1234567890123', taxAddress: 'Synthetic Address',
  contactEmail: 'synthetic@example.test', contactPhone: '+593999999999' };
const full = { representation: 'FULL', id: cid, status: 'ACTIVE', ...input, createdAt: date, updatedAt: date };
const branch = { id: bid, companyId: cid, name: 'Synthetic', address: 'Synthetic', email: null, phone: null, createdAt: date, updatedAt: date };
function fixture(result: unknown = { code: 'OK', value: full }, safe = true) {
  const query = jest.fn<(sql: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>>()
    .mockResolvedValueOnce([{ safe }]).mockResolvedValueOnce([]).mockResolvedValue([{ result }]);
  const transaction = jest.fn<(callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: unknown) => Promise<unknown>>()
    .mockImplementation(callback => callback({ $queryRaw: query } as unknown as Prisma.TransactionClient));
  const client = { $transaction: transaction } as unknown as PrismaClient;
  return { port: new PrismaCompaniesPort(client, client, randomBytes(32)), query, transaction };
}
describe('Empresas: validación contractual y persistencia simulada', () => {
  it('normaliza textos/correo IDNA sin modificar RUC/teléfono internos', () => {
    expect(companyInput({ ...input, tradeName: '  Synthetic  ', contactEmail: ' VENTAS@compañía.ec ' }, false))
      .toEqual({ ...input, contactEmail: 'ventas@xn--compaa-7va5a.ec' });
    expect(branchInput({ name: 'A', address: 'B' }, false)).toEqual({ name: 'A', address: 'B' });
    expect(branchInput({ email: null, phone: null }, true)).toEqual({ email: null, phone: null });
    expect(companyInput({ tradeName: 'Nuevo' }, true)).toEqual({ tradeName: 'Nuevo' });
  });
  it.each([
    {}, { tradeName: null }, { tradeName: '' }, { tradeName: '  ' }, { tradeName: '\u0000x' },
    { tradeName: '\ud800' }, { tradeName: '😀'.repeat(151) }, { contactPhone: '+593 99999999' },
    { contactPhone: '＋593999999999' }, { contactEmail: 'josé@example.test' },
    { ruc: '1234567890123' }, { status: 'ACTIVE' }, { companyId: cid }, { unknown: 'x' },
  ])('rechaza PATCH vacío/inválido/protegido sin coerción: %j', patch => {
    expect(() => companyInput(patch, true)).toThrow(expect.objectContaining({ status: 400 }));
  });
  it.each(['123', '１２３４５６７８９０１２３', '12345 7890123'])('RUC inválido %s', ruc => {
    expect(() => companyInput({ ...input, ruc }, false)).toThrow();
  });
  it('cuenta puntos de código y preserva Unicode sin NFC', () => {
    expect(companyInput({ tradeName: '😀'.repeat(150) }, true).tradeName).toHaveLength(300);
    expect(branchInput({ name: 'e\u0301' }, true).name).toBe('e\u0301');
    expect(() => branchInput({ email: '' }, true)).toThrow();
    expect(() => branchInput({ companyId: cid }, true)).toThrow();
  });
  it('query/UUID estrictos', () => {
    expect(identifier(cid, 'companyId')).toBe(cid);
    expect(cursorQuery('/?cursor=opaque', true)).toBe('opaque');
    for (const url of ['/?limit=100', '/?cursor=', '/?cursor=a&cursor=b']) expect(() => cursorQuery(url, true)).toThrow();
    expect(() => cursorQuery('/?cursor=a', false)).toThrow();
    expect(() => identifier('invalid', 'branchId')).toThrow();
  });
  it('cursores ligados a colección, empresa, ámbito, identidad, sesión y vencimiento', () => {
    const key = randomBytes(32); let now = 1000000;
    const codec = (scope: string) => new CompanyCursor(key, () => now, scope);
    const c = codec(`platform-branches:${cid}:PLATFORM_ADMIN`);
    const token = c.encode({ createdAt: date, id: bid }, principal);
    expect(c.decode(token, principal).id).toBe(bid);
    for (const scope of ['me-companies', 'platform-companies:PLATFORM_ADMIN', `tenant-branches:${cid}:COMPANY_ADMIN`, `platform-branches:${bid}:PLATFORM_ADMIN`]) {
      expect(() => codec(scope).decode(token, principal)).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' }));
    }
    expect(() => c.decode(token, { ...principal, sessionId: bid })).toThrow();
    now += 900000; expect(() => c.decode(token, principal)).toThrow();
  });
  it('scoped platform rol/contexto/transacción y parámetros (no SQL dinámico)', async () => {
    const f = fixture(); expect(await f.port.company(principal, cid, 'patch', { tradeName: 'Changed' })).toEqual(full);
    expect(f.query.mock.calls[0]?.slice(1)).toEqual(['wc_platform', 'wc_platform']);
    expect(f.query.mock.calls[1]?.slice(1)).toEqual([principal.userId, principal.sessionId, cid, 'platform_company_patch']);
    expect(f.query.mock.calls[2]?.slice(1)).toEqual([principal.userId, principal.sessionId, cid, 'patch', '{"tradeName":"Changed"}']);
    expect(f.transaction.mock.calls[0]?.[1]).toEqual({ isolationLevel: 'ReadCommitted', maxWait: 3000, timeout: 5000 });
  });
  it('listado de sucursales usa rol tenant y valida relación antes de devolver', async () => {
    const f = fixture({ code: 'OK', value: { items: [branch], hasMore: false, lastPosition: { createdAt: date, id: bid } } });
    expect(await f.port.branches(principal, cid, false)).toEqual({ items: [branch], nextCursor: null });
    expect(f.query.mock.calls[0]?.slice(1)).toEqual(['wc_tenant', 'wc_tenant']);
    const crossed = fixture({ code: 'OK', value: { items: [{ ...branch, companyId: bid }], hasMore: false, lastPosition: null } });
    await expect(crossed.port.branches(principal, cid, true)).rejects.toMatchObject({ status: 503 });
  });
  it.each([['FORBIDDEN', 403], ['RESOURCE_NOT_FOUND', 404], ['RUC_ALREADY_EXISTS', 409], ['SESSION_REVOKED', 401]])('errores SQL %s sanitizados', async (code, status) => {
    await expect(fixture({ code }).port.company(principal, cid, 'read')).rejects.toMatchObject({ code, status });
  });
  it('malformed/driver/rol elevado fallan cerrado; no filtra diagnósticos', async () => {
    const f = fixture(undefined, false);
    await expect(f.port.company(principal, cid, 'read')).rejects.toMatchObject({ status: 503 });
    expect(f.query).toHaveBeenCalledTimes(1);
    const driver = fixture(); driver.query.mockRejectedValueOnce(new Error('PRIVATE SQL PASSWORD'));
    await expect(driver.port.company(principal, cid, 'read')).rejects.toMatchObject({ status: 503, message: 'Servicio temporalmente no disponible' });
    await expect(fixture({ code: 'OK', value: {} }).port.company(principal, cid, 'read')).rejects.toMatchObject({ status: 503 });
    await expect(fixture({ code: 'OK', value: { items: Array(21).fill(full), hasMore: true } }).port.list(principal)).rejects.toMatchObject({ status: 503 });
  });
  it('feature flag desactivado no inicia conexiones', async () => {
    const runtime = new CompaniesRuntime(new ConfigService({ COMPANIES_ENABLED: false }));
    expect(() => runtime.ready()).toThrow(expect.objectContaining({ status: 503 }));
    await runtime.onModuleDestroy();
  });
  it('configuración exige AUTH y pool wc_platform solo al habilitar', () => {
    expect(validateEnvironment({}).COMPANIES_ENABLED).toBeUndefined();
    expect(() => validateEnvironment({ COMPANIES_ENABLED: 'true' })).toThrow('COMPANIES_ENABLED');
    const auth = { AUTH_ENABLED: 'true', REDIS_URL: 'redis://localhost:6379',
      AUTH_IDENTITY_DATABASE_URL: 'postgres://wc_identity:synthetic@localhost/dev',
      AUTH_TENANT_DATABASE_URL: 'postgres://wc_tenant:synthetic@localhost/dev',
      AUTH_JWT_KEY: randomBytes(32).toString('base64url'), AUTH_CURSOR_KEY: randomBytes(32).toString('base64url'), AUTH_RATE_LIMIT_KEY: randomBytes(32).toString('base64url'), COMPANIES_ENABLED: 'true' };
    expect(() => validateEnvironment(auth)).toThrow('COMPANIES_PLATFORM_DATABASE_URL');
    expect(() => validateEnvironment({ ...auth, COMPANIES_PLATFORM_DATABASE_URL: 'postgres://postgres:synthetic@localhost/dev' })).toThrow('COMPANIES_PLATFORM_DATABASE_URL');
    expect(validateEnvironment({ ...auth, COMPANIES_PLATFORM_DATABASE_URL: 'postgres://wc_platform:synthetic@localhost/dev' }).COMPANIES_ENABLED).toBe(true);
  });
});
