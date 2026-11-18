import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Environment } from './local-config.js';

function hasCode(error: unknown, code: string): boolean {
  // Los errores de fs pueden venir de otro realm (por ejemplo Jest ESM).
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export function setupLocal(directory: string, env: Environment = process.env): 'created' | 'existing' {
  if (env.NODE_ENV !== undefined && env.NODE_ENV !== 'development') {
    throw new Error('setup:local solo permite NODE_ENV=development.');
  }
  // No escribir secretos si Git no los ignora (también detecta archivos rastreados).
  try {
    execFileSync('git', ['check-ignore', '--quiet', '.env'], { cwd: directory, stdio: 'ignore' });
  } catch {
    throw new Error('.env debe estar ignorado y no rastreado por Git.');
  }
  const path = join(directory, '.env');
  let missing: boolean;
  try {
    lstatSync(path);
    return 'existing';
  } catch (error) {
    missing = hasCode(error, 'ENOENT');
  }
  if (!missing) throw new Error('No se pudo comprobar .env.');
  const password = randomBytes(32).toString('hex');
  const contents = [
    '# Exclusivamente DEV local; no compartir ni versionar.',
    'NODE_ENV=development',
    'PORT=3000',
    'CORS_ORIGINS=http://localhost:5173',
    `DATABASE_URL=postgresql://whatscommerceec_dev:${password}@127.0.0.1:5432/whatscommerceec_dev?schema=public`,
    'REDIS_URL=redis://127.0.0.1:6379',
    'POSTGRES_USER=whatscommerceec_dev',
    `POSTGRES_PASSWORD=${password}`,
    'POSTGRES_DB=whatscommerceec_dev',
    'POSTGRES_PORT=5432',
    'REDIS_PORT=6379',
    '',
  ].join('\n');
  let alreadyCreated: boolean;
  try {
    // wx es exclusivo: una carrera concurrente tampoco sobrescribe el archivo.
    writeFileSync(path, contents, { flag: 'wx', mode: 0o600 });
    return 'created';
  } catch (error) {
    alreadyCreated = hasCode(error, 'EEXIST');
  }
  if (alreadyCreated) return 'existing';
  throw new Error('No se pudo crear .env local; revise permisos.');
}
