import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import type { Client } from 'pg';

export const project = 'whatscommerceec-auth-dev';
export const database = 'whatscommerceec_auth_dev';
export const adminUser = 'wc_migrator_dev';
export const roles = ['wc_data_owner', 'wc_identity', 'wc_tenant', 'wc_platform', 'wc_delivery', 'wc_identity_owner', 'wc_tenant_owner'];
export const sqlFiles = ['000_roles.sql', '001_schema.sql', '002_constraints.sql', '003_rls.sql', '004_auth_context.sql'];
export function gate(ok: unknown): asserts ok { if (!ok) throw new Error('AUTH_DEV_SAFETY_CHECK'); }
export function safeError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? `AUTH_DEV_FAILED (${code})` : 'AUTH_DEV_FAILED';
}
const secret = (): string => randomBytes(32).toString('base64url');
const url = (user: string, password: string): string => `postgresql://${user}:${password}@127.0.0.1:55432/${database}`;
export interface Profiles { admin: Record<string, string>; runtime: Record<string, string> }
export function generateProfiles(): Profiles {
  const password = secret();
  return { admin: { POSTGRES_USER: adminUser, POSTGRES_DB: database, POSTGRES_PASSWORD: password, AUTH_DEV_ADMIN_URL: url(adminUser, password) },
    runtime: { NODE_ENV: 'development', AUTH_ENABLED: 'true', PORT: '3000', REDIS_URL: 'redis://127.0.0.1:16379',
      AUTH_IDENTITY_DATABASE_URL: url('wc_identity', secret()), AUTH_TENANT_DATABASE_URL: url('wc_tenant', secret()),
      AUTH_JWT_KEY: secret(), AUTH_CURSOR_KEY: secret(), AUTH_RATE_LIMIT_KEY: secret() } };
}
export function validateDatabaseUrl(value: string | undefined, user: string): URL {
  gate(value);
  const parsed = new URL(value);
  gate(parsed.protocol === 'postgresql:' && parsed.hostname === '127.0.0.1' && parsed.port === '55432' &&
    parsed.pathname === `/${database}` && parsed.username === user && !parsed.search && !parsed.hash && /^[A-Za-z0-9_-]{43}$/.test(parsed.password));
  gate(parsed.href === url(user, parsed.password));
  return parsed;
}
export function validateProfiles(profiles: Profiles): Profiles {
  const { admin: a, runtime: r } = profiles;
  const expected = generateProfiles();
  for (const key of ['admin', 'runtime'] as const) gate(Object.keys(profiles[key]).sort().join() === Object.keys(expected[key]).sort().join());
  gate(a.POSTGRES_USER === adminUser && a.POSTGRES_DB === database);
  gate(validateDatabaseUrl(a.AUTH_DEV_ADMIN_URL, adminUser).password === a.POSTGRES_PASSWORD);
  const identity = validateDatabaseUrl(r.AUTH_IDENTITY_DATABASE_URL, 'wc_identity').password;
  const tenant = validateDatabaseUrl(r.AUTH_TENANT_DATABASE_URL, 'wc_tenant').password;
  gate(r.NODE_ENV === 'development' && r.AUTH_ENABLED === 'true' && r.PORT === '3000' && r.REDIS_URL === 'redis://127.0.0.1:16379');
  const secrets = [a.POSTGRES_PASSWORD, identity, tenant, r.AUTH_JWT_KEY, r.AUTH_CURSOR_KEY, r.AUTH_RATE_LIMIT_KEY];
  gate(secrets.every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)) && new Set(secrets).size === secrets.length);
  return profiles;
}
export function loadProfiles(root: string, create = false): Profiles {
  const paths = ['.env.auth-admin', '.env.auth-dev'].map(name => resolve(root, name));
  const present = paths.map(path => existsSync(path));
  gate(present.every(Boolean) || (present.every(value => !value) && create));
  if (!present[0]) {
    const generated = generateProfiles();
    // A partial write is intentionally left for manual review; never repair/delete.
    for (const [index, values] of [generated.admin, generated.runtime].entries()) {
      writeFileSync(paths[index]!, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''), { flag: 'wx', mode: 0o600 });
    }
  }
  for (const path of paths) gate(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink());
  return validateProfiles({ admin: parse(readFileSync(paths[0]!)), runtime: parse(readFileSync(paths[1]!)) });
}

// Mask comments, quoted identifiers/strings and dollar bodies before finding
// standalone transaction statements. PL/pgSQL BEGIN/END must not be counted.
export function unwrapSql(sql: string): string {
  const masked = sql.replace(/--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|(\$[A-Za-z_0-9]*\$)[\s\S]*?\1/g, value => ' '.repeat(value.length));
  const matches = [...masked.matchAll(/(?:^|;)\s*(BEGIN|COMMIT)\s*;/gi)];
  gate(matches.length === 2 && matches[0]![1]!.toUpperCase() === 'BEGIN' && matches[1]![1]!.toUpperCase() === 'COMMIT');
  const first = matches[0]!, last = matches[1]!;
  const start = first.index + first[0].length;
  const end = last.index + (last[0].startsWith(';') ? 1 : 0);
  gate(!masked.slice(0, first.index).trim() && !masked.slice(last.index + last[0].length).trim());
  return sql.slice(start, end);
}
export function sqlBundle(root: string): { bodies: string[]; checksum: string } {
  const texts = sqlFiles.map(name => readFileSync(resolve(root, 'prisma/sql', name), 'utf8'));
  return { bodies: texts.map(unwrapSql), checksum: createHash('sha256').update(texts.map((text, i) => `${sqlFiles[i]}\0${text}\0`).join('')).digest('hex') };
}
export async function verifyAdmin(client: Client): Promise<void> {
  const result = await client.query<{ db: string; usr: string; super: boolean; port: number; version: number }>(
    `SELECT current_database() db, current_user usr, rolsuper super, inet_server_port() port,
     current_setting('server_version_num')::int version FROM pg_roles WHERE rolname=current_user`);
  const row = result.rows[0];
  gate(row && row.db === database && row.usr === adminUser && row.super && row.port === 5432 && row.version >= 170000 && row.version < 180000);
}
export async function checkReceipt(client: Client, checksum: string): Promise<boolean> {
  const schema = await client.query<{ owner: string }>(`SELECT pg_get_userbyid(nspowner) owner FROM pg_namespace WHERE nspname='wc_ops'`);
  if (!schema.rowCount) return false;
  gate(schema.rows[0]?.owner === adminUser);
  const receipt = await client.query<{ checksum: string; owner: string }>(`SELECT checksum, pg_get_userbyid(c.relowner) owner FROM wc_ops.receipt r JOIN pg_class c ON c.oid='wc_ops.receipt'::regclass`);
  gate(receipt.rowCount === 1 && receipt.rows[0]?.checksum === checksum && receipt.rows[0]?.owner === adminUser);
  return true;
}
export async function applySql(client: Client, profiles: Profiles, bundle: ReturnType<typeof sqlBundle>): Promise<void> {
  await verifyAdmin(client);
  await client.query('BEGIN');
  try {
    await client.query(`SELECT pg_advisory_xact_lock(174013,1)`);
    if (!await checkReceipt(client, bundle.checksum)) {
      const existing = await client.query(`SELECT 1 FROM pg_roles WHERE rolname LIKE 'wc\\_%' ESCAPE '\\' AND rolname <> $1
        UNION ALL SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname NOT LIKE 'pg_%'`, [adminUser]);
      gate(existing.rowCount === 0);
      for (const body of bundle.bodies) await client.query(`RESET ROLE;\n${body}\nRESET ROLE;`);
      await client.query(`CREATE SCHEMA wc_ops AUTHORIZATION wc_migrator_dev; REVOKE ALL ON SCHEMA wc_ops FROM PUBLIC;
        CREATE TABLE wc_ops.receipt(checksum text NOT NULL); REVOKE ALL ON wc_ops.receipt FROM PUBLIC;`);
      await client.query('INSERT INTO wc_ops.receipt(checksum) VALUES ($1)', [bundle.checksum]);
    }
    // Never use ALTER ROLE ... PASSWORD $1 (PostgreSQL grammar disallows it).
    for (const [role, key] of [['wc_identity', 'AUTH_IDENTITY_DATABASE_URL'], ['wc_tenant', 'AUTH_TENANT_DATABASE_URL']] as const) {
      const password = validateDatabaseUrl(profiles.runtime[key], role).password;
      const formatted = await client.query<{ sql: string }>(`SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT PASSWORD %L', $1::text, $2::text) sql`, [role, password]);
      const memberships = await client.query(`SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=$1)`, [role]);
      gate(memberships.rowCount === 0);
      await client.query(formatted.rows[0]!.sql);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
}
