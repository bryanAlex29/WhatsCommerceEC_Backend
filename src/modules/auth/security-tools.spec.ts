import { randomBytes } from 'node:crypto';
import { jest } from '@jest/globals';
import { CompanyCursor } from './cursor.js';
import { parseStrictJson } from './strict-json.js';
import { RedisRateLimits } from './rate-limit.js';
import type { RedisEvaluator } from './rate-limit.js';
import { validateEnvironment } from '../../config/environment.js';

const principal = { userId: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222' };
const position = { createdAt: '2026-11-06T10:00:00.123Z', id: principal.userId };
describe('Cursor cifrado real, sin PostgreSQL', () => {
  const key = randomBytes(32);
  let now = Date.now();
  const cursor = new CompanyCursor(key, () => now);
  it('conserva posición y cifra identidad/fechas', () => {
    const token = cursor.encode(position, principal);
    expect(cursor.decode(token, principal)).toEqual(position);
    expect(token).not.toContain(principal.userId);
    expect(token).not.toContain(position.createdAt);
  });
  it('no acepta otra identidad/sesión o clave', () => {
    const token = cursor.encode(position, principal);
    expect(() => cursor.decode(token, { ...principal, sessionId: principal.userId })).toThrow();
    expect(() => new CompanyCursor(randomBytes(32)).decode(token, principal)).toThrow();
  });
  it('rechaza alteración y vencimiento en quince minutos', () => {
    const token = cursor.encode(position, principal);
    const parts = token.split('.');
    parts[2] = `${parts[2]?.startsWith('A') ? 'B' : 'A'}${parts[2]?.slice(1)}`;
    expect(() => cursor.decode(parts.join('.'), principal)).toThrow();
    now += 900000;
    expect(() => cursor.decode(token, principal)).toThrow();
  });
});
describe('JSON estricto antes de DTO', () => {
  it('acepta texto escapado sin confundirlo con claves', () => {
    const object = { password: 'a"b\\c', email: 'x@example.ec' };
    expect(parseStrictJson(JSON.stringify(object))).toEqual(object);
  });
  it.each(['{"email":"a","email":"b"}', '{"email":"a","\\u0065mail":"b"}', '{"a":{"x":1,"x":2}}', '[]', 'null', '{bad}'])('rechaza %s', text => {
    expect(() => parseStrictJson(text)).toThrow();
  });
  it('acepta objetos independientes con una misma clave', () => {
    expect(parseStrictJson('{"a":[{"x":1},{"x":2}]}')).toEqual({ a: [{ x: 1 }, { x: 2 }] });
  });
});
describe('Cuotas: adaptador Redis SIMULADO, no prueba ventanas reales', () => {
  function fixture() {
    const evalMock = jest.fn<RedisEvaluator['eval']>().mockResolvedValue([1, 0]);
    return { evalMock, limits: new RedisRateLimits({ eval: evalMock }, randomBytes(32)) };
  }
  it('aplica umbrales aprobados sin correo/IP en claves', async () => {
    const { evalMock, limits } = fixture();
    await limits.consume('login-ip', '127.0.0.1');
    const call = evalMock.mock.calls[0];
    expect(call?.[1]).toMatch(/^wc:auth:[a-f0-9]{64}$/);
    expect(call?.[2]?.slice(0, 3)).toEqual(['900000', '30', '1']);
    await limits.checkLoginFailures('synthetic@example.ec\0ip');
    expect(evalMock.mock.calls[1]?.[2]?.slice(0, 3)).toEqual(['900000', '5', '0']);
  });
  it('devuelve espera sanitizada y falla cerrado ante error', async () => {
    const { evalMock, limits } = fixture();
    evalMock.mockResolvedValueOnce([0, 18]);
    await expect(limits.consume('refresh-session', 'session')).rejects.toMatchObject({ status: 429, retryAfter: 18 });
    evalMock.mockRejectedValueOnce(new Error('private driver detail'));
    await expect(limits.consume('refresh-ip', 'ip')).rejects.toMatchObject({ status: 503, code: 'SERVICE_TEMPORARILY_UNAVAILABLE' });
  });
  it('rechaza respuesta inesperada sin permitir acceso', async () => {
    const { evalMock, limits } = fixture();
    evalMock.mockResolvedValueOnce(['unexpected']);
    await expect(limits.consume('login-ip', 'ip')).rejects.toMatchObject({ status: 503 });
  });
});
describe('Habilitación auth explícita, sin conexión', () => {
  function configuration() {
    return { AUTH_ENABLED: 'true', NODE_ENV: 'test',
      AUTH_IDENTITY_DATABASE_URL: 'postgresql://wc_identity:synthetic@127.0.0.1/example_dev',
      AUTH_TENANT_DATABASE_URL: 'postgresql://wc_tenant:synthetic@127.0.0.1/example_dev',
      REDIS_URL: 'redis://127.0.0.1:6379', AUTH_JWT_KEY: randomBytes(32).toString('base64url'),
      AUTH_CURSOR_KEY: randomBytes(32).toString('base64url'), AUTH_RATE_LIMIT_KEY: randomBytes(32).toString('base64url') };
  }
  it('acepta configuración completa sin usar DATABASE_URL', () => {
    expect(validateEnvironment(configuration())).toMatchObject({ AUTH_ENABLED: true });
  });
  it('no sustituye URL de identidad faltante por bootstrap', () => {
    const raw = { ...configuration(), AUTH_IDENTITY_DATABASE_URL: undefined, DATABASE_URL: 'postgresql://admin:synthetic@localhost/example_dev' };
    expect(() => validateEnvironment(raw)).toThrow('AUTH_IDENTITY_DATABASE_URL');
  });
  it('rechaza runtime administrativo, claves compartidas y producción', () => {
    const raw = configuration();
    expect(() => validateEnvironment({ ...raw, AUTH_IDENTITY_DATABASE_URL: 'postgresql://admin:synthetic@localhost/example_dev' })).toThrow();
    expect(() => validateEnvironment({ ...raw, AUTH_CURSOR_KEY: raw.AUTH_JWT_KEY })).toThrow('AUTH_CURSOR_KEY');
    expect(() => validateEnvironment({ ...raw, NODE_ENV: 'production' })).toThrow('AUTH_ENABLED');
  });
});
