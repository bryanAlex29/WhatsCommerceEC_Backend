import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';

export type Environment = Record<string, string | undefined>;
export interface LocalConfig {
  postgres: { host: string; port: number; user: string; password: string; database: string };
  redis: { host: string; port: number };
}

// No URL, valor de entrada ni error del parser debe salir de este límite.
export function validateLocalConfig(env: Environment): LocalConfig {
  try {
    if (env.NODE_ENV !== 'development') throw new Error();
    if (env.POSTGRES_PORT !== '5432' || env.REDIS_PORT !== '6379') throw new Error();
    const pg = new URL(env.DATABASE_URL ?? '');
    const redis = new URL(env.REDIS_URL ?? '');
    for (const url of [pg, redis]) {
      if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.hash) throw new Error();
    }
    if (!['postgres:', 'postgresql:'].includes(pg.protocol) || pg.port !== '5432') throw new Error();
    // Evita overrides de host/ssl/socket mediante parámetros del driver.
    if ([...pg.searchParams].some(([key, value]) => key !== 'schema' || value !== 'public')) throw new Error();
    const user = decodeURIComponent(pg.username);
    const password = decodeURIComponent(pg.password);
    const database = decodeURIComponent(pg.pathname.slice(1));
    if (!/^[a-z][a-z0-9_]*_dev$/.test(user) || !/^[a-z][a-z0-9_]*_dev$/.test(database)) throw new Error();
    if (password.length < 32 || /change.?me|placeholder|example|password|replace|<|>/i.test(password)) throw new Error();
    if (env.POSTGRES_USER !== user || env.POSTGRES_PASSWORD !== password || env.POSTGRES_DB !== database) throw new Error();
    if (redis.protocol !== 'redis:' || redis.port !== '6379' || redis.username || redis.password || redis.search) throw new Error();
    if (!['', '/', '/0'].includes(redis.pathname)) throw new Error();
    return {
      postgres: { host: '127.0.0.1', port: 5432, user, password, database },
      redis: { host: '127.0.0.1', port: 6379 },
    };
  } catch {
    throw new Error('Configuración local inválida: requiere development, loopback, puertos 5432/6379 y credenciales DEV coherentes sin placeholders.');
  }
}

export function loadLocalEnvironment(path = '.env', overrides: Environment = process.env): Environment {
  try {
    return { ...parse(readFileSync(path)), ...overrides };
  } catch {
    throw new Error('No se pudo leer .env local; ejecute setup:local y revise permisos.');
  }
}
