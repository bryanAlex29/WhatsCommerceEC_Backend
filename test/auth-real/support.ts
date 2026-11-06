import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, randomInt } from 'node:crypto';
import { parse } from 'dotenv';
import { Pool } from 'pg';
import { hashPassword } from '../../src/modules/auth/crypto.js';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export function check(condition: unknown, code = 'ASSERTION_FAILED'): asserts condition {
  if (!condition) throw new Error(code);
}
export function databaseUrl(value: string | undefined, role: string): string {
  check(value, 'PROFILE_DATABASE_MISSING');
  const url = new URL(value);
  check(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === '127.0.0.1'
    && url.port === '55432' && url.pathname === '/whatscommerceec_auth_dev'
    && decodeURIComponent(url.username) === role && !!url.password
    && [...url.searchParams.keys()].every(key => ['schema', 'connection_limit', 'connect_timeout'].includes(key)),
  'PROFILE_DATABASE_NOT_ISOLATED');
  return value;
}
export function loadProfiles() {
  // Never load .env, interpolate, print, or fall back to a different cluster.
  const admin = parse(readFileSync(new URL('../../.env.auth-admin', import.meta.url)));
  const runtime = parse(readFileSync(new URL('../../.env.auth-dev', import.meta.url)));
  const adminUrl = databaseUrl(admin.AUTH_DEV_ADMIN_URL, 'wc_migrator_dev');
  databaseUrl(runtime.AUTH_IDENTITY_DATABASE_URL, 'wc_identity');
  databaseUrl(runtime.AUTH_TENANT_DATABASE_URL, 'wc_tenant');
  check(runtime.AUTH_ENABLED === 'true' && runtime.NODE_ENV === 'development', 'PROFILE_NOT_DEV');
  const redis = new URL(runtime.REDIS_URL ?? '');
  check(redis.protocol === 'redis:' && redis.hostname === '127.0.0.1' && redis.port === '16379'
    && !redis.username && !redis.password && ['', '/', '/0'].includes(redis.pathname) && !redis.search,
  'PROFILE_REDIS_NOT_ISOLATED');
  const keys = ['AUTH_JWT_KEY', 'AUTH_CURSOR_KEY', 'AUTH_RATE_LIMIT_KEY'].map(key => {
    const value = runtime[key];
    check(value && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').length === 32,
      'PROFILE_KEY_INVALID');
    return value;
  });
  check(new Set(keys).size === 3, 'PROFILE_KEYS_NOT_SEPARATED');
  // Per-run private namespace: quotas never interfere with another runner or the DEV API.
  runtime.AUTH_RATE_LIMIT_KEY = randomBytes(32).toString('base64url');
  Object.assign(process.env, runtime);
  return { adminUrl, runtime };
}
export function pool(url: string, max = 1): Pool {
  const value = new Pool({ connectionString: url, max, connectionTimeoutMillis: 3000,
    query_timeout: 4000, statement_timeout: 3000, idleTimeoutMillis: 1000 });
  value.on('error', () => { /* private diagnostics are deliberately suppressed */ });
  return value;
}
export async function fixture(admin: Pool) {
  const runId = randomUUID();
  const sellerId = randomUUID(); const adminId = randomUUID();
  const companyA = randomUUID(); const companyB = randomUUID();
  const password = `A!${randomBytes(32).toString('base64url')}`;
  const sellerEmail = `auth-check-${runId}@example.test`;
  const adminEmail = `auth-check-${randomUUID()}@example.test`;
  const hash = await hashPassword(password);
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO app_private.app_user
      (id,email_normalized,password_hash) VALUES ($1,$2,$3),($4,$5,$3)`,
    [sellerId, sellerEmail, hash, adminId, adminEmail]);
    for (const id of [companyA, companyB]) {
      const ruc = `9${String(randomInt(0, 1_000_000)).padStart(6, '0')}${String(randomInt(0, 1_000_000)).padStart(6, '0')}`;
      await client.query(`INSERT INTO app_private.company
        (id,trade_name,legal_name,ruc,tax_address,contact_email,contact_phone,status,activated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE',clock_timestamp())`,
      [id, `SYNTHETIC auth-real ${runId}`, 'SYNTHETIC fixture test/auth-real.ts', ruc,
        'SYNTHETIC TEST ONLY', `auth-check-${runId}@example.test`, '+593999999999']);
    }
    await client.query(`INSERT INTO app_private.membership (id,user_id,company_id,role)
      VALUES ($1,$2,$3,'SELLER'),($4,$5,$3,'COMPANY_ADMIN')`,
    [randomUUID(), sellerId, companyA, randomUUID(), adminId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
  return { runId, sellerId, adminId, companyA, companyB, sellerEmail, adminEmail, password, hash };
}
export async function revoked(admin: Pool, sessionId: string): Promise<boolean> {
  const result = await admin.query<{ revoked: boolean }>(
    'SELECT revoked_at IS NOT NULL AS revoked FROM app_private.app_session WHERE id=$1', [sessionId]);
  check(result.rowCount === 1, 'AUDIT_SESSION_MISSING');
  return result.rows[0]?.revoked === true;
}
export function sanitized(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    && /^[A-Z0-9_]{3,64}$/.test(error.code)) return error.code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,64}$/.test(error.message)) return error.message;
  return 'CHECK_FAILED';
}
