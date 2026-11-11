import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { jest } from '@jest/globals';
import request from 'supertest';
import { CompaniesModule } from '../src/modules/companies/companies.module.js';
import { CompaniesRuntime } from '../src/modules/companies/runtime.js';
import { AuthRuntime } from '../src/modules/auth/runtime.js';
import { AuthError } from '../src/modules/auth/errors.js';
import { authJsonMiddleware } from '../src/modules/auth/strict-json.js';
import type { CompaniesPort } from '../src/modules/companies/ports.js';

const cid = '33333333-3333-4333-8333-333333333333'; const bid = '44444444-4444-4444-8444-444444444444';
const input = { tradeName: 'Synthetic', legalName: 'Synthetic', ruc: '1234567890123', taxAddress: 'Synthetic',
  contactEmail: 'synthetic@example.test', contactPhone: '+593999999999' };
describe('Empresas: HTTP real, persistencia simulada', () => {
  let app: INestApplication;
  const authenticate = jest.fn<() => Promise<unknown>>();
  const port: CompaniesPort = {
    list: jest.fn<CompaniesPort['list']>(), create: jest.fn<CompaniesPort['create']>(), company: jest.fn<CompaniesPort['company']>(),
    branches: jest.fn<CompaniesPort['branches']>(), branch: jest.fn<CompaniesPort['branch']>(),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [CompaniesModule] })
      .overrideProvider(AuthRuntime).useValue({ ready: async () => ({ service: { authenticate } }) })
      .overrideProvider(CompaniesRuntime).useValue({ ready: async () => port }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.use(authJsonMiddleware(true)); await app.init();
  });
  beforeEach(() => {
    jest.clearAllMocks(); authenticate.mockResolvedValue({ userId: cid, sessionId: bid });
    jest.mocked(port.list).mockResolvedValue({ items: [], nextCursor: null });
    jest.mocked(port.branches).mockResolvedValue({ items: [], nextCursor: null });
    jest.mocked(port.create).mockResolvedValue({ id: cid, ...input, status: 'PENDING_ACTIVATION', representation: 'FULL', createdAt: '2026-11-10T12:00:00.000Z', updatedAt: '2026-11-10T12:00:00.000Z' });
  });
  afterAll(async () => { await app.close(); });
  it('alta201/listado200 con contrato exacto y no-store', async () => {
    const response = await request(app.getHttpServer()).post('/api/platform/companies').send(input).expect(201);
    expect(response.body.status).toBe('PENDING_ACTIVATION'); expect(response.headers['cache-control']).toBe('no-store');
    const list = await request(app.getHttpServer()).get('/api/platform/companies').expect(200);
    expect(list.body).toEqual({ items: [], nextCursor: null });
  });
  it.each(['suspend', 'reactivate'])('%s devuelve200 sin body de entrada', async action => {
    await request(app.getHttpServer()).post(`/api/platform/companies/${cid}/${action}`).expect(200);
    expect(port.company).toHaveBeenCalledWith({ userId: cid, sessionId: bid }, cid, action);
    await request(app.getHttpServer()).post(`/api/platform/companies/${cid}/${action}`).send({}).expect(400);
  });
  it('sucursales de plataforma y propias no comparten ámbito', async () => {
    await request(app.getHttpServer()).get(`/api/companies/${cid}/branches`).expect(200);
    expect(port.branches).toHaveBeenLastCalledWith({ userId: cid, sessionId: bid }, cid, false, undefined);
    await request(app.getHttpServer()).get(`/api/platform/companies/${cid}/branches`).expect(200);
    expect(port.branches).toHaveBeenLastCalledWith({ userId: cid, sessionId: bid }, cid, true, undefined);
  });
  it('PATCH conserva omisión y permite quitar contactos opcionales', async () => {
    await request(app.getHttpServer()).patch(`/api/platform/companies/${cid}/branches/${bid}`).send({ email: null }).expect(200);
    expect(port.branch).toHaveBeenCalledWith({ userId: cid, sessionId: bid }, cid, bid, { email: null });
    await request(app.getHttpServer()).post(`/api/platform/companies/${cid}/branches`).send({ name: 'A', address: 'B' }).expect(201);
  });
  it('autenticación/permiso y conflictos no se convierten en éxito ni filtran valores', async () => {
    authenticate.mockRejectedValueOnce(new AuthError(401, 'UNAUTHENTICATED'));
    await request(app.getHttpServer()).get('/api/platform/companies').expect(401); expect(port.list).not.toHaveBeenCalled();
    jest.mocked(port.list).mockRejectedValueOnce(new AuthError(403, 'FORBIDDEN'));
    await request(app.getHttpServer()).get('/api/platform/companies').expect(403);
    jest.mocked(port.create).mockRejectedValueOnce(new AuthError(409, 'RUC_ALREADY_EXISTS'));
    await request(app.getHttpServer()).post('/api/platform/companies').send(input).expect(409);
    jest.mocked(port.list).mockRejectedValueOnce(new Error('PRIVATE SQL PASSWORD'));
    const response = await request(app.getHttpServer()).get('/api/platform/companies').expect(500);
    expect(response.text).not.toContain('PRIVATE');
  });
  it.each(['/api/platform/companies', '/API/PLATFORM/COMPANIES/'])('parser estricto también en casing alternativo %s', async url => {
    await request(app.getHttpServer()).post(url).set('Content-Type', 'application/json').send('{"ruc":"1","ruc":"2"}').expect(400);
    await request(app.getHttpServer()).post(url).send({ tradeName: 'x'.repeat(17000) }).expect(413);
    await request(app.getHttpServer()).post(url).set('Content-Type', 'text/plain').send('x').expect(415);
    expect(port.create).not.toHaveBeenCalled();
  });
  it.each([{ ruc: '1234567890123' }, { status: 'ACTIVE' }, { id: cid }, {}, { tradeName: null }, { tradeName: '' }])('rechaza PATCH protegido/vacío/inválido %j', async body => {
    await request(app.getHttpServer()).patch(`/api/platform/companies/${cid}`).send(body).expect(400);
    expect(port.company).not.toHaveBeenCalled();
  });
  it('no acepta body enGET, queries ilimitadas, cursor repetido oUUIDinválido', async () => {
    await request(app.getHttpServer()).get('/api/platform/companies').send({}).expect(400);
    await request(app.getHttpServer()).get('/api/platform/companies?limit=999').expect(400);
    await request(app.getHttpServer()).get('/api/platform/companies?cursor=a&cursor=b').expect(400);
    await request(app.getHttpServer()).get('/api/platform/companies/not-a-uuid').expect(400);
  });
});
