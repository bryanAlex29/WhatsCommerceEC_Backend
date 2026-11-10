import { validateEnvironment } from './environment.js';
import { randomBytes } from 'node:crypto';

describe('validateEnvironment', () => {
  it('usa valores locales por defecto sin exigir servicios externos', () => {
    expect(validateEnvironment({})).toEqual({
      NODE_ENV: 'development', PORT: 3000, CORS_ORIGINS: ['http://localhost:5173'], AUTH_ENABLED: false,
    });
  });

  it('acepta orígenes explícitos y URLs de servicios', () => {
    expect(validateEnvironment({
      NODE_ENV: 'test', PORT: '3100',
      CORS_ORIGINS: 'https://admin.example.test,http://localhost:5173',
      DATABASE_URL: 'postgresql://example:placeholder@localhost:5432/example',
      REDIS_URL: 'rediss://localhost:6379',
    })).toMatchObject({ PORT: 3100, CORS_ORIGINS: ['https://admin.example.test', 'http://localhost:5173'] });
  });

  it.each(['', '0', '-1', '65536', '3000.5', 'abc', '3e3'])('rechaza puerto %p', (PORT) => {
    expect(() => validateEnvironment({ PORT })).toThrow('PORT');
  });

  it.each(['*', 'null', '', 'https://example.test/path', 'https://user:pass@example.test', 'https://example.test,'])('rechaza origen %p', (CORS_ORIGINS) => {
    expect(() => validateEnvironment({ CORS_ORIGINS })).toThrow('CORS_ORIGINS');
  });

  it.each([
    { NODE_ENV: 'invalid' },
    { DATABASE_URL: 'https://example.test' },
    { REDIS_URL: 'http://localhost' },
    { REDIS_URL: '' },
  ])('rechaza configuración inválida sin exponer valores', (raw) => {
    expect(() => validateEnvironment(raw)).toThrow(/^Configuración inválida: [A-Z_]+$/);
  });

  it('no expone credenciales en errores de URL', () => {
    const secret = 'DO_NOT_LOG_PLACEHOLDER';
    try {
      validateEnvironment({ DATABASE_URL: `http://user:${secret}@localhost` });
      throw new Error('Debió rechazar la URL');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Configuración inválida: DATABASE_URL');
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describe('configuración privada recuperación, fixtures sintéticos',()=>{
  const fixture=()=>({NODE_ENV:'test',AUTH_ENABLED:'true',AUTH_IDENTITY_DATABASE_URL:'postgresql://wc_identity:synthetic@localhost/test',
    AUTH_TENANT_DATABASE_URL:'postgresql://wc_tenant:synthetic@localhost/test',REDIS_URL:'redis://localhost:6379',
    AUTH_JWT_KEY:randomBytes(32).toString('base64url'),AUTH_CURSOR_KEY:randomBytes(32).toString('base64url'),AUTH_RATE_LIMIT_KEY:randomBytes(32).toString('base64url'),
    RECOVERY_ENABLED:'true',RECOVERY_MAC_KEY:randomBytes(32).toString('base64url'),RECOVERY_ENCRYPTION_KEY:randomBytes(32).toString('base64url'),
    RECOVERY_DELIVERY_DATABASE_URL:'postgresql://wc_delivery:synthetic@localhost/test',SMTP_USER:'synthetic.sender@gmail.com',SMTP_APP_PASSWORD:'abcdefghijklmnop'});
  it('valida configuración completa sin conectarse ni enviar correo',()=>{expect(validateEnvironment(fixture()).RECOVERY_ENABLED).toBe(true);});
  it('no reutiliza claves entre propósitos',()=>{const raw=fixture();raw.RECOVERY_MAC_KEY=raw.AUTH_JWT_KEY;expect(()=>validateEnvironment(raw)).toThrow('RECOVERY_MAC_KEY');});
  it.each(['RECOVERY_MAC_KEY','RECOVERY_ENCRYPTION_KEY','RECOVERY_DELIVERY_DATABASE_URL','SMTP_USER','SMTP_APP_PASSWORD'] as const)('rechaza falta de %s sin mostrar valores',key=>{
    const raw:Record<string,unknown>=fixture();delete raw[key];expect(()=>validateEnvironment(raw)).toThrow(`Configuración inválida: ${key}`);
  });
  it('no habilita recuperación productiva por inferencia',()=>{const raw=fixture();raw.NODE_ENV='production';expect(()=>validateEnvironment(raw)).toThrow();});
  it('Gmail API requiere OAuth y no exige ni devuelve contraseña SMTP',()=>{
    const raw:Record<string,unknown>={...fixture(),RECOVERY_MAIL_TRANSPORT:'gmail-api',GMAIL_OAUTH_CLIENT_ID:'synthetic.apps.googleusercontent.com',
      GMAIL_OAUTH_CLIENT_SECRET:'synthetic-client-secret',GMAIL_OAUTH_REFRESH_TOKEN:'synthetic-refresh-token'};
    delete raw.SMTP_APP_PASSWORD;
    const parsed=validateEnvironment(raw);expect(parsed.RECOVERY_MAIL_TRANSPORT).toBe('gmail-api');expect(parsed.SMTP_APP_PASSWORD).toBeUndefined();
    delete raw.GMAIL_OAUTH_REFRESH_TOKEN;expect(()=>validateEnvironment(raw)).toThrow('GMAIL_OAUTH_REFRESH_TOKEN');
  });
  it('rechaza transporte desconocido, sin degradar a SMTP',()=>{expect(()=>validateEnvironment({...fixture(),RECOVERY_MAIL_TRANSPORT:'unknown'})).toThrow('RECOVERY_MAIL_TRANSPORT');});
});
