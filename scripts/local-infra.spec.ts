import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'dotenv';
import { setupLocal } from './setup-local-core.js';
import { loadLocalEnvironment, validateLocalConfig, type Environment } from './local-config.js';
import { bounded, checkInfrastructure, type Probe } from './check-infra-core.js';
import { localComposeBaseArgs } from './infra-compose-core.js';

// Credencial exclusivamente sintética para validación sin servidores.
const fakePassword = 'a1b2c3d4'.repeat(8);
const valid: Environment = {
  NODE_ENV: 'development', POSTGRES_USER: 'whatscommerceec_dev', POSTGRES_DB: 'whatscommerceec_dev',
  POSTGRES_PASSWORD: fakePassword, POSTGRES_PORT: '5432', REDIS_PORT: '6379',
  DATABASE_URL: `postgresql://whatscommerceec_dev:${fakePassword}@127.0.0.1:5432/whatscommerceec_dev?schema=public`,
  REDIS_URL: 'redis://127.0.0.1:6379',
};

describe('alcance explicito del proyecto Compose', () => {
  it('fija archivo absoluto y nombre de proyecto sin operar otros compose', () => {
    expect(localComposeBaseArgs('checkout-local')).toEqual([
      'compose', '--file', resolve('checkout-local', 'compose.yaml'), '--project-name', 'whatscommerceec-local',
    ]);
  });

  it('no utiliza overrides COMPOSE_FILE o COMPOSE_PROJECT_NAME como argumentos', () => {
    const file = process.env.COMPOSE_FILE;
    const project = process.env.COMPOSE_PROJECT_NAME;
    try {
      process.env.COMPOSE_FILE = 'otro-proyecto.yaml';
      process.env.COMPOSE_PROJECT_NAME = 'otro-proyecto';
      const args = localComposeBaseArgs('checkout-local');
      expect(args).not.toContain('otro-proyecto.yaml');
      expect(args).not.toContain('otro-proyecto');
      expect(args.at(-1)).toBe('whatscommerceec-local');
    } finally {
      if (file === undefined) delete process.env.COMPOSE_FILE;
      else process.env.COMPOSE_FILE = file;
      if (project === undefined) delete process.env.COMPOSE_PROJECT_NAME;
      else process.env.COMPOSE_PROJECT_NAME = project;
    }
  });
});

describe('configuración de herramientas DEV (sin DB)', () => {
  it('acepta configuración explícita y normaliza localhost a loopback numérico', () => {
    expect(validateLocalConfig(valid).postgres.host).toBe('127.0.0.1');
    expect(validateLocalConfig({ ...valid, DATABASE_URL: valid.DATABASE_URL?.replace('127.0.0.1', 'localhost') }).postgres.host).toBe('127.0.0.1');
  });

  it.each([
    { NODE_ENV: undefined }, { NODE_ENV: 'production' }, { NODE_ENV: 'test' },
    { DATABASE_URL: undefined }, { DATABASE_URL: 'not a URL' },
    { DATABASE_URL: valid.DATABASE_URL?.replace('127.0.0.1', 'db.example.test') },
    { DATABASE_URL: valid.DATABASE_URL?.replace('127.0.0.1', '0.0.0.0') },
    { DATABASE_URL: valid.DATABASE_URL?.replace('5432', '5433') },
    { DATABASE_URL: `${valid.DATABASE_URL}&host=remote.example.test` },
    { DATABASE_URL: `${valid.DATABASE_URL}&sslmode=require` },
    { DATABASE_URL: valid.DATABASE_URL?.replace(fakePassword, 'CHANGE_ME') },
    { DATABASE_URL: valid.DATABASE_URL?.replace(fakePassword, 'CHANGE_ME'.repeat(8)) },
    { DATABASE_URL: valid.DATABASE_URL?.replace('whatscommerceec_dev', 'postgres') },
    { POSTGRES_PASSWORD: 'different' }, { POSTGRES_DB: 'different_dev' },
    { POSTGRES_USER: 'different_dev' }, { POSTGRES_PORT: undefined }, { REDIS_PORT: '6380' },
    { REDIS_URL: 'redis://remote.example.test:6379' },
    { REDIS_URL: 'rediss://127.0.0.1:6379' }, { REDIS_URL: 'redis://127.0.0.1:6379/1' },
    { REDIS_URL: 'redis://127.0.0.1:6379?host=remote.example.test' },
    { REDIS_URL: `redis://:${fakePassword}@127.0.0.1:6379` },
  ])('rechaza configuración no autorizada sin valores sensibles: %p', (patch) => {
    try {
      validateLocalConfig({ ...valid, ...patch });
      throw new Error('No rechazó');
    } catch (error) {
      expect((error as Error).message).toMatch(/^Configuración local inválida:/);
      expect((error as Error).message).not.toContain(fakePassword);
      expect((error as Error).message).not.toContain('://');
    }
  });
});

describe('setup local exclusivo (solo archivos de prueba bajo node_modules)', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(process.cwd(), 'node_modules', '.setup-test-')); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  it('genera secreto de 256 bits, CORS local y configuración coherente', () => {
    expect(setupLocal(directory, {})).toBe('created');
    const env = parse(readFileSync(join(directory, '.env')));
    expect(env.POSTGRES_PASSWORD).toMatch(/^[a-f0-9]{64}$/);
    expect(env.CORS_ORIGINS).toBe('http://localhost:5173');
    expect(validateLocalConfig(env)).toMatchObject({ postgres: { database: 'whatscommerceec_dev' } });
    expect(setupLocal(directory, {})).toBe('existing');
    expect(parse(readFileSync(join(directory, '.env')))).toEqual(env);
  });

  it('preserva byte por byte incluso archivo existente inválido', () => {
    const path = join(directory, '.env');
    writeFileSync(path, 'CONTENIDO_PREEXISTENTE\r\n');
    const original = readFileSync(path);
    expect(setupLocal(directory, {})).toBe('existing');
    expect(readFileSync(path)).toEqual(original);
  });

  it('dos invocaciones crean secretos distintos sin imprimirlos', () => {
    setupLocal(directory, {});
    const first = parse(readFileSync(join(directory, '.env'))).POSTGRES_PASSWORD;
    rmSync(join(directory, '.env'));
    setupLocal(directory, {});
    expect(parse(readFileSync(join(directory, '.env'))).POSTGRES_PASSWORD).not.toBe(first);
  });

  it('rechaza producción sin crear archivo', () => {
    expect(() => setupLocal(directory, { NODE_ENV: 'production' })).toThrow('development');
    expect(() => readFileSync(join(directory, '.env'))).toThrow();
  });

  it('shell prevalece sobre archivo y nunca se modifica .env al cargar', () => {
    setupLocal(directory, {});
    const path = join(directory, '.env');
    const original = readFileSync(path);
    expect(loadLocalEnvironment(path, { NODE_ENV: 'production' }).NODE_ENV).toBe('production');
    expect(() => validateLocalConfig(loadLocalEnvironment(path, { NODE_ENV: 'production' }))).toThrow();
    expect(readFileSync(path)).toEqual(original);
    expect(() => loadLocalEnvironment(join(directory, 'missing'), {})).toThrow(/^No se pudo leer .env local/);
  });
});

describe('probes con FAKES explícitos (no prueban DB/Redis reales)', () => {
  function fake(failCheck = false, failClose = false) {
    const calls: string[] = [];
    const probe: Probe = {
      async check() { calls.push('check'); if (failCheck) throw new Error(`driver leak ${valid.DATABASE_URL}`); },
      async close() { calls.push('close'); if (failClose) throw new Error(`driver leak ${fakePassword}`); },
    };
    return { calls, probe };
  }

  it('reporta éxito únicamente tras consultar y cerrar ambos', async () => {
    const pg = fake(); const redis = fake(); const messages: string[] = [];
    expect(await checkInfrastructure(valid, { postgres: () => pg.probe, redis: () => redis.probe }, (m) => messages.push(m))).toBe(true);
    expect(pg.calls).toEqual(['check', 'close']);
    expect(redis.calls).toEqual(['check', 'close']);
    expect(messages).toHaveLength(2);
    expect(messages.join()).toContain('Prisma SELECT 1');
  });

  it('falla sin construir clientes para configuración remota/producción', async () => {
    let created = false;
    const factory = () => { created = true; return fake().probe; };
    expect(await checkInfrastructure({ ...valid, NODE_ENV: 'production' }, { postgres: factory, redis: factory }, () => {})).toBe(false);
    expect(created).toBe(false);
  });

  it('cierra tras fallos de consulta/cierre y redacta mensajes y URLs', async () => {
    const pg = fake(true, true); const redis = fake(); const messages: string[] = [];
    expect(await checkInfrastructure(valid, { postgres: () => pg.probe, redis: () => redis.probe }, (m) => messages.push(m))).toBe(false);
    expect(pg.calls).toEqual(['check', 'close']);
    expect(redis.calls).toEqual(['check', 'close']);
    expect(messages.join()).not.toContain(fakePassword);
    expect(messages.join()).not.toContain('://');
    expect(messages.join()).not.toContain('driver leak');
  });

  it('sanitiza también fallos síncronos de construcción y sigue con Redis', async () => {
    const messages: string[] = []; const redis = fake();
    expect(await checkInfrastructure(valid, {
      postgres: () => { throw new Error(valid.DATABASE_URL); }, redis: () => redis.probe,
    }, (m) => messages.push(m))).toBe(false);
    expect(redis.calls).toEqual(['check', 'close']);
    expect(messages.join()).not.toContain(fakePassword);
  });

  it('timeout de consulta y cierre es acotado, informa fallo sin secretos', async () => {
    const never = () => new Promise<void>(() => {});
    const messages: string[] = [];
    expect(await checkInfrastructure(valid, {
      postgres: () => ({ check: never, close: never }), redis: () => fake().probe,
    }, (m) => messages.push(m), 10)).toBe(false);
    expect(messages.join()).toContain('timeout');
    await expect(bounded(Promise.reject(new Error('fake')), 100)).rejects.toThrow('fake');
  });
});
