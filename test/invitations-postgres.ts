/** PostgreSQL nuevo, sin perfiles ni volúmenes del DEV. Diagnóstico sin payloads. */
import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { Redis } from 'ioredis';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaCompaniesPort } from '../src/modules/companies/persistence.js';
import { PrismaInvitationPort, PrismaInvitationDeliveryPort } from '../src/modules/invitations/persistence.js';
import { InvitationCrypto, InvitationService, deliverInvitation } from '../src/modules/invitations/invitations.js';
import { RedisInvitationLimits } from '../src/modules/invitations/limits.js';
import { RedisRateLimits } from '../src/modules/auth/rate-limit.js';
import { mailpitInvitationMailer } from '../src/modules/invitations/mailpit.js';
import { startInvitationWorker } from '../src/modules/invitations/worker.js';
import type { Principal } from '../src/modules/auth/crypto.js';

const name = `wc-invitations-test-${randomUUID().slice(0, 8)}`;
const password = randomBytes(32).toString('base64url');
const runtimePassword = randomBytes(32).toString('base64url');
const pools: Pool[] = []; const clients: PrismaClient[] = [];
const auxiliary: string[] = []; let redis: Redis | undefined;
let worker: Awaited<ReturnType<typeof startInvitationWorker>> | undefined;
let started = false; let step = 'start'; let count = 0;
const check = (v: unknown, label: string) => { step = label; assert.ok(v, label); count++; };
async function rejected(work: Promise<unknown>, code: string) {
  step = code; await assert.rejects(work, (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === code); count++;
}
try {
  execFileSync('docker', ['run', '--rm', '-d', '--name', name, '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD', 'postgres:17-alpine'],
    { env: { ...process.env, POSTGRES_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }); started = true;
  const binding = execFileSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const match = /^127\.0\.0\.1:(\d+)$/.exec(binding); assert.ok(match);
  const options = { host: '127.0.0.1', port: Number(match[1]), database: 'postgres', password, connectionTimeoutMillis: 2000 };
  const admin = new Pool({ ...options, user: 'postgres', max: 4 }); pools.push(admin);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await admin.query('SELECT 1'); ready = true; break; } catch { await setTimeout(250); }
  }
  assert.ok(ready);
  for (const file of ['000_roles.sql', '001_schema.sql', '002_constraints.sql', '003_rls.sql', '004_auth_context.sql', '005_password_recovery.sql', '006_companies.sql', '007_initial_invitations.sql']) {
    step = `apply_${file}`; await admin.query(readFileSync(new URL(`../prisma/sql/${file}`, import.meta.url), 'utf8'));
  }
  function runtime(user: 'wc_platform' | 'wc_tenant' | 'wc_identity' | 'wc_delivery') {
    const pool = new Pool({ ...options, password: runtimePassword, user, max: 4 }); pools.push(pool);
    const prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: 'app_private', onConnectionError: () => {}, onPoolError: () => {} }), log: [], errorFormat: 'minimal' });
    clients.push(prisma); return prisma;
  }
  for (const role of ['wc_platform', 'wc_tenant', 'wc_identity', 'wc_delivery']) await admin.query(`ALTER ROLE ${role} LOGIN PASSWORD '${runtimePassword}'`);
  const platform = runtime('wc_platform'); const identityClient = runtime('wc_identity');
  const companies = new PrismaCompaniesPort(platform, runtime('wc_tenant'), randomBytes(32));
  const port = new PrismaInvitationPort(platform, identityClient);
  const deliveryClient = runtime('wc_delivery'); const delivery = new PrismaInvitationDeliveryPort(deliveryClient);
  const crypto = new InvitationCrypto(randomBytes(32));
  async function identity(email: string, platformAdmin = false): Promise<Principal> {
    const userId = randomUUID(); const sessionId = randomUUID();
    step = 'identity_fixture'; const connection = await admin.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('INSERT INTO app_private.app_user(id,email_normalized,password_hash) VALUES($1,$2,$3)', [userId, email, '$argon2id$v=19$synthetic-test-only']);
      if (platformAdmin) await connection.query('INSERT INTO app_private.platform_admin(user_id) VALUES($1)', [userId]);
      await connection.query("INSERT INTO app_private.app_session(id,user_id,absolute_expires_at) VALUES($1,$2,clock_timestamp()+interval '1 day')", [sessionId, userId]);
      await connection.query('INSERT INTO app_private.refresh_token_history(id,session_id,generation,token_hash,issued_at) VALUES($1,$2,1,$3,clock_timestamp())', [randomUUID(), sessionId, randomBytes(32)]);
      await connection.query('COMMIT');
    } catch (error) { await connection.query('ROLLBACK'); throw error; } finally { connection.release(); }
    return { userId, sessionId };
  }
  let ruc = 7000000000000;
  const pa = await identity('platform@example.test', true); const recipient = await identity('existing@example.test');
  const company = () => companies.create(pa, { tradeName: 'Synthetic', legalName: 'Synthetic', ruc: String(++ruc), taxAddress: 'Synthetic', contactEmail: 'contact@example.test', contactPhone: '+593999999999' });
  async function emit(cid: string, email?: string) {
    step = 'prepare'; const plan = await port.prepare(pa, cid, email); const token = crypto.token(); const op = randomUUID();
    step = 'emit'; const receipt = await port.emit(pa, cid, op, plan, crypto.hash(token), crypto.seal(plan, token), email === undefined);
    return { plan, token, op, receipt };
  }
  const a = await company();
  await rejected(port.prepare(recipient, a.id, 'new@example.test'), 'FORBIDDEN');
  await rejected(port.prepare(recipient, randomUUID(), 'new@example.test'), 'FORBIDDEN');
  await rejected(port.prepare(pa, a.id), 'STATE_CONFLICT');
  const first = await emit(a.id, 'new@example.test');
  check((await companies.company(pa, a.id, 'read')).status === 'PENDING_ACTIVATION', 'emision_no_activa');
  check((await delivery.pending()).some(v => v.id === first.op), 'outbox_duradero');
  await rejected(port.prepare(pa, a.id, 'other@example.test'), 'STATE_CONFLICT');
  await rejected(emit(a.id), 'RATE_LIMITED');
  step = 'accept_new'; const accepted = await port.accept(crypto.hash(first.token), undefined, '$argon2id$v=19$synthetic-test-only');
  check(accepted.companyId === a.id && accepted.role === 'COMPANY_ADMIN', 'aceptacion_nueva');
  check((await companies.company(pa, a.id, 'read')).status === 'ACTIVE', 'activacion_atomica');
  check((await admin.query('SELECT encrypted_payload FROM app_private.invitation_outbox WHERE id=$1', [first.op])).rows[0].encrypted_payload === null, 'aceptacion_limpia_payload');
  await rejected(port.accept(crypto.hash(first.token), undefined, '$argon2id$v=19$synthetic'), 'INVITATION_NOT_FOUND');
  await rejected(port.prepare(pa, a.id), 'STATE_CONFLICT');
  const b = await company(); const existing = await emit(b.id, 'existing@example.test');
  await rejected(port.accept(crypto.hash(existing.token), undefined, '$argon2id$v=19$synthetic'), 'INVITATION_REQUIRES_LOGIN');
  await rejected(port.accept(crypto.hash(existing.token), pa), 'INVITATION_NOT_FOUND');
  step = 'existing'; check((await port.accept(crypto.hash(existing.token), recipient)).userId === recipient.userId, 'cuenta_existente_vinculada');
  const c = await company(); const before = await emit(c.id, 'resend@example.test');
  await admin.query("UPDATE app_private.invitation_emission SET issued_at=clock_timestamp()-interval '61 seconds' WHERE company_id=$1", [c.id]);
  const after = await emit(c.id);
  check(after.plan.email === before.plan.email && after.plan.generation === 2, 'reenvio_conserva_destinatario');
  await rejected(port.accept(crypto.hash(before.token), undefined, '$argon2id$v=19$synthetic'), 'INVITATION_NOT_FOUND');
  check(await delivery.claim(before.op, 1, randomUUID()) === null, 'generacion_anterior_no_entregable');
  const lease = randomUUID(); step = 'claim'; const claimed = await delivery.claim(after.op, 2, lease);
  check(claimed && crypto.open(claimed).token === after.token, 'claim_descifra_aad');
  check(await delivery.claim(after.op, 2, randomUUID()) === null, 'lease_evita_doble_claim');
  check(await delivery.canSend(after.op, 2, lease), 'revalidacion_preenvio');
  await delivery.finish(after.op, 2, randomUUID(), true);
  check(await delivery.canSend(after.op, 2, lease), 'lease_ajeno_no_confirma');
  await delivery.finish(after.op, 2, lease, true);
  check((await admin.query('SELECT state,encrypted_payload FROM app_private.invitation_outbox WHERE id=$1', [after.op])).rows[0].state === 'SMTP_ACCEPTED', 'confirmacion_condicional');
  const d = await company(); const race = await emit(d.id, 'race@example.test');
  step = 'concurrent_accept'; const results = await Promise.allSettled([1, 2].map(() => port.accept(crypto.hash(race.token), undefined, '$argon2id$v=19$synthetic')));
  check(results.filter(v => v.status === 'fulfilled').length === 1, 'aceptacion_concurrente_un_efecto');
  check((await admin.query('SELECT count(*)::int n FROM app_private.membership WHERE company_id=$1', [d.id])).rows[0].n === 1, 'una_pertenencia');
  const e = await company(); const rollback = await emit(e.id, 'rollback@example.test');
  await admin.query(`CREATE FUNCTION app_private.test_fail_membership() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$;
    CREATE TRIGGER test_fail BEFORE INSERT ON app_private.membership FOR EACH ROW EXECUTE FUNCTION app_private.test_fail_membership()`);
  await rejected(port.accept(crypto.hash(rollback.token), undefined, '$argon2id$v=19$synthetic'), 'SERVICE_TEMPORARILY_UNAVAILABLE');
  check((await admin.query('SELECT count(*)::int n FROM app_private.app_user WHERE email_normalized=$1', ['rollback@example.test'])).rows[0].n === 0, 'rollback_identidad');
  check((await companies.company(pa, e.id, 'read')).status === 'PENDING_ACTIVATION', 'rollback_empresa');
  check((await admin.query('SELECT accepted_at FROM app_private.invitation WHERE company_id=$1', [e.id])).rows[0].accepted_at === null, 'rollback_consumo');
  await admin.query('DROP TRIGGER test_fail ON app_private.membership; DROP FUNCTION app_private.test_fail_membership()');
  await companies.company(pa, e.id, 'suspend');
  await rejected(port.accept(crypto.hash(rollback.token), undefined, '$argon2id$v=19$synthetic'), 'COMPANY_SUSPENDED');
  await companies.company(pa, e.id, 'reactivate');
  await admin.query("UPDATE app_private.invitation SET issued_at=statement_timestamp()-interval '49 hours',expires_at=statement_timestamp()-interval '1 hour' WHERE company_id=$1", [e.id]);
  await rejected(port.accept(crypto.hash(rollback.token), undefined, '$argon2id$v=19$synthetic'), 'INVITATION_NOT_FOUND');
  const f = await company(); const failure = await emit(f.id, 'delivery@example.test');
  step = 'failed_delivery'; await assert.rejects(deliverInvitation(failure.op, 1, delivery, crypto, { send: async () => false })); count++;
  const state = (await admin.query('SELECT state,attempts,encrypted_payload FROM app_private.invitation_outbox WHERE id=$1', [failure.op])).rows[0];
  check(state.state === 'RETRY_PENDING' && state.attempts === 1 && state.encrypted_payload !== null, 'fallo_conserva_payload_y_reintento');
  check(await delivery.emitted(failure.op), 'reconciliacion_commit_positivo');
  // Outbox insert failure rolls back the emission and invitation as one unit.
  const broken = await company(); const brokenPlan = await port.prepare(pa, broken.id, 'outbox-rollback@example.test');
  const brokenToken = crypto.token(); const brokenOp = randomUUID();
  await admin.query(`CREATE FUNCTION app_private.test_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$;
    CREATE TRIGGER test_fail BEFORE INSERT ON app_private.invitation_outbox FOR EACH ROW EXECUTE FUNCTION app_private.test_fail_outbox()`);
  await rejected(port.emit(pa, broken.id, brokenOp, brokenPlan, crypto.hash(brokenToken), crypto.seal(brokenPlan, brokenToken), false), 'SERVICE_TEMPORARILY_UNAVAILABLE');
  check((await admin.query('SELECT count(*)::int n FROM app_private.invitation WHERE company_id=$1', [broken.id])).rows[0].n === 0, 'rollback_emision_invitacion');
  check(!await delivery.emitted(brokenOp), 'rollback_emision_ledger');
  check((await companies.company(pa, broken.id, 'read')).status === 'PENDING_ACTIVATION', 'fallo_outbox_no_borra_empresa');
  await admin.query('DROP TRIGGER test_fail ON app_private.invitation_outbox; DROP FUNCTION app_private.test_fail_outbox()');
  // Competing plans cannot overwrite the winner, regardless of Redis availability.
  const competing = await company();
  const plans = await Promise.all([1, 2].map(() => port.prepare(pa, competing.id, 'competing@example.test')));
  const emissions = await Promise.allSettled(plans.map(plan => {
    const token = crypto.token(); return port.emit(pa, competing.id, randomUUID(), plan, crypto.hash(token), crypto.seal(plan, token), false);
  }));
  check(emissions.filter(v => v.status === 'fulfilled').length === 1, 'emision_concurrente_un_efecto');
  await admin.query("UPDATE app_private.invitation_emission SET issued_at=clock_timestamp()-interval '61 seconds' WHERE company_id=$1", [competing.id]);
  const resends = await Promise.all([1, 2].map(() => port.prepare(pa, competing.id, undefined)));
  const resending = await Promise.allSettled(resends.map(plan => {
    const token = crypto.token(); return port.emit(pa, competing.id, randomUUID(), plan, crypto.hash(token), crypto.seal(plan, token), true);
  }));
  check(resending.filter(v => v.status === 'fulfilled').length === 1, 'reenvio_concurrente_un_efecto');
  // An expiry reached after inserting the new user must roll back the subtransaction.
  const deadlineCompany = await company(); const deadline = await emit(deadlineCompany.id, 'deadline@example.test');
  await admin.query(`CREATE FUNCTION app_private.test_delay_membership() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.5); RETURN NEW; END $$;
    CREATE TRIGGER test_delay BEFORE INSERT ON app_private.membership FOR EACH ROW EXECUTE FUNCTION app_private.test_delay_membership()`);
  await admin.query("UPDATE app_private.invitation SET issued_at=statement_timestamp()-interval '48 hours'+interval '300 milliseconds',expires_at=statement_timestamp()+interval '300 milliseconds' WHERE company_id=$1", [deadlineCompany.id]);
  await rejected(port.accept(crypto.hash(deadline.token), undefined, '$argon2id$v=19$synthetic'), 'INVITATION_NOT_FOUND');
  check((await admin.query('SELECT count(*)::int n FROM app_private.app_user WHERE email_normalized=$1', ['deadline@example.test'])).rows[0].n === 0, 'plazo_durante_aceptacion_rollback_usuario');
  check((await companies.company(pa, deadlineCompany.id, 'read')).status === 'PENDING_ACTIVATION', 'plazo_durante_aceptacion_no_activa');
  await admin.query('DROP TRIGGER test_delay ON app_private.membership; DROP FUNCTION app_private.test_delay_membership()');
  // Exhaust durable attempts without waiting real backoff periods in this synthetic DB.
  for (let attempt = 2; attempt <= 8; attempt++) {
    step = `durable_retry_${attempt}`;
    // Use its creation instant: already due and never violates available_at >=
    // created_at on fast hosts where this row is still younger than one second.
    await admin.query('UPDATE app_private.invitation_outbox SET available_at=created_at WHERE id=$1', [failure.op]);
    await assert.rejects(deliverInvitation(failure.op, 1, delivery, crypto, { send: async () => false }));
  }
  const exhausted = (await admin.query('SELECT state,attempts,encrypted_payload FROM app_private.invitation_outbox WHERE id=$1', [failure.op])).rows[0];
  check(exhausted.state === 'FAILED' && exhausted.attempts === 8 && exhausted.encrypted_payload !== null, 'ocho_intentos_duraderos_sin_borrado_incierto');
  check(await delivery.claim(failure.op, 1, randomUUID()) === null, 'no_noveno_intento');
  step = 'deny_direct'; await assert.rejects(deliveryClient.$queryRaw`SELECT * FROM app_private.invitation`); count++;
  // Additional disposable services. Mailpit digest pinned after official v1.33.1 review.
  function container(suffix: string, image: string, ports: number[]) {
    const containerName = `${name}-${suffix}`;
    execFileSync('docker', ['run', '--rm', '-d', '--name', containerName, ...ports.flatMap(p => ['-p', `127.0.0.1::${p}`]), image],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }); auxiliary.push(containerName);
    return ports.map(p => {
      const binding = execFileSync('docker', ['port', containerName, `${p}/tcp`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      const result = /^127\.0\.0\.1:(\d+)$/.exec(binding); assert.ok(result); return Number(result[1]);
    });
  }
  step = 'isolated_redis_mailpit';
  const [redisPort] = container('redis', 'redis:7-alpine', [6379]);
  const [smtpPort, uiPort] = container('mailpit', 'axllent/mailpit@sha256:aef2aacc11f075ec0fb6874275ee4a421e688e11a96ebb296134d1735c7761ce', [1025, 8025]);
  const redisUrl = `redis://127.0.0.1:${redisPort}`;
  redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 3000 });
  redis.on('error', () => {}); await redis.connect();
  const activeRedis = redis;
  const evaluator = { eval: (script: string, keys: string[], args: string[]) => activeRedis.eval(script, keys.length, ...keys, ...args) };
  const rateKey = randomBytes(32); const limits = new RedisInvitationLimits(evaluator, rateKey);
  const quotaCompany = randomUUID(); const quotaAdmin = randomUUID(); const op = randomUUID();
  step = 'redis_reservations'; await limits.reserve(op, quotaCompany, quotaAdmin);
  await rejected(limits.reserve(randomUUID(), quotaCompany, quotaAdmin), 'RATE_LIMITED');
  await limits.release(op); const confirmed = randomUUID(); await limits.reserve(confirmed, quotaCompany, quotaAdmin); await limits.confirm(confirmed);
  await limits.release(confirmed);
  await rejected(limits.reserve(randomUUID(), quotaCompany, quotaAdmin), 'RATE_LIMITED');
  check(!(await limits.pending()).includes(confirmed), 'confirmacion_no_reembolsa');
  const parallelCompany = randomUUID();
  const reservations = await Promise.allSettled([1, 2, 3].map(() => limits.reserve(randomUUID(), parallelCompany, quotaAdmin)));
  check(reservations.filter(v => v.status === 'fulfilled').length === 1, 'redis_carrera_reserva_unica');
  const ipLimits = new RedisRateLimits({ eval: (script, key, args) => evaluator.eval(script, [key], args) }, rateKey);
  for (let i = 0; i < 10; i++) await ipLimits.consume('invitation-accept-ip', 'synthetic-ip');
  await rejected(ipLimits.consume('invitation-accept-ip', 'synthetic-ip'), 'RATE_LIMITED');
  const service = new InvitationService(port, limits, ipLimits, crypto);
  const g = await company(); step = 'service_outbox'; const mailed = await service.emit(pa, g.id, 'capture@example.test');
  check(mailed.invitationId.length === 36 && !('token' in mailed), 'servicio_no_devuelve_token');
  // Isolate the one live message to assert delivery deterministically.
  await admin.query("UPDATE app_private.invitation_outbox SET state='FAILED' WHERE invitation_id<>$1 AND state IN ('PENDING','RETRY_PENDING','PROCESSING')", [mailed.invitationId]);
  let mailReady = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${uiPort}/readyz`, { signal: AbortSignal.timeout(2000) })).ok) { mailReady = true; break; } } catch { /* startup */ }
    await setTimeout(100);
  }
  check(mailReady, 'mailpit_ready'); step = 'worker_capture';
  worker = await startInvitationWorker(redisUrl, delivery, crypto, mailpitInvitationMailer(smtpPort!), limits);
  let captured = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    const row = (await admin.query('SELECT state FROM app_private.invitation_outbox WHERE invitation_id=$1', [mailed.invitationId])).rows[0];
    if (row.state === 'SMTP_ACCEPTED') { captured = true; break; } await setTimeout(100);
  }
  check(captured, 'bullmq_mailpit_confirmado');
  const messages = await (await fetch(`http://127.0.0.1:${uiPort}/api/v1/messages`)).json() as { messages: Array<{ ID: string }> };
  check(messages.messages.length === 1, 'mailpit_una_captura');
  const message = await (await fetch(`http://127.0.0.1:${uiPort}/api/v1/message/${messages.messages[0]!.ID}`)).json() as { Text: string; To: Array<{ Address: string }> };
  const code = /Código manual de invitación: ([A-Za-z0-9_-]{43})/.exec(message.Text)?.[1];
  check(!!code && message.To[0]?.Address === 'capture@example.test', 'codigo_manual_destinatario_correcto');
  check(!/https?:\/\//.test(message.Text), 'sin_token_url');
  await worker.reconcile(); await setTimeout(100);
  check((await service.accept(code!, 'fresh-ip', undefined, 'SyntheticPassword!')).companyId === g.id, 'captura_a_aceptacion_real');
  await worker.close(); worker = undefined;
  // Compiled Nest metadata, JWT, real roles/PG/Redis; no simulated persistence.
  step = 'http_setup';
  const { Test } = await import('@nestjs/testing');
  const compiled = <T>(file: string): Promise<T> => import(new URL(`../dist/${file}`, import.meta.url).href) as Promise<T>;
  const { InvitationsModule } = await compiled<typeof import('../src/modules/invitations/invitations.module.js')>('modules/invitations/invitations.module.js');
  const { InvitationsRuntime } = await compiled<typeof import('../src/modules/invitations/runtime.js')>('modules/invitations/runtime.js');
  const { AuthRuntime } = await compiled<typeof import('../src/modules/auth/runtime.js')>('modules/auth/runtime.js');
  const { authJsonMiddleware } = await compiled<typeof import('../src/modules/auth/strict-json.js')>('modules/auth/strict-json.js');
  const { AccessTokens } = await compiled<typeof import('../src/modules/auth/crypto.js')>('modules/auth/crypto.js');
  const { AuthService } = await compiled<typeof import('../src/modules/auth/auth.service.js')>('modules/auth/auth.service.js');
  const { PrismaIdentityPort } = await compiled<typeof import('../src/modules/auth/persistence/adapters.js')>('modules/auth/persistence/adapters.js');
  const { CompanyCursor } = await compiled<typeof import('../src/modules/auth/cursor.js')>('modules/auth/cursor.js');
  const { InvitationService: HttpService, InvitationCrypto: HttpCrypto } = await compiled<typeof import('../src/modules/invitations/invitations.js')>('modules/invitations/invitations.js');
  const { PrismaInvitationPort: HttpPort } = await compiled<typeof import('../src/modules/invitations/persistence.js')>('modules/invitations/persistence.js');
  const { RedisInvitationLimits: HttpLimits } = await compiled<typeof import('../src/modules/invitations/limits.js')>('modules/invitations/limits.js');
  const { RedisRateLimits: HttpIpLimits } = await compiled<typeof import('../src/modules/auth/rate-limit.js')>('modules/auth/rate-limit.js');
  const httpCrypto = new HttpCrypto(randomBytes(32));
  const httpService = new HttpService(new HttpPort(platform, identityClient), new HttpLimits(evaluator, rateKey),
    new HttpIpLimits({ eval: (script, key, args) => evaluator.eval(script, [key], args) }, rateKey), httpCrypto);
  const jwt = new AccessTokens(randomBytes(32));
  const identityPort = new PrismaIdentityPort(identityClient, new CompanyCursor(randomBytes(32)));
  const unused = async () => { throw new Error('LOGIN_NOT_PART_OF_TEST'); };
  const authService = new AuthService(identityPort, { consume: unused, checkLoginFailures: unused }, jwt, '$argon2id$v=19$synthetic');
  const module = await Test.createTestingModule({ imports: [InvitationsModule] })
    .overrideProvider(AuthRuntime).useValue({ ready: async () => ({ service: authService }) })
    .overrideProvider(InvitationsRuntime).useValue({ ready: async () => httpService }).compile();
  const app = module.createNestApplication();
  try {
    app.setGlobalPrefix('api'); app.use(authJsonMiddleware(true)); await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
    async function http(route: string, principal?: Principal, body?: unknown, raw?: string, contentType = 'application/json') {
      const headers: Record<string, string> = {};
      if (principal) headers.Authorization = `Bearer ${await jwt.issue(principal)}`;
      if (body !== undefined || raw !== undefined) headers['Content-Type'] = contentType;
      const response = await fetch(`${base}/api${route}`, { method: 'POST', headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), signal: AbortSignal.timeout(15000) });
      const data: unknown = await response.json(); return { response, data: data as Record<string, unknown> };
    }
    const h = await company(); const route = `/platform/companies/${h.id}/initial-invitation`;
    step = 'http_auth'; check((await http(route, undefined, { email: 'http@example.test' })).response.status === 401, 'http_sin_login401');
    check((await http(route, recipient, { email: 'http@example.test' })).response.status === 403, 'http_empresa_no_plataforma403');
    check((await http(route, pa, { email: 'bad' })).response.status === 400, 'http_email_invalido400');
    check((await http(route, pa, { email: 'http@example.test', role: 'COMPANY_ADMIN' })).response.status === 400, 'http_protegido400');
    check((await http(route, pa, undefined, '{"email":"a@example.test","email":"b@example.test"}')).response.status === 400, 'http_duplicado400');
    check((await http(route, pa, undefined, 'hello', 'text/plain')).response.status === 415, 'http_media415');
    check((await http(`${route}?cursor=unexpected`, pa, { email: 'http@example.test' })).response.status === 400, 'http_query400');
    check((await http(route, pa, { email: 'x'.repeat(17000) })).response.status === 413, 'http_payload413');
    const queued = await http(route, pa, { email: 'http@example.test' });
    check(queued.response.status === 202 && Object.keys(queued.data).sort().join(',') === 'expiresAt,invitationId', 'http_emision202_sin_token');
    check(queued.response.headers.get('cache-control') === 'no-store', 'http_no_store');
    check((await http(`${route}/resend`, pa, {})).response.status === 400, 'http_reenvio_body400');
    const limited = await http(`${route}/resend`, pa);
    check(limited.response.status === 429 && Number(limited.response.headers.get('retry-after')) >= 1, 'http_retry_after429');
    // Move synthetic quota timestamps, never wall-clock/DEV data, to exercise resend success.
    await admin.query("UPDATE app_private.invitation_emission SET issued_at=clock_timestamp()-interval '61 seconds' WHERE company_id=$1", [h.id]);
    const zkeys = await activeRedis.keys('wc:inv:*');
    for (const key of zkeys) if (await activeRedis.type(key) === 'zset') {
      const members = await activeRedis.zrange(key, 0, -1);
      for (const member of members) await activeRedis.zadd(key, Date.now() - 61000, member);
    }
    check((await http(`${route}/resend`, pa)).response.status === 202, 'http_reenvio202');
    const row = (await admin.query(`SELECT i.id,i.generation,i.expires_at,o.encrypted_payload,o.nonce,o.auth_tag FROM app_private.invitation i
      JOIN app_private.invitation_outbox o ON o.invitation_id=i.id AND o.generation=i.generation WHERE i.company_id=$1`, [h.id])).rows[0];
    const token = httpCrypto.open({ invitationId: row.id, generation: row.generation, expiresAt: row.expires_at.toISOString(), keyId: 'v1',
      payload: row.encrypted_payload.toString('hex'), nonce: row.nonce.toString('hex'), tag: row.auth_tag.toString('hex') }).token;
    check((await http('/auth/invitations/accept-new', undefined, { invitationToken: token, password: 'short!' })).response.status === 400, 'http_password400');
    check((await http('/auth/invitations/accept-new', undefined, { invitationToken: token, password: 'SyntheticPassword!', companyId: h.id })).response.status === 400, 'http_no_promocion_cliente');
    const newAccount = await http('/auth/invitations/accept-new', undefined, { invitationToken: token, password: 'SyntheticPassword!' });
    check(newAccount.response.status === 201 && newAccount.data.companyStatus === 'ACTIVE' && !('accessToken' in newAccount.data), 'http_nueva201_sin_sesion');
    check((await http('/auth/invitations/accept-new', undefined, { invitationToken: token, password: 'SyntheticPassword!' })).response.status === 404, 'http_repetida404');
    const j = await company(); const existingHttp = await emit(j.id, 'existing@example.test');
    check((await http('/auth/invitations/accept', pa, { invitationToken: existingHttp.token })).response.status === 404, 'http_destinatario_ajeno404');
    const linked = await http('/auth/invitations/accept', recipient, { invitationToken: existingHttp.token });
    check(linked.response.status === 200 && linked.data.userId === recipient.userId && linked.data.companyId === j.id, 'http_existente200');
  } finally { await app.close(); }
  step = 'postgres_hour_quotas';
  const hourlyActor = await identity('quota-company@example.test', true);
  const hourlyCompany = await company();
  for (let n = 0; n < 5; n++) {
    const plan = await port.prepare(hourlyActor, hourlyCompany.id, n === 0 ? 'quota@example.test' : undefined); const token = crypto.token();
    await port.emit(hourlyActor, hourlyCompany.id, randomUUID(), plan, crypto.hash(token), crypto.seal(plan, token), n > 0);
    await admin.query("UPDATE app_private.invitation_emission SET issued_at=clock_timestamp()-interval '61 seconds' WHERE company_id=$1", [hourlyCompany.id]);
  }
  const sixth = await port.prepare(hourlyActor, hourlyCompany.id, undefined); const sixthToken = crypto.token();
  await rejected(port.emit(hourlyActor, hourlyCompany.id, randomUUID(), sixth, crypto.hash(sixthToken), crypto.seal(sixth, sixthToken), true), 'RATE_LIMITED');
  const globalActor = await identity('quota-global@example.test', true);
  for (let n = 0; n < 20; n++) {
    const cid = (await company()).id; const plan = await port.prepare(globalActor, cid, 'global-quota@example.test'); const token = crypto.token();
    await port.emit(globalActor, cid, randomUUID(), plan, crypto.hash(token), crypto.seal(plan, token), false);
  }
  const overflowCompany = await company(); const overflow = await port.prepare(globalActor, overflowCompany.id, 'global-quota@example.test'); const overflowToken = crypto.token();
  await rejected(port.emit(globalActor, overflowCompany.id, randomUUID(), overflow, crypto.hash(overflowToken), crypto.seal(overflow, overflowToken), false), 'RATE_LIMITED');
  check((await admin.query('SELECT count(*)::int n FROM app_private.invitation WHERE company_id=$1', [overflowCompany.id])).rows[0].n === 0, 'cuota_pg_rechazo_sin_invitacion');
  const redisAdmin = randomUUID();
  for (let n = 0; n < 20; n++) await limits.reserve(randomUUID(), randomUUID(), redisAdmin);
  await rejected(limits.reserve(randomUUID(), randomUUID(), redisAdmin), 'RATE_LIMITED');
  console.log(`INVITATIONS_POSTGRES_OK checks=${count}`);
} catch (error) {
  // SQL diagnostics only for setup; never Prisma messages (may embed parameters).
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown';
  console.error(`INVITATIONS_POSTGRES_FAILED step=${step} code=${code}`);
  if (step.startsWith('apply_') && error instanceof Error) console.error(error.message);
  process.exitCode = 1;
} finally {
  await worker?.close(); redis?.disconnect();
  await Promise.allSettled(clients.map(c => c.$disconnect())); await Promise.allSettled(pools.map(p => p.end()));
  for (const container of auxiliary.reverse()) execFileSync('docker', ['stop', container], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
  if (started) execFileSync('docker', ['stop', name], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
}
