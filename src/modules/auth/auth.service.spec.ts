import { jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { AuthService } from './auth.service.js';
import { AccessTokens, hashPassword, tokenHash } from './crypto.js';
import { AuthError } from './errors.js';
import type { IdentityPort, SessionRecord, RateLimitPort } from './ports.js';

describe('AuthService con puertos SIMULADOS: no acredita PostgreSQL ni RLS', () => {
  const principal = { userId: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222' };
  const user = { id: principal.userId, email: 'synthetic@example.ec', platformRole: null };
  const session: SessionRecord = { principal, user, absoluteExpiresAt: new Date(Date.now() + 604800000) };
  let phc: string;
  beforeAll(async () => { phc = await hashPassword('SyntheticPassword!'); });
  function fixture() {
    const identity: IdentityPort = {
      credential: jest.fn<IdentityPort['credential']>().mockResolvedValue({ userId: principal.userId, passwordHash: phc }),
      createSession: jest.fn<IdentityPort['createSession']>().mockResolvedValue(session),
      refreshSession: jest.fn<IdentityPort['refreshSession']>().mockResolvedValue(principal.sessionId),
      rotate: jest.fn<IdentityPort['rotate']>().mockResolvedValue({ code: 'OK', session }),
      logout: jest.fn<IdentityPort['logout']>().mockResolvedValue(undefined),
      self: jest.fn<IdentityPort['self']>().mockResolvedValue(user),
      companies: jest.fn<IdentityPort['companies']>().mockResolvedValue({ items: [], nextCursor: null }),
    };
    const limits: RateLimitPort = {
      checkLoginFailures: jest.fn<RateLimitPort['checkLoginFailures']>().mockResolvedValue(undefined),
      consume: jest.fn<RateLimitPort['consume']>().mockResolvedValue(undefined),
    };
    const jwt = new AccessTokens(randomBytes(32));
    return { identity, limits, jwt, service: new AuthService(identity, limits, jwt, phc) };
  }
  it('credenciales válidas; jamás devuelve hash y no extiende vencimiento absoluto', async () => {
    const { service } = fixture();
    const result = await service.login(user.email, 'SyntheticPassword!', '127.0.0.1');
    expect(result.user).toEqual(user);
    expect(result.expiresIn).toBe(900);
    expect(result.refreshExpiresAt).toBe(session.absoluteExpiresAt.toISOString());
    expect(JSON.stringify(result)).not.toContain(phc);
  });
  it('contraseña incorrecta e identidad ausente tienen mismo error', async () => {
    const { service, identity } = fixture();
    await expect(service.login(user.email, 'Incorrect!', 'ip')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', message: 'Credenciales inválidas' });
    jest.mocked(identity.credential).mockResolvedValue(null);
    await expect(service.login(user.email, 'SyntheticPassword!', 'ip')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', message: 'Credenciales inválidas' });
  });
  it('JWT ausente y sesión revocada se rechazan', async () => {
    const { service, identity, jwt } = fixture();
    await expect(service.authenticate()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    jest.mocked(identity.self).mockRejectedValue(new AuthError(401, 'SESSION_REVOKED'));
    await expect(service.authenticate(`Bearer ${await jwt.issue(principal)}`)).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
  });
  it('contraseña fuera del límite defensivo también cuenta como fallo', async () => {
    const { service, identity, limits } = fixture();
    await expect(service.login(user.email, '', 'ip')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(limits.consume).toHaveBeenCalledWith('login-failure', `${user.email}\0ip`);
    expect(identity.credential).not.toHaveBeenCalled();
  });
  it('resultado de reutilización ya confirmado se convierte en error fuera del puerto', async () => {
    const { service, identity } = fixture();
    let revoked = false;
    jest.mocked(identity.rotate).mockImplementation(async () => { revoked = true; return { code: 'SESSION_REVOKED' }; });
    await expect(service.refresh('A'.repeat(43), 'ip')).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
    expect(revoked).toBe(true); // Simula commit: no demuestra durabilidad real.
  });
  it('logout intenta revocar token histórico aunque Redis falle', async () => {
    const { service, identity, limits } = fixture();
    jest.mocked(limits.consume).mockRejectedValue(new AuthError(503, 'SERVICE_TEMPORARILY_UNAVAILABLE'));
    await expect(service.logout('A'.repeat(43), 'ip')).rejects.toMatchObject({ status: 503 });
    expect(identity.logout).toHaveBeenCalledWith(tokenHash('A'.repeat(43)));
  });
  it('fallo de firma tras rotación no reintenta; histórico sigue disponible para logout', async () => {
    const { service, identity, jwt } = fixture();
    jest.spyOn(jwt, 'issue').mockRejectedValue(new Error('synthetic signing failure'));
    await expect(service.refresh('A'.repeat(43), 'ip')).rejects.toThrow('synthetic signing failure');
    expect(identity.rotate).toHaveBeenCalledTimes(1);
    await service.logout('A'.repeat(43), 'ip');
    expect(identity.logout).toHaveBeenCalledWith(tokenHash('A'.repeat(43)));
  });
});
