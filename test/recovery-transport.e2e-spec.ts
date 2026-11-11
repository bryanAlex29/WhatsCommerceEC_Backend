import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { AuthModule } from '../src/modules/auth/auth.module.js';
import { AuthRuntime } from '../src/modules/auth/runtime.js';
import { RecoveryCrypto, RecoveryService, recoveryMessage } from '../src/modules/auth/recovery.js';
import type { RecoveryPort } from '../src/modules/auth/recovery.js';
import { authJsonMiddleware } from '../src/modules/auth/strict-json.js';
import { RateLimitError } from '../src/modules/auth/rate-limit.js';

describe('recuperación HTTP real, persistencia/cuotas simuladas; no SMTP',()=>{
  let app:INestApplication;
  const port:RecoveryPort={request:jest.fn<RecoveryPort['request']>().mockResolvedValue(undefined),reset:jest.fn<RecoveryPort['reset']>().mockResolvedValue(true)};
  const consume=jest.fn<(scope:string,key:string)=>Promise<void>>().mockResolvedValue(undefined);
  beforeAll(async()=>{
    const recovery=new RecoveryService(port,{consume,checkLoginFailures:async()=>{}},new RecoveryCrypto(randomBytes(32),randomBytes(32)));
    const module=await Test.createTestingModule({imports:[AuthModule]}).overrideProvider(AuthRuntime).useValue({ready:async()=>({recovery})}).compile();
    app=module.createNestApplication();app.setGlobalPrefix('api');app.use(authJsonMiddleware(true));await app.init();
  });
  afterAll(async()=>{await app.close();});
  beforeEach(()=>{jest.mocked(port.reset).mockResolvedValue(true);consume.mockResolvedValue(undefined);});
  it('solicitud pública202 genérica, no tokens ni secreto',async()=>{
    const result=await request(app.getHttpServer()).post('/api/auth/password-recovery/request').send({email:'synthetic@example.test'}).expect(202);
    expect(result.body).toEqual({message:recoveryMessage});expect(result.headers['cache-control']).toBe('no-store');
  });
  it('reset204 vacío y código inválido indistinguible400',async()=>{
    const body={email:'synthetic@example.test',code:'00001234',password:'SyntheticReplacement!'};
    const ok=await request(app.getHttpServer()).post('/api/auth/password-recovery/reset').send(body).expect(204);expect(ok.text).toBe('');
    jest.mocked(port.reset).mockResolvedValue(false);
    const invalid=await request(app.getHttpServer()).post('/api/auth/password-recovery/reset').send(body).expect(400);expect(invalid.body.error.code).toBe('INVALID_RECOVERY_CODE');
  });
  it('429 con Retry-After sin consultar correo',async()=>{
    consume.mockRejectedValue(new RateLimitError(60));
    const result=await request(app.getHttpServer()).post('/api/auth/password-recovery/request').send({email:'synthetic@example.test'}).expect(429);
    expect(result.headers['retry-after']).toBe('60');
  });
  it.each(['request','reset'])('parser estricto, sin query/contexto ni exceso16KiB: %s',async operation=>{
    const url=`/api/auth/password-recovery/${operation}`;
    await request(app.getHttpServer()).post(url).set('Content-Type','application/json').send('{"email":"a@example.test","email":"b@example.test"}').expect(400);
    await request(app.getHttpServer()).post(url).send({email:'x'.repeat(17000)}).expect(413);
    await request(app.getHttpServer()).post(url).set('Content-Type','text/plain').send('x').expect(415);
    await request(app.getHttpServer()).post(`${url}?companyId=x`).send({email:'synthetic@example.test'}).expect(400);
    await request(app.getHttpServer()).post(url).send({email:'synthetic@example.test',companyId:'x'}).expect(400);
  });
});
