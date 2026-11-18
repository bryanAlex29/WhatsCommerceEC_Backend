import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const marker = '-- WhatsCommerce EC: DDL revisable 1.4a.';

/** Envuelve el diff desde vacío; no es un aplicador ni analiza sintaxis PostgreSQL. */
export function renderReviewableSchema(prismaOutput: string): string {
  if (/\bDROP\s+(?:TABLE|SCHEMA|DATABASE|ROLE)\b|(?:^|;)\s*TRUNCATE\b/i.test(prismaOutput)) {
    throw new Error('El diff desde vacío contiene una operación destructiva inesperada.');
  }
  // El esquema y su ownership se preparan en 000_roles.sql, no se adoptan aquí.
  const ddl = prismaOutput.replace(/^CREATE SCHEMA(?: IF NOT EXISTS)? "app_private";\r?\n/gm, '').trim();
  if (!ddl.includes('CREATE TABLE "app_private"."company"')) {
    throw new Error('El diff no contiene el modelo privado aprobado.');
  }
  return `${marker}\n-- Generado desde prisma/schema.prisma mediante migrate diff --from-empty --to-schema.\n-- NO aplicado. No se conecta a una base ni debe ejecutarse sin autorización.\n-- Requiere 000_roles.sql y un aplicador autorizado capaz de asumir wc_data_owner.\n-- El esquema app_private ya pertenece a ese owner.\n\nBEGIN;\nSET LOCAL ROLE wc_data_owner;\n\n${ddl}\n\nCOMMIT;\n`;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((arg) => !['--check', '--write'].includes(arg))) {
    throw new Error('Opciones admitidas: --check o --write, sin parámetros de conexión.');
  }
  const root = fileURLToPath(new URL('../', import.meta.url));
  const schema = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));
  const target = fileURLToPath(new URL('../prisma/sql/001_schema.sql', import.meta.url));
  const cli = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));
  const output = execFileSync(process.execPath, [
    cli, 'migrate', 'diff', '--from-empty', '--to-schema', schema, '--script',
  ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 5 * 1024 * 1024 });
  const rendered = renderReviewableSchema(output);
  const existing = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
  if (existing === rendered) {
    console.log('OK: 001_schema.sql coincide con el esquema Prisma; sin conexión ni SQL ejecutado.');
    return;
  }
  if (args.includes('--check')) throw new Error('001_schema.sql falta o difiere del esquema Prisma.');
  if (existing !== undefined && (!args.includes('--write') || !existing.startsWith(marker))) {
    throw new Error('No se reemplaza un SQL existente. Revise el diff; --write solo permite un archivo generado reconocido.');
  }
  writeFileSync(target, rendered, { flag: existing === undefined ? 'wx' : 'w' });
  console.log('001_schema.sql preparado para revisión. No se conectó a PostgreSQL ni se ejecutó SQL.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch {
    console.error('No se pudo preparar/verificar el DDL. Revise Prisma y el SQL existente; no se ejecutó SQL ni se muestran detalles de conexión.');
    process.exitCode = 1;
  }
}
