import { jest } from '@jest/globals';
import type { PrismaClient, Prisma } from '../../../generated/prisma/client.js';
import { PrismaIdentityPort, PrismaTenantPort } from './adapters.js';
import type { CompanyCursorPort } from './adapters.js';

const principal = { userId: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222' };
const companyId = '33333333-3333-4333-8333-333333333333';
const user = { id: principal.userId, email: 'synthetic@example.ec', platformRole: null };
const session = { principal, user, absoluteExpiresAt: '2026-11-13T12:00:00.000Z' };
const basic = { representation: 'BASIC', id: companyId, tradeName: 'Synthetic', status: 'ACTIVE' };
const position = { createdAt: '2026-11-06T12:00:00.123Z', id: '44444444-4444-4444-8444-444444444444' };
function fixture(envelope: unknown = { code: 'OK', value: user }, safe = true, checkedSessions = true) {
  const events: string[] = [];
  const query = jest.fn<(sql: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>>()
    .mockResolvedValueOnce([{ safe }]).mockResolvedValueOnce([]).mockResolvedValue([{ result: envelope }]);
  const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;
  const transaction = jest.fn<(callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: unknown) => Promise<unknown>>()
    .mockImplementation(async callback => {
      events.push('begin');
      try { const response = await callback(tx); events.push('commit'); return response; }
      catch (error) { events.push('rollback'); throw error; }
    });
  const client = { $transaction: transaction } as unknown as PrismaClient;
  const cursor: CompanyCursorPort = {
    decode: jest.fn<CompanyCursorPort['decode']>().mockReturnValue(position),
    encode: jest.fn<CompanyCursorPort['encode']>().mockReturnValue('opaque-encrypted-cursor'),
  };
  return { query, transaction, events, cursor, identity: new PrismaIdentityPort(client, cursor, checkedSessions), tenant: new PrismaTenantPort(client) };
}
describe('Prisma adapters con cliente transaccional SIMULADO; NO acredita SQL/RLS efectivo', () => {
  it('READ COMMITTED; rol/contexto inicial antes de SET LOCAL y funcion parametrizada', async () => {
    const f = fixture();
    expect(await f.identity.self(principal)).toEqual(user);
    expect(f.transaction.mock.calls[0]?.[1]).toEqual({ isolationLevel: 'ReadCommitted', maxWait: 3000, timeout: 5000 });
    const [check, context, operation] = f.query.mock.calls;
    expect(check?.[0].join('?')).toContain('pg_catalog.pg_roles');
    expect(check?.slice(1)).toEqual(['wc_identity', 'wc_identity']);
    expect(context?.[0].join('?')).toContain("set_config('wc.tx_marker', pg_catalog.txid_current()::text, true)");
    expect(context?.slice(1)).toEqual([principal.userId, principal.sessionId, '', 'self']);
    expect(operation?.[0].join('?')).toContain('app_api.identity_self');
    expect(operation?.slice(1)).toEqual([principal.userId, principal.sessionId]);
    expect(f.events).toEqual(['begin', 'commit']);
  });
  it('rol incorrecto/residuo/elevacion deniega sin SET ni operacion', async () => {
    const f = fixture(undefined, false);
    await expect(f.identity.self(principal)).rejects.toMatchObject({ status: 503, code: 'SERVICE_TEMPORARILY_UNAVAILABLE' });
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual(['begin', 'rollback']);
  });
  it('lookup usa correo como parametro, no SQL interpolado ni tablas de modelos', async () => {
    const f = fixture({ code: 'OK', value: { userId: principal.userId, passwordHash: '$argon2id$synthetic' } });
    await f.identity.credential('synthetic@example.ec');
    expect(f.query.mock.calls[2]?.slice(1)).toEqual(['synthetic@example.ec']);
    expect(f.query.mock.calls[2]?.[0].join('?')).toContain('app_api.identity_credential');
  });
  it('crea IDs de sesion e historial UUID en servidor y convierte fecha UTC', async () => {
    const f = fixture({ code: 'OK', value: session });
    const record = await f.identity.createSession(principal.userId, 'a'.repeat(64), '$argon2id$synthetic');
    expect(record.absoluteExpiresAt.toISOString()).toBe(session.absoluteExpiresAt);
    const params = f.query.mock.calls[2]?.slice(1);
    expect(params?.[0]).toBe(principal.userId);
    expect(params?.[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(params?.[2]).toMatch(/^[0-9a-f-]{36}$/);
    expect(params?.[1]).not.toBe(params?.[2]);
    expect(params?.[3]).toBe('a'.repeat(64));
    expect(params?.[4]).toBe('$argon2id$synthetic');
    expect(f.query.mock.calls[2]?.[0].join('?')).toContain('identity_create_session_checked');
  });
  it('sin recuperación conserva función original antes de005, sin fallback después de un error', async () => {
    const f = fixture({ code: 'OK', value: session }, true, false);
    await f.identity.createSession(principal.userId, 'a'.repeat(64), '$argon2id$synthetic');
    expect(f.query.mock.calls[2]?.[0].join('?')).toContain('identity_create_session(');
    expect(f.query.mock.calls[2]?.slice(1)).toHaveLength(4);
  });
  it.each(['SESSION_REVOKED', 'SESSION_EXPIRED', 'INVALID_REFRESH_TOKEN'] as const)('rotate devuelve %s DESPUES de commit, no rollback', async code => {
    const f = fixture({ code });
    expect(await f.identity.rotate('a'.repeat(64), 'b'.repeat(64))).toEqual({ code });
    expect(f.events).toEqual(['begin', 'commit']);
    expect(f.query.mock.calls[2]?.[0].join('?')).toContain('app_api.identity_rotate');
  });
  it('refresh lookup solo devuelve sid; logout token historico y desconocido usa funcion estrecha', async () => {
    const lookup = fixture({ code: 'OK', value: principal.sessionId });
    expect(await lookup.identity.refreshSession('a'.repeat(64))).toBe(principal.sessionId);
    expect(lookup.query.mock.calls[2]?.[0].join('?')).toContain('app_api.identity_refresh_session');
    const logout = fixture({ code: 'OK', value: null });
    await expect(logout.identity.logout('a'.repeat(64))).resolves.toBeUndefined();
    expect(logout.query.mock.calls[2]?.[0].join('?')).toContain('app_api.identity_logout');
    expect(logout.events).toEqual(['begin', 'commit']);
  });
  it('pagina20 sin oversampling, encode de posicion Membership y decode ligado a principal', async () => {
    const items = Array.from({ length: 20 }, () => ({ companyId, tradeName: 'Synthetic', status: 'ACTIVE', role: 'SELLER' }));
    const f = fixture({ code: 'OK', value: { items, lastPosition: position, hasMore: true } });
    const page = await f.identity.companies(principal, 'encrypted-input');
    expect(page).toEqual({ items, nextCursor: 'opaque-encrypted-cursor' });
    expect(f.cursor.decode).toHaveBeenCalledWith('encrypted-input', principal);
    expect(f.cursor.encode).toHaveBeenCalledWith(position, principal);
    expect(f.query.mock.calls[2]?.slice(1)).toEqual([principal.userId, principal.sessionId, position.createdAt, position.id]);
  });
  it('pagina final no genera cursor y 21 items falla cerrado', async () => {
    const f = fixture({ code: 'OK', value: { items: [], lastPosition: null, hasMore: false } });
    expect(await f.identity.companies(principal)).toEqual({ items: [], nextCursor: null });
    expect(f.cursor.encode).not.toHaveBeenCalled();
    const tooMany = fixture({ code: 'OK', value: { items: Array(21).fill({}), lastPosition: null, hasMore: false } });
    await expect(tooMany.identity.companies(principal)).rejects.toMatchObject({ status: 503 });
  });
  it('tenant scoped role y company en contexto, BASIC sin campos fiscales', async () => {
    const f = fixture({ code: 'OK', value: basic });
    expect(await f.tenant.company(principal, companyId)).toEqual(basic);
    expect(f.query.mock.calls[0]?.slice(1)).toEqual(['wc_tenant', 'wc_tenant']);
    expect(f.query.mock.calls[1]?.slice(1)).toEqual([principal.userId, principal.sessionId, companyId, 'company']);
    expect(f.query.mock.calls[2]?.[0].join('?')).toContain('app_api.tenant_company');
    const leak = fixture({ code: 'OK', value: { ...basic, ruc: 'synthetic' } });
    await expect(leak.tenant.company(principal, companyId)).rejects.toMatchObject({ status: 503 });
  });
  it('FULL validado y proyectado', async () => {
    const full = { ...basic, representation: 'FULL', legalName: 'Synthetic Legal', ruc: '1234567890123',
      taxAddress: 'Synthetic', contactEmail: 'synthetic@example.ec', contactPhone: '+593999999999',
      createdAt: position.createdAt, updatedAt: position.createdAt };
    expect(await fixture({ code: 'OK', value: full }).tenant.company(principal, companyId)).toEqual(full);
  });
  it.each([['RESOURCE_NOT_FOUND',404], ['COMPANY_SUSPENDED',403], ['COMPANY_PENDING_ACTIVATION',403], ['SESSION_REVOKED',401]])('propaga codigo SQL conocido %s sin detalles privados', async (code, status) => {
    await expect(fixture({ code }).tenant.company(principal, companyId)).rejects.toMatchObject({ code, status });
  });
  it('driver/malformed SQL result/hash no valido falla cerrado sin exponer mensaje SQL', async () => {
    const f = fixture();
    f.query.mockRejectedValueOnce(new Error('secret sql credential'));
    await expect(f.identity.self(principal)).rejects.toMatchObject({ status: 503, message: 'Servicio temporalmente no disponible' });
    await expect(fixture({ code: 'OK', value: {} }).identity.self(principal)).rejects.toMatchObject({ status: 503 });
    const invalid = fixture();
    expect(() => invalid.identity.rotate('wrong', 'b'.repeat(64))).toThrow();
    expect(invalid.transaction).not.toHaveBeenCalled();
  });
});
