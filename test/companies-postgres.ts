/** Integración Prisma/PostgreSQL17 real en contenedor NUEVO, puerto loopback efímero, sin perfiles ni volúmenes DEV. */
import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaCompaniesPort } from '../src/modules/companies/persistence.js';
import { PrismaTenantPort } from '../src/modules/auth/persistence/adapters.js';
import type { Principal } from '../src/modules/auth/crypto.js';
import type { CompanyInput, CompanyPatch } from '../src/modules/companies/ports.js';

const name = `wc-companies-test-${randomUUID().slice(0, 8)}`;
const password = randomBytes(32).toString('base64url');
const runtimePassword = randomBytes(32).toString('base64url');
const input: CompanyInput = { tradeName: 'Synthetic', legalName: 'Synthetic Legal', ruc: '1234567890123',
  taxAddress: 'Synthetic Address', contactEmail: 'synthetic@example.test', contactPhone: '+593999999999' };
const pools: Pool[] = []; const clients: PrismaClient[] = [];
let started = false; let step = 'start'; let count = 0;
const check = (condition: unknown, label: string) => { step = label; assert.ok(condition, label); count++; };
async function rejected(work: Promise<unknown>, code: string, label: string) {
  step = label; await assert.rejects(work, (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === code); count++;
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
  for (const file of ['000_roles.sql', '001_schema.sql', '002_constraints.sql', '003_rls.sql', '004_auth_context.sql', '005_password_recovery.sql', '006_companies.sql']) {
    step = `apply_${file}`; await admin.query(readFileSync(new URL(`../prisma/sql/${file}`, import.meta.url), 'utf8'));
  }
  for (const role of ['wc_platform', 'wc_tenant', 'wc_identity']) {
    // Ephemeral random password only, never a developer profile/real credential.
    await admin.query(`ALTER ROLE ${role} LOGIN PASSWORD '${runtimePassword}'`);
  }
  function runtime(user: 'wc_platform' | 'wc_tenant' | 'wc_identity') {
    const pool = new Pool({ ...options, password: runtimePassword, user, max: 4 }); pools.push(pool);
    const prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: 'app_private', onConnectionError: () => {}, onPoolError: () => {} }), log: [], errorFormat: 'minimal' });
    clients.push(prisma); return prisma;
  }
  const platform = runtime('wc_platform'); const tenant = runtime('wc_tenant');
  const port = new PrismaCompaniesPort(platform, tenant, randomBytes(32)); const own = new PrismaTenantPort(tenant);
  async function identity(index: number, platformAdmin = false): Promise<Principal> {
    const userId = randomUUID(); const sessionId = randomUUID();
    const connection = await admin.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('INSERT INTO app_private.app_user(id,email_normalized,password_hash) VALUES($1,$2,$3)', [userId, `synthetic-${index}@example.test`, '$argon2id$v=19$synthetic-test-only']);
      if (platformAdmin) await connection.query('INSERT INTO app_private.platform_admin(user_id) VALUES($1)', [userId]);
      await connection.query("INSERT INTO app_private.app_session(id,user_id,absolute_expires_at) VALUES($1,$2,clock_timestamp()+interval '1 day')", [sessionId, userId]);
      await connection.query('INSERT INTO app_private.refresh_token_history(id,session_id,generation,token_hash,issued_at) VALUES($1,$2,1,$3,clock_timestamp())', [randomUUID(), sessionId, randomBytes(32)]);
      await connection.query('COMMIT');
    } catch (error) { await connection.query('ROLLBACK'); throw error; } finally { connection.release(); }
    return { userId, sessionId };
  }
  const pa = await identity(1, true); const ca = await identity(2); const seller = await identity(3); const outsider = await identity(4);
  step = 'create_pending_company'; const a = await port.create(pa, input);
  check(a.status === 'PENDING_ACTIVATION' && a.ruc === input.ruc, 'alta_pendiente');
  check((await admin.query('SELECT count(*)::int n FROM app_private.branch')).rows[0].n === 0, 'sin_sucursal_automatica');
  const b = await port.create(pa, { ...input, ruc: '1234567890124' });
  await rejected(port.company(ca, a.id, 'read'), 'FORBIDDEN', 'no_plataforma_denegado');
  await rejected(port.company(ca, randomUUID(), 'read'), 'FORBIDDEN', 'sin_revelar_existencia_plataforma');
  for (const action of ['patch', 'suspend', 'reactivate'] as const) {
    await rejected(port.company(ca, a.id, action, action === 'patch' ? { tradeName: 'Unauthorized' } : undefined), 'FORBIDDEN', `no_plataforma_${action}_denegado`);
  }
  await rejected(port.create(seller, { ...input, ruc: '1234567890125' }), 'FORBIDDEN', 'vendedor_no_crea');
  await rejected(port.company(pa, randomUUID(), 'read'), 'RESOURCE_NOT_FOUND', 'recurso_ausente');
  step = 'concurrent_unique_ruc'; const duplicates = await Promise.allSettled([
    port.create(pa, { ...input, ruc: '1234567890126' }), port.create(pa, { ...input, ruc: '1234567890126' }),
  ]);
  check(duplicates.filter(r => r.status === 'fulfilled').length === 1, 'ruc_concurrente_un_solo_alta');
  check(duplicates.some(r => r.status === 'rejected' && r.reason.code === 'RUC_ALREADY_EXISTS'), 'ruc_concurrente_conflicto409');
  const changed = await port.company(pa, a.id, 'patch', { tradeName: 'Changed', contactEmail: 'changed@example.test' });
  check(changed.ruc === a.ruc && changed.legalName === a.legalName && changed.tradeName === 'Changed', 'patch_parcial_preserva_ruc_y_omitidos');
  await rejected(port.company(pa, a.id, 'patch', { ruc: '9999999999999' } as CompanyPatch), 'SERVICE_TEMPORARILY_UNAVAILABLE', 'sql_rechaza_patch_ruc_aun_sin_controlador');
  check((await port.company(pa, a.id, 'read')).ruc === a.ruc, 'ruc_inmutable_persistido');
  check((await admin.query('SELECT count(*)::int n FROM app_private.app_user WHERE email_normalized=$1', ['changed@example.test'])).rows[0].n === 0, 'contacto_no_cambia_identidad');
  const branch = await port.branch(pa, a.id, undefined, { name: 'Branch A', address: 'Synthetic Address' });
  check(branch.companyId === a.id && branch.email === null && branch.phone === null, 'sucursal_opcionales');
  const branch2 = await port.branch(pa, b.id, undefined, { name: 'Branch A', address: 'Synthetic Address' });
  check(branch2.name === branch.name, 'sucursal_nombre_sin_unicidad_global');
  await rejected(port.branch(ca, a.id, undefined, { name: 'Unauthorized', address: 'Synthetic' }), 'FORBIDDEN', 'admin_empresarial_no_crea_sucursal');
  await rejected(port.branch(seller, a.id, branch.id, { name: 'Unauthorized' }), 'FORBIDDEN', 'vendedor_no_modifica_sucursal');
  await port.branch(pa, a.id, branch.id, { email: 'branch@example.test', phone: '+593999999999' });
  const cleared = await port.branch(pa, a.id, branch.id, { email: null });
  check(cleared.email === null && cleared.phone === '+593999999999', 'patch_contacto_null_preserva_omitido');
  await rejected(port.branch(pa, b.id, branch.id, { name: 'Cross' }), 'RESOURCE_NOT_FOUND', 'sucursal_ajena404');
  check((await port.branches(pa, a.id, true)).items[0]?.name === 'Branch A', 'rechazo_sin_mutacion');
  for (const [principal, cid, role] of [[ca, a.id, 'COMPANY_ADMIN'], [ca, b.id, 'COMPANY_ADMIN'], [seller, a.id, 'SELLER']] as const) {
    await admin.query('INSERT INTO app_private.membership(id,user_id,company_id,role) VALUES($1,$2,$3,$4)', [randomUUID(), principal.userId, cid, role]);
  }
  await rejected(port.branches(ca, a.id, false), 'COMPANY_PENDING_ACTIVATION', 'pendiente_bloquea_consulta_operativa');
  await admin.query("UPDATE app_private.company SET status='ACTIVE',activated_at=clock_timestamp() WHERE id=ANY($1::uuid[])", [[a.id, b.id]]);
  check((await port.branches(ca, a.id, false)).items[0]?.id === branch.id, 'admin_empresarial_consulta_sucursales_propias');
  await rejected(port.branches(seller, a.id, false), 'FORBIDDEN', 'vendedor_no_consulta_sucursales');
  await rejected(port.branches(outsider, a.id, false), 'RESOURCE_NOT_FOUND', 'empresa_ajena404');
  await rejected(port.branches(outsider, randomUUID(), false), 'RESOURCE_NOT_FOUND', 'inexistente_misma404');
  await rejected(port.branches(pa, a.id, false), 'RESOURCE_NOT_FOUND', 'plataforma_sin_acceso_comercial_implicito');
  step = 'suspend_active'; const suspended = await port.company(pa, a.id, 'suspend');
  check(suspended.status === 'SUSPENDED', 'suspender_activa');
  check((await port.company(pa, a.id, 'suspend')).updatedAt === suspended.updatedAt, 'suspension_idempotente');
  await rejected(own.company(ca, a.id), 'COMPANY_SUSPENDED', 'sesion_abierta_bloqueada');
  await rejected(port.branches(ca, a.id, false), 'COMPANY_SUSPENDED', 'sucursales_suspendida_bloqueadas');
  check((await own.company(ca, b.id)).status === 'ACTIVE', 'otra_empresa_conserva_acceso');
  check((await port.branches(pa, a.id, true)).items.length === 1, 'plataforma_administra_suspendida_sin_borrar');
  check((await port.company(pa, a.id, 'reactivate')).status === 'ACTIVE', 'reactiva_activada');
  const pending = await port.create(pa, { ...input, ruc: '1234567890127' });
  await port.company(pa, pending.id, 'suspend');
  check((await port.company(pa, pending.id, 'reactivate')).status === 'PENDING_ACTIVATION', 'reactiva_pendiente_sin_activacion_indebida');
  const unchanged = await port.company(pa, pending.id, 'read');
  check((await port.company(pa, pending.id, 'reactivate')).updatedAt === unchanged.updatedAt, 'reactivacion_idempotente');
  step = 'pagination_fixtures';
  // Deterministic equal timestamps exercise UUID tie-break, >20 items, EXISTS continuation.
  await admin.query(`INSERT INTO app_private.company(id,trade_name,legal_name,ruc,tax_address,contact_email,contact_phone,created_at,updated_at)
    SELECT gen_random_uuid(),'Synthetic','Synthetic',lpad((8000000000000+g)::text,13,'0'),'Synthetic','fixture@example.test','+593999999999',
      '2026-01-01T00:00:00Z'::timestamptz,'2026-01-01T00:00:00Z'::timestamptz FROM generate_series(1,45) g`);
  await admin.query(`INSERT INTO app_private.branch(id,company_id,name,address,created_at,updated_at)
    SELECT gen_random_uuid(),$1,'Synthetic','Synthetic','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z' FROM generate_series(1,45)`, [a.id]);
  const first = await port.list(pa); check(first.items.length === 20 && !!first.nextCursor, 'plataforma_paginacion20');
  const second = await port.list(pa, first.nextCursor!); check(second.items.length === 20 && !!second.nextCursor, 'segunda_pagina20');
  check(!second.items.some(c => first.items.some(f => f.id === c.id)), 'paginacion_sin_repetidos');
  const third = await port.list(pa, second.nextCursor!); check(third.items.length < 20 && third.nextCursor === null, 'pagina_final');
  const branches = await port.branches(ca, a.id, false); check(branches.items.length === 20 && !!branches.nextCursor, 'sucursales_paginacion20');
  await rejected(port.branches(ca, b.id, false, branches.nextCursor!), 'INVALID_CURSOR', 'cursor_no_cruza_empresa');
  await rejected(port.branches(pa, a.id, true, branches.nextCursor!), 'INVALID_CURSOR', 'cursor_no_cruza_ambito');
  await rejected(port.list(outsider, first.nextCursor!), 'INVALID_CURSOR', 'cursor_no_cruza_identidad');
  await admin.query('DELETE FROM app_private.platform_admin WHERE user_id=$1', [pa.userId]);
  await rejected(port.list(pa, first.nextCursor!), 'FORBIDDEN', 'cursor_reautoriza_privilegio_vigente');
  await admin.query('INSERT INTO app_private.platform_admin(user_id) VALUES($1)', [pa.userId]);
  // Compiled Nest decorators/metadata, real HTTP/JWT + Prisma + PostgreSQL.
  // Runtime injection provides the real ports; login quotas are fail-closed/not exercised here.
  step = 'http_integrated';
  const { Test } = await import('@nestjs/testing');
  const compiled = <T>(file: string): Promise<T> => import(new URL(`../dist/${file}`, import.meta.url).href) as Promise<T>;
  const { CompaniesModule } = await compiled<typeof import('../src/modules/companies/companies.module.js')>('modules/companies/companies.module.js');
  const { CompaniesRuntime } = await compiled<typeof import('../src/modules/companies/runtime.js')>('modules/companies/runtime.js');
  const { AuthRuntime } = await compiled<typeof import('../src/modules/auth/runtime.js')>('modules/auth/runtime.js');
  const { authJsonMiddleware } = await compiled<typeof import('../src/modules/auth/strict-json.js')>('modules/auth/strict-json.js');
  const { AccessTokens } = await compiled<typeof import('../src/modules/auth/crypto.js')>('modules/auth/crypto.js');
  const { AuthService } = await compiled<typeof import('../src/modules/auth/auth.service.js')>('modules/auth/auth.service.js');
  const { PrismaIdentityPort } = await compiled<typeof import('../src/modules/auth/persistence/adapters.js')>('modules/auth/persistence/adapters.js');
  const { CompanyCursor } = await compiled<typeof import('../src/modules/auth/cursor.js')>('modules/auth/cursor.js');
  const { PrismaCompaniesPort: HttpCompaniesPort } = await compiled<typeof import('../src/modules/companies/persistence.js')>('modules/companies/persistence.js');
  const jwt = new AccessTokens(randomBytes(32));
  const identityPort = new PrismaIdentityPort(runtime('wc_identity'), new CompanyCursor(randomBytes(32)));
  const failLimits = async () => { throw new Error('LOGIN_NOT_PART_OF_THIS_TEST'); };
  const service = new AuthService(identityPort, { consume: failLimits, checkLoginFailures: failLimits }, jwt, '$argon2id$v=19$synthetic-only');
  const httpPort = new HttpCompaniesPort(platform, tenant, randomBytes(32));
  const module = await Test.createTestingModule({ imports: [CompaniesModule] })
    .overrideProvider(AuthRuntime).useValue({ ready: async () => ({ service }) })
    .overrideProvider(CompaniesRuntime).useValue({ ready: async () => httpPort }).compile();
  const app = module.createNestApplication();
  try {
    app.setGlobalPrefix('api'); app.use(authJsonMiddleware(true)); await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const http = async (route: string, principal: Principal | undefined, method = 'GET', body?: unknown) => {
      const headers: Record<string, string> = {};
      if (principal) headers.Authorization = `Bearer ${await jwt.issue(principal)}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      const json = await response.json() as { items?: unknown[]; error?: { code: string }; tradeName?: string; companyId?: string };
      return { response, json };
    };
    const listed = await http('/platform/companies', pa);
    check(listed.response.status === 200 && listed.json.items?.length === 20, 'http_jwt_prisma_listado_real20');
    check(listed.response.headers.get('cache-control') === 'no-store', 'http_real_privado_no_store');
    check((await http('/platform/companies', ca)).response.status === 403, 'http_real_no_plataforma403');
    check((await http('/platform/companies', undefined)).response.status === 401, 'http_real_sin_jwt401');
    check((await http(`/companies/${a.id}/branches`, ca)).response.status === 200, 'http_real_sucursales_admin200');
    check((await http(`/companies/${a.id}/branches`, seller)).response.status === 403, 'http_real_sucursales_vendedor403');
    const updated = await http(`/platform/companies/${a.id}`, pa, 'PATCH', { tradeName: 'HTTP Synthetic' });
    check(updated.response.status === 200 && updated.json.tradeName === 'HTTP Synthetic', 'http_real_patch_persistido');
    const created = await http(`/platform/companies/${b.id}/branches`, pa, 'POST', { name: 'HTTP Synthetic', address: 'Synthetic' });
    check(created.response.status === 201 && created.json.companyId === b.id, 'http_real_alta_sucursal201');
  } finally { await app.close(); }
  // Effective runtime privileges and missing context, not superuser-only assertions.
  const runtimeConnection = await platform.$queryRaw<Array<{ result: { code: string } }>>`
    SELECT app_api.platform_company(${pa.userId}::uuid,${pa.sessionId}::uuid,${a.id}::uuid,'read','{}'::jsonb) AS result`;
  check(runtimeConnection[0]?.result.code === 'UNAUTHENTICATED', 'sin_contexto_denegado');
  for (const role of ['wc_identity', 'wc_tenant', 'wc_platform', 'wc_delivery']) {
    const priv = await admin.query(`SELECT has_table_privilege($1,'app_private.company','SELECT') AS direct,
      has_table_privilege($1,'app_private.app_user','SELECT') AS credentials,
      has_function_privilege($1,'app_api._platform_authorize(uuid,uuid)','EXECUTE') AS helper`, [role]);
    check(!priv.rows[0].direct && !priv.rows[0].credentials && !priv.rows[0].helper, `runtime_${role}_sin_select_ni_helpers`);
  }
  step = 'runtime_direct_read_denied';
  await assert.rejects(platform.$queryRaw`SELECT id FROM app_private.company`); count++;
  await assert.rejects(tenant.$queryRaw`SELECT id FROM app_private.branch`); count++;
  await assert.rejects(tenant.$queryRaw`SELECT app_api.platform_companies(${pa.userId}::uuid,${pa.sessionId}::uuid,NULL,NULL)`); count++;
  const owner = await admin.query("SELECT rolcanlogin,rolsuper,rolbypassrls FROM pg_roles WHERE rolname='wc_platform_owner'");
  check(!owner.rows[0].rolcanlogin && !owner.rows[0].rolsuper && !owner.rows[0].rolbypassrls, 'owner_sin_login_ni_bypass');
  const rls = await admin.query("SELECT bool_and(relrowsecurity AND relforcerowsecurity) AS safe FROM pg_class WHERE oid IN ('app_private.company'::regclass,'app_private.branch'::regclass)");
  check(rls.rows[0].safe, 'rls_forzado_conservado');
  step = 'pool_pollution';
  const contaminatedPool = new Pool({ ...options, password: runtimePassword, user: 'wc_platform', max: 1 }); pools.push(contaminatedPool);
  const contaminated = new PrismaClient({ adapter: new PrismaPg(contaminatedPool, { schema: 'app_private' }), log: [], errorFormat: 'minimal' }); clients.push(contaminated);
  await contaminated.$queryRaw`SELECT set_config('wc.company_id',${a.id},false)`;
  const polluted = new PrismaCompaniesPort(contaminated, tenant, randomBytes(32));
  await rejected(polluted.list(pa), 'SERVICE_TEMPORARILY_UNAVAILABLE', 'pool_contaminado_falla_cerrado');
  const clean = await port.company(pa, b.id, 'read');
  check(clean.id === b.id, 'pool_limpio_otro_contexto_sin_arrastre');
  // Real locking boundary: authorized operation may finish before suspension, never after commit.
  step = 'concurrent_suspension';
  const lockedResource = await admin.connect();
  try {
    await lockedResource.query('BEGIN');
    await lockedResource.query('SELECT id FROM app_private.company WHERE id=$1 FOR UPDATE', [a.id]);
    await rejected(port.company(outsider, a.id, 'read'), 'FORBIDDEN', 'no_plataforma_rechazado_antes_de_lock_recurso');
  } finally { await lockedResource.query('ROLLBACK'); lockedResource.release(); }
  const holderPool = new Pool({ ...options, password: runtimePassword, user: 'wc_tenant', max: 1 }); pools.push(holderPool);
  const holder = await holderPool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(`SELECT set_config('wc.user_id',$1,true),set_config('wc.session_id',$2,true),set_config('wc.company_id',$3,true),
      set_config('wc.operation','company',true),set_config('wc.tx_marker',txid_current()::text,true)`, [ca.userId, ca.sessionId, a.id]);
    const authorized = await holder.query('SELECT app_api.tenant_company($1,$2,$3) AS result', [ca.userId, ca.sessionId, a.id]);
    check(authorized.rows[0].result.code === 'OK', 'operacion_previa_autorizada');
    let finished = false;
    const suspension = port.company(pa, a.id, 'suspend').then(
      value => { finished = true; return { value, error: undefined }; },
      (error: unknown) => { finished = true; return { value: undefined, error }; });
    await setTimeout(150); check(!finished, 'suspension_espera_lock_operacion');
    await holder.query('COMMIT'); const result = await suspension;
    if (result.error) throw result.error;
  } finally { await holder.query('ROLLBACK'); holder.release(); }
  await rejected(port.branches(ca, a.id, false), 'COMPANY_SUSPENDED', 'despues_commit_no_autoriza');
  await admin.query('UPDATE app_private.app_session SET revoked_at=clock_timestamp() WHERE id=$1', [pa.sessionId]);
  await rejected(port.company(pa, a.id, 'read'), 'SESSION_REVOKED', 'sesion_revocada_comprobada_en_db');
  await admin.query('DELETE FROM app_private.membership WHERE user_id=$1 AND company_id=$2', [ca.userId, b.id]);
  await rejected(port.branches(ca, b.id, false), 'RESOURCE_NOT_FOUND', 'pertenencia_revocada_comprobada_en_db');
  step = 'index_explain';
  // Synthetic cardinality large enough for the planner to compare ordered index scans.
  await admin.query(`INSERT INTO app_private.company(id,trade_name,legal_name,ruc,tax_address,contact_email,contact_phone)
    SELECT gen_random_uuid(),'Synthetic','Synthetic',lpad((9000000000000+g)::text,13,'0'),'Synthetic','fixture@example.test','+593999999999' FROM generate_series(1,2000) g`);
  await admin.query(`INSERT INTO app_private.branch(id,company_id,name,address)
    SELECT gen_random_uuid(),$1,'Synthetic','Synthetic' FROM generate_series(1,4000)`, [b.id]);
  await admin.query('ANALYZE app_private.company; ANALYZE app_private.branch');
  const branchPlan = await admin.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM app_private.branch WHERE company_id=$1 ORDER BY created_at,id LIMIT 20', [a.id]);
  const companyPlan = await admin.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM app_private.company ORDER BY created_at,id LIMIT 20');
  const indexesUsed = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.flatMap(indexesUsed);
    if (!value || typeof value !== 'object') return [];
    const row = value as Record<string, unknown>;
    return [...(typeof row['Index Name'] === 'string' ? [row['Index Name']] : []), ...Object.values(row).flatMap(indexesUsed)];
  };
  const used = [...indexesUsed(branchPlan.rows[0]['QUERY PLAN']), ...indexesUsed(companyPlan.rows[0]['QUERY PLAN'])];
  check(used.includes('branch_company_id_created_at_id_idx'), 'plan_sucursales_usa_indice_empresarial');
  check(used.includes('company_created_at_id_idx'), 'plan_empresas_usa_indice_orden');
  const indices = await admin.query("SELECT indexdef FROM pg_indexes WHERE schemaname='app_private' AND tablename IN ('company','branch')");
  check(indices.rows.some(r => r.indexdef.includes('(created_at, id)')) && indices.rows.some(r => r.indexdef.includes('(company_id, created_at, id)')), 'indices_orden_y_filtro_existentes');
  console.log(`COMPANIES_EXPLAIN_OK ${used.join(',')}; datos sintéticos, sin SLA productivo.`);
  console.log(`COMPANIES_POSTGRES_OK ${count} comprobaciones, Prisma y PostgreSQL17 reales; sin DEV/SMTP/datos existentes.`);
} catch {
  console.error(`COMPANIES_POSTGRES_FAILED step=${step} (sin SQL, credenciales ni datos privados)`); process.exitCode = 1;
} finally {
  await Promise.allSettled(clients.map(c => c.$disconnect()));
  await Promise.allSettled(pools.map(p => p.end()));
  if (started) execFileSync('docker', ['stop', name], { stdio: 'ignore', timeout: 30000 });
}
