import 'reflect-metadata';
import { Body, Controller, INestApplication, Module, Post } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { IsString } from 'class-validator';
import request from 'supertest';
import { configureApp } from '../src/configure-app.js';
import { validateEnvironment } from '../src/config/environment.js';
import { HealthModule } from '../src/modules/health/health.module.js';

// Ruta exclusiva de pruebas: verifica el pipe sin agregar endpoints de negocio.
class ValidationProbeDto {
  @IsString()
  name!: string;
}

@Controller('validation-probe')
class ValidationProbeController {
  @Post()
  validate(@Body() body: ValidationProbeDto): ValidationProbeDto {
    return body;
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      ignoreEnvVars: true,
      load: [() => validateEnvironment({ NODE_ENV: 'test' })],
    }),
    HealthModule,
  ],
  controllers: [ValidationProbeController],
})
class TestAppModule {}

describe('HTTP bootstrap (sin PostgreSQL/Redis)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => { await app?.close(); });

  it('GET /api/health es público y devuelve el contrato exacto', async () => {
    await request(app.getHttpServer()).get('/api/health').expect(200).expect({
      status: 'ok', service: 'whatscommerceec-backend',
    });
  });

  it('no expone health sin prefijo', async () => {
    await request(app.getHttpServer()).get('/health').expect(404);
  });

  it('devuelve error 404 para rutas desconocidas', async () => {
    const response = await request(app.getHttpServer()).get('/api/unknown').expect(404);
    expect(response.body).toMatchObject({ statusCode: 404 });
  });

  it('permite el origen AdminWeb sin habilitar credenciales', async () => {
    const response = await request(app.getHttpServer()).get('/api/health')
      .set('Origin', 'http://localhost:5173').expect(200);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('no habilita CORS para un origen no autorizado', async () => {
    const response = await request(app.getHttpServer()).get('/api/health')
      .set('Origin', 'https://untrusted.example.test').expect(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('responde preflight para AdminWeb', async () => {
    await request(app.getHttpServer()).options('/api/health')
      .set('Origin', 'http://localhost:5173').set('Access-Control-Request-Method', 'GET')
      .expect(204).expect('Access-Control-Allow-Origin', 'http://localhost:5173');
  });

  it('transforma y acepta DTO válido', async () => {
    await request(app.getHttpServer()).post('/api/validation-probe').send({ name: 'example' })
      .expect(201).expect({ name: 'example' });
  });

  it.each([{ name: 12 }, { name: 'example', privileged: true }, {}])('rechaza DTO inválido %p', async (body) => {
    const response = await request(app.getHttpServer()).post('/api/validation-probe').send(body).expect(400);
    expect(response.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
  });

  it('rechaza JSON malformado', async () => {
    await request(app.getHttpServer()).post('/api/validation-probe')
      .set('Content-Type', 'application/json').send('{').expect(400);
  });
});
