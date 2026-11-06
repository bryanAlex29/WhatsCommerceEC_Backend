import { validateEnvironment } from './environment.js';

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
