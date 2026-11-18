/** Cierre 1.4: HTTP + PostgreSQL + Redis reales, sin perfiles ni datos DEV. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { Client } from 'pg';
import { Redis } from 'ioredis';
import { check, root } from './auth-real/support.js';
import { main } from './auth-real.js';
import { adminUser, database, sqlBundle, verifyAdmin } from '../scripts/auth-local-core.js';

const runId = randomUUID();
const postgres = `wc-auth-close-pg-${runId.slice(0, 8)}`;
const redisName = `wc-auth-close-redis-${runId.slice(0, 8)}`;
const started: string[] = [];
let step = 'docker';
const secret = () => randomBytes(32).toString('base64url');
const adminPassword = secret(); const identityPassword = secret(); const tenantPassword = secret();
const docker = (args: string[], timeout = 120000) => execFileSync('docker', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 1024 * 1024,
  env: { ...process.env, POSTGRES_PASSWORD: adminPassword },
}).trim();
function cleanup(): void {
  for (const name of started.splice(0).reverse()) {
    try { docker(['stop', '--time', '2', name], 10000); }
    catch { console.error(`AUTH_ISOLATED_CLEANUP_FAILED container=${name}`); process.exitCode = 1; }
  }
}
// The legacy acceptance deadline calls process.exit; still clean only our own
// disposable containers on that path, not just on normal async completion.
process.once('exit', cleanup);
function port(name: string, target: string, image: string): string {
  const inspection = JSON.parse(docker(['inspect', name])) as Array<{
    Config: { Image: string; Labels?: Record<string, string> }; Mounts: Array<{ Type: string }>;
    HostConfig: { PortBindings: Record<string, Array<{ HostIp: string }>> };
  }>;
  const c = inspection[0]; check(inspection.length === 1 && c?.Config.Image === image && c.Config.Labels?.['wc.acceptance.run'] === runId);
  check(!c.Mounts.some(m => m.Type === 'bind')); // No repository/profile/DEV mounts.
  check(c.HostConfig.PortBindings[target]?.length === 1 && c.HostConfig.PortBindings[target]?.[0]?.HostIp === '127.0.0.1');
  const binding = /^127\.0\.0\.1:(\d+)$/.exec(docker(['port', name, target])); check(binding);
  check(!['55432', '16379', '5432', '6379'].includes(binding[1]!));
  return binding[1]!;
}
async function isolated(): Promise<void> {
  check(!process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT && !process.env.DOCKER_TLS_VERIFY && !process.env.DOCKER_CERT_PATH);
  const context = JSON.parse(docker(['context', 'inspect'])) as Array<{ Endpoints?: { docker?: { Host?: string } } }>;
  check(context.length === 1 && /^(npipe:\/\/\/|unix:\/\/\/)/.test(context[0]?.Endpoints?.docker?.Host ?? ''));
  docker(['run', '--rm', '-d', '--name', postgres, '--label', `wc.acceptance.run=${runId}`, '-p', '127.0.0.1::5432',
    '-e', 'POSTGRES_PASSWORD', '-e', `POSTGRES_USER=${adminUser}`, '-e', `POSTGRES_DB=${database}`, 'postgres:17-alpine']); started.push(postgres);
  docker(['run', '--rm', '-d', '--name', redisName, '--label', `wc.acceptance.run=${runId}`, '-p', '127.0.0.1::6379',
    'redis:7-alpine', 'redis-server', '--save', '', '--appendonly', 'no']); started.push(redisName);
  const pgPort = port(postgres, '5432/tcp', 'postgres:17-alpine');
  const redisPort = port(redisName, '6379/tcp', 'redis:7-alpine');
  const url = (user: string, password: string) => `postgresql://${user}:${password}@127.0.0.1:${pgPort}/${database}`;
  const adminUrl = url(adminUser, adminPassword);
  const runtime: Record<string, string> = {
    NODE_ENV: 'test', PORT: '3000', AUTH_ENABLED: 'true', REDIS_URL: `redis://127.0.0.1:${redisPort}`,
    AUTH_IDENTITY_DATABASE_URL: url('wc_identity', identityPassword), AUTH_TENANT_DATABASE_URL: url('wc_tenant', tenantPassword),
    AUTH_JWT_KEY: secret(), AUTH_CURSOR_KEY: secret(), AUTH_RATE_LIMIT_KEY: secret(),
    RECOVERY_ENABLED: 'true', RECOVERY_MAC_KEY: secret(), RECOVERY_ENCRYPTION_KEY: secret(),
    RECOVERY_DELIVERY_DATABASE_URL: url('wc_delivery', secret()), SMTP_USER: 'synthetic.sender@gmail.com',
    SMTP_APP_PASSWORD: 'a'.repeat(16), RECOVERY_MAIL_TRANSPORT: 'smtp', COMPANIES_ENABLED: 'false',
  };
  step = 'postgres-ready';
  const admin = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 1000 });
  let ready = false;
  // Each attempt uses a fresh client; a failed pg Client cannot reconnect.
  for (let attempt = 0; attempt < 60; attempt++) {
    const probe = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 1000 });
    try { await probe.connect(); await probe.query('SELECT 1'); ready = true; }
    catch { /* Disposable target only. */ } finally { await probe.end().catch(() => undefined); }
    if (ready) break;
    await setTimeout(250);
  }
  check(ready);
  await admin.connect();
  try {
    await verifyAdmin(admin);
    step = 'sql';
    for (const file of ['000_roles.sql', '001_schema.sql', '002_constraints.sql', '003_rls.sql', '004_auth_context.sql', '005_password_recovery.sql', '006_companies.sql']) {
      await admin.query(readFileSync(new URL(`../prisma/sql/${file}`, import.meta.url), 'utf8'));
    }
    for (const [role, password] of [['wc_identity', identityPassword], ['wc_tenant', tenantPassword]]) {
      const formatted = await admin.query<{ sql: string }>("SELECT format('ALTER ROLE %I LOGIN PASSWORD %L',$1::text,$2::text) AS sql", [role, password]);
      await admin.query(formatted.rows[0]!.sql);
    }
    await admin.query(`CREATE SCHEMA wc_ops AUTHORIZATION wc_migrator_dev; REVOKE ALL ON SCHEMA wc_ops FROM PUBLIC;
      CREATE TABLE wc_ops.receipt(checksum text NOT NULL); REVOKE ALL ON wc_ops.receipt FROM PUBLIC;`);
    await admin.query('INSERT INTO wc_ops.receipt(checksum) VALUES($1)', [sqlBundle(root).checksum]);
  } finally { await admin.end(); }
  step = 'redis-ready';
  const redis = new Redis(runtime.REDIS_URL!, { lazyConnect: true, connectTimeout: 3000, retryStrategy: () => null });
  redis.on('error', () => {});
  try { await redis.connect(); check(await redis.ping() === 'PONG'); } finally { redis.disconnect(); }
  step = 'acceptance';
  // These process-only values are never written to a profile or inherited by DEV.
  for (const key of Object.keys(process.env)) if (/^(AUTH_|RECOVERY_|COMPANIES_|SMTP_|GMAIL_|REDIS_URL$|DATABASE_URL$)/.test(key)) delete process.env[key];
  Object.assign(process.env, runtime);
  const allowed = new Map([['wc_identity', runtime.AUTH_IDENTITY_DATABASE_URL], ['wc_tenant', runtime.AUTH_TENANT_DATABASE_URL]]);
  await main({
    // Bound test startup on a busy Windows host; does not change any API/client SLA.
    loadProfiles: () => ({ runtime, adminUrl }), verifyAdmin, httpTimeoutMs: 15000,
    databaseUrl: (value, role) => { check(value && value === allowed.get(role), 'DISPOSABLE_TARGET_MISMATCH'); return value; },
    stopDisposableRedis: async () => {
      docker(['stop', redisName]);
      started.splice(started.indexOf(redisName), 1);
    },
  });
  check(!process.exitCode, 'ACCEPTANCE_FAILED');
  console.log('AUTH_ISOLATED_OK HTTP/PostgreSQL17/Redis7/client-TS reales; almacenamiento nativo simulado; sin perfiles/DEV/SMTP.');
}
try { await isolated(); }
catch { console.error(`AUTH_ISOLATED_FAILED step=${step}; sin datos privados.`); process.exitCode = 1; }
finally {
  cleanup(); process.removeListener('exit', cleanup);
}
