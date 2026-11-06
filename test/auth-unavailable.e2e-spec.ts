import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AuthModule } from '../src/modules/auth/auth.module.js';
import { HealthModule } from '../src/modules/health/health.module.js';

describe('Transporte fail-closed real, sin DB/Redis', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AuthModule, HealthModule] }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });
  afterAll(async () => { await app.close(); });
  it('health sigue independiente', async () => { await request(app.getHttpServer()).get('/api/health').expect(200); });
  it.each(['/api/auth/me', '/api/me/companies', '/api/companies/11111111-1111-4111-8111-111111111111'])('GET %s no simula éxito', async path => {
    const result = await request(app.getHttpServer()).get(path).expect(503);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body).toEqual({ error: { code: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: 'Servicio temporalmente no disponible' } });
  });
  it.each(['login', 'refresh', 'logout'])('POST auth/%s no usa persistencia falsa', async path => {
    await request(app.getHttpServer()).post(`/api/auth/${path}`).send({}).expect(503);
  });
});
