import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { INestApplication, Type } from '@nestjs/common';
import request from 'supertest';
import { decodeJwt, SignJWT } from 'jose';
import { Redis } from 'ioredis';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaIdentityPort } from '../src/modules/auth/persistence/adapters.js';
import { CompanyCursor } from '../src/modules/auth/cursor.js';
import { AccessTokens, randomRefresh } from '../src/modules/auth/crypto.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { AuthError } from '../src/modules/auth/errors.js';
import { RedisRateLimits, RateLimitError } from '../src/modules/auth/rate-limit.js';
import { check, databaseUrl, fixture, loadProfiles, pool, revoked, root, sanitized } from './auth-real/support.js';
import { checkReceipt, sqlBundle, verifyAdmin } from '../scripts/auth-local-core.js';

interface Tokens { accessToken: string; refreshToken: string; refreshExpiresAt: string;
  expiresIn: number; tokenType: string; user: { id: string; platformRole: string | null } }
interface Page { items: Array<{ companyId: string; status: string; role: string }>; nextCursor: string | null }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Explicit DEV acceptance entrypoint; importing this file never creates fixtures. */
export async function main(): Promise<void> {
  let current = 'PROFILE'; let passed = 0; let fixtureId = 'none';
  let app: INestApplication | undefined;
  const close: Array<() => Promise<unknown>> = [];
  // Hard process deadline also bounds teardown; never emits private errors/stacks.
  const deadline = setTimeout(() => {
    process.stderr.write(`FAIL TIMEOUT case=${current} PASS=${passed} fixture=${fixtureId}\n`);
    process.exit(1);
  }, 60_000);
  const test = async (name: string, work: () => Promise<void>) => {
    current = name; await work(); passed++;
  };
  try {
    const { runtime, adminUrl } = loadProfiles();
    const admin = pool(adminUrl); close.push(() => admin.end());
    const verification = await admin.connect();
    try {
      await verifyAdmin(verification);
      check(await checkReceipt(verification, sqlBundle(root).checksum), 'SETUP_RECEIPT_MISSING');
    } finally { verification.release(); }
    current = 'FIXTURE';
    const f = await fixture(admin); fixtureId = f.runId;
    // Use tsc output: tsx does not emit Nest constructor injection metadata.
    current = 'APP_BOOT_BUILD_REQUIRED';
    const { NestFactory } = await import('@nestjs/core');
    const moduleUrl = new URL('../dist/app.module.js', import.meta.url).href;
    const configureUrl = new URL('../dist/configure-app.js', import.meta.url).href;
    const { AppModule } = await import(moduleUrl) as { AppModule: Type<unknown> };
    const { configureApp } = await import(configureUrl) as { configureApp(app: INestApplication): void };
    app = await NestFactory.create(AppModule, { logger: false, bodyParser: false, abortOnError: false });
    configureApp(app); await app.listen(0, '127.0.0.1');
    const api = request(app.getHttpServer());
    const post = (path: string, body: object) => api.post(`/api/${path}`).send(body).timeout(5000);
    const get = (path: string, token?: string) => {
      const req = api.get(`/api/${path}`).timeout(5000);
      return token ? req.set('Authorization', `Bearer ${token}`) : req;
    };
    const status = (response: request.Response, expected: number, code?: string) => {
      check(response.status === expected, 'HTTP_STATUS_MISMATCH');
      if (code) check((response.body as { error?: { code?: string } }).error?.code === code, 'HTTP_CODE_MISMATCH');
    };
    const login = async (adminUser = false): Promise<Tokens> => {
      const response = await post('auth/login', { email: adminUser ? f.adminEmail : f.sellerEmail, password: f.password });
      status(response, 200); return response.body as Tokens;
    };
    const sid = (tokens: Tokens): string => { const value = decodeJwt(tokens.accessToken).sid; check(typeof value === 'string'); return value; };
    let seller!: Tokens; let manager!: Tokens;
    await test('LOGIN_INDISTINGUISHABLE', async () => {
      const wrong = await post('auth/login', { email: f.sellerEmail, password: 'A!incorrect-synthetic-password' });
      const absent = await post('auth/login', { email: `auth-check-${randomUUID()}@example.test`, password: f.password });
      status(wrong, 401, 'INVALID_CREDENTIALS'); status(absent, 401, 'INVALID_CREDENTIALS');
      check(same(wrong.body, absent.body));
    });
    await test('LOGIN_AND_IDENTITY', async () => {
      seller = await login(); manager = await login(true);
      check(seller.expiresIn === 900 && seller.tokenType === 'Bearer' && seller.user.id === f.sellerId
        && seller.user.platformRole === null && /^[A-Za-z0-9_-]{43}$/.test(seller.refreshToken));
      const identity = await get('auth/me', seller.accessToken); status(identity, 200);
      check((identity.body as { id: string }).id === f.sellerId && identity.headers['cache-control'] === 'no-store');
      const expiry = Date.parse(seller.refreshExpiresAt) - Date.now(); check(expiry > 0 && expiry <= 7 * 86400_000);
    });
    await test('STRICT_JSON', async () => {
      status(await api.post('/api/auth/login').type('json').send('{"email":"a@example.test","email":"b@example.test","password":"A!synthetic-password"}').timeout(5000), 400);
      status(await post('auth/login', { email: f.sellerEmail, password: f.password, role: 'PLATFORM_ADMIN' }), 400);
      status(await post('auth/login', { email: f.sellerEmail, password: 'A'.repeat(16 * 1024) }), 413, 'PAYLOAD_TOO_LARGE');
    });
    await test('MISSING_INVALID_JWT', async () => {
      status(await get('auth/me'), 401, 'UNAUTHENTICATED');
      status(await get('auth/me', 'invalid'), 401, 'UNAUTHENTICATED');
    });
    await test('EXPIRED_SIGNATURE_PRECEDENCE', async () => {
      const issue = (key: Uint8Array) => {
        const exp = Math.floor(Date.now() / 1000) - 10;
        return new SignJWT({ sid: sid(seller) }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
          .setSubject(f.sellerId).setIssuer('whatscommerceec-api').setAudience('whatscommerceec-clients')
          .setIssuedAt(exp - 900).setExpirationTime(exp).sign(key);
      };
      status(await get('auth/me', await issue(Buffer.from(runtime.AUTH_JWT_KEY!, 'base64url'))), 401, 'ACCESS_TOKEN_EXPIRED');
      status(await get('auth/me', await issue(randomBytes(32))), 401, 'UNAUTHENTICATED');
    });
    await test('SELECTOR_MINIMAL', async () => {
      const response = await get('me/companies', seller.accessToken); status(response, 200);
      const page = response.body as Page;
      check(page.items.length === 1 && page.nextCursor === null && page.items[0]?.companyId === f.companyA);
      check(same(Object.keys(page.items[0]!).sort(), ['companyId', 'role', 'status', 'tradeName']));
    });
    await test('PAGINATION_REAL_CURSOR_BOUND_TO_SESSION', async () => {
      // Únicamente filas nuevas de esta ejecución sintética; no se elimina información.
      const client = await admin.connect();
      try {
        await client.query('BEGIN');
        for (let index = 0; index < 21; index++) {
          const companyId = randomUUID();
          const ruc = `8${String(randomBytes(6).readUIntBE(0, 6) % 1_000_000_000_000).padStart(12, '0')}`;
          await client.query(`INSERT INTO app_private.company(id,trade_name,legal_name,ruc,tax_address,contact_email,contact_phone,status,activated_at)
            VALUES($1,$2,'SYNTHETIC pagination',$3,'SYNTHETIC TEST ONLY',$4,'+593999999999','ACTIVE',clock_timestamp())`,
          [companyId, `SYNTHETIC page ${fixtureId} ${index}`, ruc, f.sellerEmail]);
          await client.query(`INSERT INTO app_private.membership(id,user_id,company_id,role) VALUES($1,$2,$3,'SELLER')`,
            [randomUUID(), f.sellerId, companyId]);
        }
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
      finally { client.release(); }
      const first = await get('me/companies', seller.accessToken); status(first, 200);
      const page = first.body as Page;
      check(page.items.length === 20 && typeof page.nextCursor === 'string');
      const second = await get(`me/companies?cursor=${encodeURIComponent(page.nextCursor!)}`, seller.accessToken); status(second, 200);
      const tail = second.body as Page;
      check(tail.items.length === 2 && tail.nextCursor === null);
      check(new Set([...page.items, ...tail.items].map(item => item.companyId)).size === 22);
      status(await get(`me/companies?cursor=${encodeURIComponent(page.nextCursor!)}`, manager.accessToken), 400, 'INVALID_CURSOR');
      status(await get('me/companies?cursor=altered', seller.accessToken), 400, 'INVALID_CURSOR');
    });
    await test('BASIC_FULL_PROJECTION', async () => {
      const basic = await get(`companies/${f.companyA}`, seller.accessToken); status(basic, 200);
      check(same(Object.keys(basic.body as object).sort(), ['id', 'representation', 'status', 'tradeName']));
      check((basic.body as { representation: string }).representation === 'BASIC');
      const full = await get(`companies/${f.companyA}`, manager.accessToken); status(full, 200);
      check((full.body as { representation: string }).representation === 'FULL' && 'ruc' in (full.body as object));
    });
    await test('FOREIGN_ABSENT_INDISTINGUISHABLE', async () => {
      const foreign = await get(`companies/${f.companyB}`, seller.accessToken);
      const absent = await get(`companies/${randomUUID()}`, seller.accessToken);
      status(foreign, 404, 'RESOURCE_NOT_FOUND'); status(absent, 404, 'RESOURCE_NOT_FOUND'); check(same(foreign.body, absent.body));
    });
    await test('MOBILE_TYPESCRIPT_CLIENT_REAL_HTTP_DATABASE', async () => {
      // Cliente TS móvil real y fetch real. Solo almacenamiento seguro se sustituye:
      // SecureStore del dispositivo sigue requiriendo verificación nativa.
      const moduleUrl = new URL('../../WhatsCommerceEC_Frontend/src/auth/session.ts', import.meta.url).href;
      interface MobileState { user: { id: string } | null; company: { id: string; representation: string } | null;
        companies: unknown[]; nextCursor: string | null }
      interface MobileClient { login(email: string, password: string): Promise<void>; selectCompany(id: string): Promise<void>;
        loadCompanies(more?: boolean): Promise<void>; logout(): Promise<void>; getSnapshot(): MobileState }
      const { Session } = await import(moduleUrl) as { Session: new (storage: {
        read(): Promise<string | null>; write(value: string): Promise<void>; clear(): Promise<void>;
      }) => MobileClient };
      const previousUrl = process.env.EXPO_PUBLIC_API_URL;
      process.env.EXPO_PUBLIC_API_URL = await app!.getUrl();
      let saved: string | null = null;
      const mobile = new Session({ read: async () => saved, write: async value => { saved = value; }, clear: async () => { saved = null; } });
      try {
        await mobile.login(f.sellerEmail, f.password);
        check(mobile.getSnapshot().user?.id === f.sellerId && saved !== null, 'MOBILE_LOGIN_FAILED');
        check(mobile.getSnapshot().companies.length === 20 && mobile.getSnapshot().nextCursor !== null, 'MOBILE_PAGE_FAILED');
        await mobile.loadCompanies(true); check(mobile.getSnapshot().companies.length === 22, 'MOBILE_NEXT_PAGE_FAILED');
        await mobile.selectCompany(f.companyA);
        check(mobile.getSnapshot().company?.representation === 'BASIC' && !('ruc' in mobile.getSnapshot().company!), 'MOBILE_PROJECTION_FAILED');
        await mobile.selectCompany(f.companyB);
        check(mobile.getSnapshot().company === null && mobile.getSnapshot().user !== null, 'MOBILE_FOREIGN_FAILED');
        await mobile.logout();
        check(saved === null && mobile.getSnapshot().user === null && mobile.getSnapshot().companies.length === 0, 'MOBILE_LOGOUT_FAILED');
        const audit = await admin.query<{ revoked: boolean }>(`SELECT revoked_at IS NOT NULL revoked FROM app_private.app_session
          WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`, [f.sellerId]);
        check(audit.rows[0]?.revoked === true, 'MOBILE_REVOCATION_NOT_PERSISTED');
      } finally {
        if (previousUrl === undefined) delete process.env.EXPO_PUBLIC_API_URL; else process.env.EXPO_PUBLIC_API_URL = previousUrl;
      }
    });
    await test('LIVE_MEMBERSHIP_RECHECK', async () => {
      await admin.query('UPDATE app_private.membership SET role=\'SELLER\' WHERE user_id=$1 AND company_id=$2', [f.adminId, f.companyA]);
      const response = await get(`companies/${f.companyA}`, manager.accessToken); status(response, 200);
      check((response.body as { representation: string }).representation === 'BASIC' && !('ruc' in (response.body as object)));
    });
    await test('LIVE_SUSPENSION_RECHECK', async () => {
      await admin.query('UPDATE app_private.company SET status=\'SUSPENDED\' WHERE id=ANY($1::uuid[])', [[f.companyA, f.companyB]]);
      status(await get(`companies/${f.companyA}`, seller.accessToken), 403, 'COMPANY_SUSPENDED');
      status(await get(`companies/${f.companyB}`, seller.accessToken), 404, 'RESOURCE_NOT_FOUND');
      const response = await get('me/companies', seller.accessToken); status(response, 200);
      const page = response.body as Page; check(page.items[0]?.status === 'SUSPENDED');
      check(same(Object.keys(page.items[0]!).sort(), ['companyId', 'role', 'status', 'tradeName']));
    });
    await test('LOGOUT_PERSISTED_UNKNOWN_IDEMPOTENT', async () => {
      status(await post('auth/logout', { refreshToken: seller.refreshToken }), 204);
      check(await revoked(admin, sid(seller))); status(await get('auth/me', seller.accessToken), 401, 'SESSION_REVOKED');
      status(await post('auth/logout', { refreshToken: randomRefresh() }), 204);
      status(await post('auth/logout', { refreshToken: seller.refreshToken }), 204);
    });
    await test('REFRESH_ABSOLUTE_EXPIRY_AND_REUSE', async () => {
      const original = await login();
      const rotated = await post('auth/refresh', { refreshToken: original.refreshToken }); status(rotated, 200);
      const next = rotated.body as Tokens;
      check(next.refreshToken !== original.refreshToken && next.refreshExpiresAt === original.refreshExpiresAt);
      status(await post('auth/refresh', { refreshToken: original.refreshToken }), 401, 'SESSION_REVOKED');
      check(await revoked(admin, sid(next))); status(await get('auth/me', next.accessToken), 401, 'SESSION_REVOKED');
    });
    await test('REFRESH_RACE_COMMITS_REVOCATION', async () => {
      const original = await login();
      const results = await Promise.all([post('auth/refresh', { refreshToken: original.refreshToken }), post('auth/refresh', { refreshToken: original.refreshToken })]);
      check(same(results.map(value => value.status).sort(), [200, 401]));
      const winner = results.find(value => value.status === 200)!;
      const loser = results.find(value => value.status === 401)!; status(loser, 401, 'SESSION_REVOKED');
      check(await revoked(admin, sid(original))); status(await get('auth/me', (winner.body as Tokens).accessToken), 401, 'SESSION_REVOKED');
    });
    await test('HISTORICAL_LOGOUT', async () => {
      const original = await login(); const response = await post('auth/refresh', { refreshToken: original.refreshToken }); status(response, 200);
      status(await post('auth/logout', { refreshToken: original.refreshToken }), 204);
      check(await revoked(admin, sid(original))); status(await get('auth/me', (response.body as Tokens).accessToken), 401, 'SESSION_REVOKED');
    });
    const identityPool = pool(databaseUrl(runtime.AUTH_IDENTITY_DATABASE_URL, 'wc_identity'));
    close.push(() => identityPool.end());
    const prisma = new PrismaClient({ adapter: new PrismaPg(identityPool, { schema: 'app_private' }), log: [], errorFormat: 'minimal' });
    close.push(() => prisma.$disconnect());
    const identity = new PrismaIdentityPort(prisma, new CompanyCursor(Buffer.from(runtime.AUTH_CURSOR_KEY!, 'base64url')));
    await test('SQL_EFFECTIVE_ROLES_DENY', async () => {
      for (const [url, role] of [[runtime.AUTH_IDENTITY_DATABASE_URL, 'wc_identity'], [runtime.AUTH_TENANT_DATABASE_URL, 'wc_tenant']] as const) {
        const scoped = pool(databaseUrl(url, role));
        try {
          const actual = await scoped.query<{ role: string }>('SELECT current_user AS role'); check(actual.rows[0]?.role === role);
          const denied = async (sql: string, values: unknown[] = []) => {
            try { await scoped.query(sql, values); } catch (error) {
              check((error as { code?: string }).code === '42501', 'SQL_EXPECT_PERMISSION_DENIED'); return;
            }
            throw new Error('SQL_PRIVILEGE_LEAK');
          };
          await denied('SELECT * FROM app_private.app_user'); await denied('SELECT * FROM app_private.company');
          await denied('SET ROLE wc_data_owner');
          if (role === 'wc_identity') await denied('SELECT app_api.tenant_company($1::uuid,$2::uuid,$3::uuid)', [f.sellerId, sid(manager), f.companyA]);
          else await denied('SELECT app_api.identity_credential($1::text)', [f.sellerEmail]);
          const noContext = role === 'wc_identity'
            ? await scoped.query<{ result: { code: string } }>('SELECT app_api.identity_credential($1::text) AS result', [f.sellerEmail])
            : await scoped.query<{ result: { code: string } }>('SELECT app_api.tenant_company($1::uuid,$2::uuid,$3::uuid) AS result', [f.sellerId, sid(manager), f.companyA]);
          check(noContext.rows[0]?.result.code === 'UNAUTHENTICATED', 'SQL_CONTEXT_NOT_DENIED');
        } finally { await scoped.end(); }
      }
    });
    await test('POOL_RESIDUAL_CONTEXT_REJECTED', async () => {
      await identity.credential(f.sellerEmail); // verifies a clean connection works first
      const before = await prisma.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      await prisma.$queryRaw`SELECT set_config('wc.operation','residual-auth-real',false), set_config('wc.tx_marker','1',false)`;
      try {
        try { await identity.credential(f.sellerEmail); throw new Error('POOL_CONTEXT_ACCEPTED'); }
        catch (error) { check(error instanceof AuthError && error.status === 503, 'POOL_CONTEXT_NOT_REJECTED'); }
        const after = await prisma.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        check(before[0]?.pid === after[0]?.pid, 'POOL_CONNECTION_CHANGED');
      } finally { await prisma.$queryRaw`SELECT set_config('wc.operation','',false), set_config('wc.tx_marker','',false)`; }
      check((await identity.credential(f.sellerEmail))?.userId === f.sellerId);
    });
    const redis = new Redis(runtime.REDIS_URL!, { lazyConnect: true, connectTimeout: 3000, commandTimeout: 3000,
      retryStrategy: () => null, maxRetriesPerRequest: 0, enableOfflineQueue: false });
    redis.on('error', () => {}); close.push(async () => { redis.disconnect(); }); await redis.connect();
    const limits = new RedisRateLimits({ eval: (script, key, args) => redis.eval(script, 1, key, ...args) }, randomBytes(32));
    await test('REAL_REDIS_QUOTAS', async () => {
      for (const [scope, count] of [['login-failure', 5], ['login-ip', 30], ['refresh-session', 30], ['refresh-ip', 60], ['logout-ip', 60]] as const) {
        const key = randomUUID(); for (let index = 0; index < count; index++) await limits.consume(scope, key);
        try { await limits.consume(scope, key); throw new Error('QUOTA_NOT_ENFORCED'); }
        catch (error) { check(error instanceof RateLimitError && error.retryAfter > 0, 'QUOTA_ERROR_MISMATCH'); }
        if (scope === 'login-failure') {
          try { await limits.checkLoginFailures(key); throw new Error('QUOTA_NOT_ENFORCED'); }
          catch (error) { check(error instanceof RateLimitError, 'QUOTA_ERROR_MISMATCH'); }
        }
      }
    });
    await test('REAL_REDIS_FAILURE_LOGOUT_STILL_REVOKES', async () => {
      // A real Redis connection on the approved endpoint, deliberately closed locally.
      // No service stop, fake evaluator or altered shared configuration.
      const unavailableRedis = new Redis(runtime.REDIS_URL!, { lazyConnect: true, enableOfflineQueue: false,
        retryStrategy: () => null, maxRetriesPerRequest: 0, commandTimeout: 1000 });
      unavailableRedis.on('error', () => {}); unavailableRedis.disconnect();
      const failedLimits = new RedisRateLimits({ eval: (script, key, args) => unavailableRedis.eval(script, 1, key, ...args) }, randomBytes(32));
      const service = new AuthService(identity, failedLimits, new AccessTokens(Buffer.from(runtime.AUTH_JWT_KEY!, 'base64url')), f.hash);
      const expect503 = async (work: () => Promise<unknown>) => {
        try { await work(); throw new Error('REDIS_FAILURE_ACCEPTED'); }
        catch (error) { check(error instanceof AuthError && error.status === 503, 'REDIS_FAILURE_NOT_503'); }
      };
      const original = await login();
      await expect503(() => service.login(f.sellerEmail, f.password, '127.0.0.1'));
      await expect503(() => service.refresh(original.refreshToken, '127.0.0.1'));
      await expect503(() => service.logout(original.refreshToken, '127.0.0.1'));
      check(await revoked(admin, sid(original))); status(await get('auth/me', original.accessToken), 401, 'SESSION_REVOKED');
    });
    await test('HTTP_RATE_LIMIT_RETRY_AFTER', async () => {
      const email = `auth-quota-${randomUUID()}@example.test`;
      for (let index = 0; index < 5; index++) {
        status(await post('auth/login', { email, password: f.password }), 401, 'INVALID_CREDENTIALS');
      }
      const blocked = await post('auth/login', { email, password: f.password });
      status(blocked, 429, 'RATE_LIMITED');
      check(/^\d+$/.test(String(blocked.headers['retry-after'])) && Number(blocked.headers['retry-after']) > 0, 'RETRY_AFTER_MISSING');
    });
    process.stdout.write(`PASS ${passed} fixture=${fixtureId}\n`);
  } catch (error) {
    process.stderr.write(`FAIL case=${current} code=${sanitized(error)} PASS=${passed} fixture=${fixtureId}\n`);
    process.exitCode = 1;
  } finally {
    try { await app?.close(); } catch { process.exitCode = 1; }
    for (const cleanup of close.reverse()) {
      try { await cleanup(); } catch { process.exitCode = 1; }
    }
    clearTimeout(deadline);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
