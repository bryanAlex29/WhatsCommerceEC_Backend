import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { jest } from '@jest/globals';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import { AuthModule } from '../src/modules/auth/auth.module.js';
import { AuthRuntime } from '../src/modules/auth/runtime.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { AccessTokens, hashPassword } from '../src/modules/auth/crypto.js';
import { AuthError } from '../src/modules/auth/errors.js';
import { authJsonMiddleware } from '../src/modules/auth/strict-json.js';
import type { IdentityPort, RateLimitPort, TenantPort } from '../src/modules/auth/ports.js';

describe('HTTP/criptografía reales con persistencia y cuotas SIMULADAS', () => {
  let app: INestApplication;
  const principal = { userId: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222' };
  const user = { id: principal.userId, email: 'synthetic@example.ec', platformRole: null };
  const jwt = new AccessTokens(randomBytes(32));
  let access: string;
  const tenant: TenantPort = { company: jest.fn<TenantPort['company']>().mockRejectedValue(new AuthError(404, 'RESOURCE_NOT_FOUND')) };
  let identity: IdentityPort;
  beforeAll(async () => {
    const phc = await hashPassword('SyntheticPassword!');
    access = await jwt.issue(principal);
    const session = { principal, user, absoluteExpiresAt: new Date(Date.now() + 604800000) };
    identity = {
      credential: jest.fn<IdentityPort['credential']>().mockResolvedValue({ userId: principal.userId, passwordHash: phc }),
      createSession: jest.fn<IdentityPort['createSession']>().mockResolvedValue(session),
      refreshSession: jest.fn<IdentityPort['refreshSession']>().mockResolvedValue(principal.sessionId),
      rotate: jest.fn<IdentityPort['rotate']>().mockResolvedValue({ code: 'OK', session }),
      logout: jest.fn<IdentityPort['logout']>().mockResolvedValue(undefined),
      self: jest.fn<IdentityPort['self']>().mockResolvedValue(user),
      companies: jest.fn<IdentityPort['companies']>().mockResolvedValue({ items: [], nextCursor: null }),
    };
    const limits: RateLimitPort = { checkLoginFailures: async () => {}, consume: async () => {} };
    const service = new AuthService(identity, limits, jwt, phc);
    const module = await Test.createTestingModule({ imports: [AuthModule] }).overrideProvider(AuthRuntime)
      .useValue({ ready: async () => ({ service, identity, tenant }) }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(authJsonMiddleware(true));
    await app.init();
  });
  afterAll(async () => { await app.close(); });
  it('login sin companyId conserva contraseña y responde contrato', async () => {
    const response = await request(app.getHttpServer()).post('/api/auth/login').send({ email: user.email, password: 'SyntheticPassword!' }).expect(200);
    expect(response.body).toMatchObject({ user, expiresIn: 900, tokenType: 'Bearer' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toHaveProperty('passwordHash');
  });
  it('credenciales incorrectas no exponen identidad', async () => {
    const response = await request(app.getHttpServer()).post('/api/auth/login').send({ email: user.email, password: 'Wrong!' }).expect(401);
    expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
  });
  it.each(['{"email":"x@example.ec","email":"y@example.ec","password":"x"}', '{"email":"x@example.ec","\\u0065mail":"y@example.ec","password":"x"}'])('rechaza duplicados antes de perderlos: %s', async value => {
    await request(app.getHttpServer()).post('/api/auth/login').set('Content-Type', 'application/json').send(value).expect(400);
  });
  it('rechaza contexto/rol inyectados en login', async () => {
    const response = await request(app.getHttpServer()).post('/api/auth/login').send({ email: user.email, password: 'SyntheticPassword!', companyId: principal.userId, role: 'PLATFORM_ADMIN' }).expect(400);
    expect(response.body.error.fields).toContainEqual({ field: 'companyId', code: 'PROTECTED_FIELD' });
  });
  it('limita 16KiB y exige JSON', async () => {
    await request(app.getHttpServer()).post('/api/auth/login').send({ email: 'x'.repeat(17000), password: 'x' }).expect(413);
    await request(app.getHttpServer()).post('/api/auth/login').set('Content-Type', 'text/plain').send('anything').expect(415);
  });
  it.each(['/API/auth/login', '/api/Auth/LOGIN/'])('no permite evadir parser con casing: %s', async path => {
    await request(app.getHttpServer()).post(path).set('Content-Type', 'application/json')
      .send('{"email":"x@example.ec","email":"y@example.ec","password":"x"}').expect(400);
    await request(app.getHttpServer()).post(path).send({ email: 'x'.repeat(17000), password: 'x' }).expect(413);
  });
  it('rechaza cuerpo en GET y query no autorizada', async () => {
    await request(app.getHttpServer()).get('/api/auth/me').set('Authorization', `Bearer ${access}`).send({ userId: principal.userId }).expect(400);
    await request(app.getHttpServer()).get('/api/me/companies?limit=999').set('Authorization', `Bearer ${access}`).expect(400);
    await request(app.getHttpServer()).get('/api/me/companies?cursor=a&cursor=b').set('Authorization', `Bearer ${access}`).expect(400);
  });
  it('token ausente/alterado no llega al recurso', async () => {
    for (const token of ['', 'invalid']) {
      const response = await request(app.getHttpServer()).get('/api/auth/me').set('Authorization', token ? `Bearer ${token}` : '').expect(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
    }
  });
  it('selector vacío no requiere empresa y solo devuelve pertenencias del puerto', async () => {
    const response = await request(app.getHttpServer()).get('/api/me/companies').set('Authorization', `Bearer ${access}`).expect(200);
    expect(response.body).toEqual({ items: [], nextCursor: null });
    expect(identity.companies).toHaveBeenCalledWith(principal, undefined);
  });
  it('companyId ajeno devuelve el rechazo del puerto; no prueba RLS', async () => {
    const response = await request(app.getHttpServer()).get(`/api/companies/${principal.userId}`).set('Authorization', `Bearer ${access}`).expect(404);
    expect(response.body.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(tenant.company).toHaveBeenCalledWith(principal, principal.userId);
  });
  it('logout con refresh desconocido respeta 204 sin JWT', async () => {
    const response = await request(app.getHttpServer()).post('/api/auth/logout').send({ refreshToken: randomBytes(32).toString('base64url') }).expect(204);
    expect(response.text).toBe('');
  });
});
