/** Operación aprobada DEV solamente. Nunca imprime SQL, credenciales ni contenido de respaldo. */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { Client } from 'pg';
import { parse } from 'dotenv';
import { checkReceipt, database, adminUser, gate, loadProfiles, project, sqlBundle, unwrapSql, validateDatabaseUrl, verifyAdmin } from './auth-local-core.js';
import { localDockerEnvironment, validateContainer } from './auth-local.js';
import { validateEnvironment } from '../src/config/environment.js';
import { recoveryConfig } from './recovery-config.js';

export const root = fileURLToPath(new URL('../', import.meta.url));
const checksum = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const sqlPath = resolve(root, 'prisma/sql/006_companies.sql');
const profilePath = resolve(root, '.env.companies-dev');
const stagedPath = resolve(root, '.env.companies-staged');
const source = `${project}-postgres-1`;
const backupAad = Buffer.from('whatscommerceec:companies-dev-backup:v1');
let step = 'preflight';
function docker(args: string[], input?: string | Buffer): Buffer {
  return execFileSync('docker', args, { input, cwd: root, env: localDockerEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
}
function powershell(command: string, input = ''): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; ${command}`],
    { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 }).trim();
}
export function platformProfile(text: string): Record<string, string> {
  const profile = parse(text);
  gate(Object.keys(profile).sort().join() === ['COMPANIES_ENABLED', 'COMPANIES_PLATFORM_DATABASE_URL'].sort().join());
  gate(profile.COMPANIES_ENABLED === 'true');
  validateDatabaseUrl(profile.COMPANIES_PLATFORM_DATABASE_URL, 'wc_platform');
  return profile;
}
function readProfile(): Record<string, string> {
  gate(lstatSync(profilePath).isFile() && !lstatSync(profilePath).isSymbolicLink());
  return platformProfile(readFileSync(profilePath, 'utf8'));
}
export function privateDirectory(): string {
  gate(process.platform === 'win32' && process.env.LOCALAPPDATA);
  // Persistent user-local storage, outside Git and outside automatic Temp cleanup.
  const base = resolve(process.env.LOCALAPPDATA, 'WhatsCommerceEC/backups');
  mkdirSync(base, { recursive: true });
  const folder = resolve(base, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  mkdirSync(folder);
  const sid = powershell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
  gate(/^S-1-[0-9-]+$/.test(sid));
  execFileSync('icacls.exe', [folder, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  return folder;
}
export interface Fingerprint { table: string; count: string; digest: string }
function fingerprintSql(schema: string, table: string): string {
  gate(/^[a-z_]+$/.test(schema) && /^[a-z_]+$/.test(table));
  return `SELECT count(*)::text AS count,encode(sha256(convert_to(coalesce(string_agg(row_to_json(t)::text,E'\\n' ORDER BY row_to_json(t)::text COLLATE "C"),''),'UTF8')),'hex') AS digest FROM "${schema}"."${table}" t`;
}
async function fingerprints(client: Client, schema = 'app_private'): Promise<Fingerprint[]> {
  const tables = await client.query<{ tablename: string }>('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [schema]);
  const result: Fingerprint[] = [];
  for (const { tablename } of tables.rows) {
    const row = (await client.query<{ count: string; digest: string }>(fingerprintSql(schema, tablename))).rows[0]!;
    result.push({ table: `${schema}.${tablename}`, ...row });
  }
  return result;
}
function same(a: Fingerprint[], b: Fingerprint[]): void { gate(JSON.stringify(a) === JSON.stringify(b)); }
export function sealBackup(payload: Buffer, key: Buffer) {
  gate(key.length === 32);
  const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(backupAad);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  return { version: 1, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
export function openBackup(envelope: ReturnType<typeof sealBackup>, key: Buffer): Buffer {
  gate(envelope.version === 1 && key.length === 32);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64')); decipher.setAAD(backupAad);
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
}
interface BackupPayload {
  version: number; database: string; dump: string; roles: string; dumpSha256: string; fingerprints: Fingerprint[];
  profiles: Record<string, string>;
}
async function backupAndRestore(client: Client): Promise<{ folder: string; data: Fingerprint[] }> {
  step = 'backup_snapshot';
  const folder = privateDirectory();
  let payload: BackupPayload;
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const snapshot = (await client.query<{ snapshot: string }>('SELECT pg_export_snapshot() AS snapshot')).rows[0]!.snapshot;
    gate(/^[0-9A-F-]+$/.test(snapshot));
    const data = [...await fingerprints(client), ...await fingerprints(client, 'wc_ops')];
    const dump = docker(['exec', source, 'pg_dump', '-U', adminUser, '-d', database, '-Fc', '--snapshot', snapshot]);
    const roles = docker(['exec', source, 'pg_dumpall', '-U', adminUser, '--roles-only']);
    const profiles: Record<string, string> = {};
    for (const file of ['.env.auth-admin', '.env.auth-dev', '.env.recovery-dev', '.env.gmail-api-dev']) if (existsSync(resolve(root, file))) {
      gate(lstatSync(resolve(root, file)).isFile() && !lstatSync(resolve(root, file)).isSymbolicLink());
      profiles[file] = readFileSync(resolve(root, file)).toString('base64');
    }
    payload = { version: 1, database, dump: dump.toString('base64'), roles: roles.toString('base64'), dumpSha256: checksum(dump), fingerprints: data, profiles };
    const key = randomBytes(32);
    const protectedKey = powershell("Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String([Console]::In.ReadToEnd()),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))", key.toString('base64'));
    writeFileSync(resolve(folder, 'key.dpapi'), protectedKey, { flag: 'wx', mode: 0o600 });
    writeFileSync(resolve(folder, 'backup.aes-gcm.json'), JSON.stringify(sealBackup(Buffer.from(JSON.stringify(payload)), key)), { flag: 'wx', mode: 0o600 });
    key.fill(0);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  step = 'backup_decrypt_verify';
  const unlocked = Buffer.from(powershell("Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String([Console]::In.ReadToEnd()),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))", readFileSync(resolve(folder, 'key.dpapi'), 'utf8')), 'base64');
  const restored = JSON.parse(openBackup(JSON.parse(readFileSync(resolve(folder, 'backup.aes-gcm.json'), 'utf8')) as ReturnType<typeof sealBackup>, unlocked).toString()) as BackupPayload;
  unlocked.fill(0); gate(restored.version === 1 && restored.database === database && checksum(Buffer.from(restored.dump, 'base64')) === restored.dumpSha256);
  const clone = `wc-companies-restore-${randomUUID().slice(0, 8)}`;
  let started = false;
  const psql = (sql: string) => docker(['exec', '-i', clone, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'wc_restore_check', '-d', database], sql).toString('utf8').trim();
  try {
    step = 'backup_restore_clone';
    docker(['run', '--rm', '-d', '--network', 'none', '--name', clone, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
      '-e', 'POSTGRES_USER=wc_restore_check', '-e', `POSTGRES_DB=${database}`, 'postgres:17-alpine']); started = true;
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { ready = psql('SELECT 1') === '1'; if (ready) break; } catch { /* Isolated clone only. */ }
      await setTimeout(250);
    }
    gate(ready); psql(Buffer.from(restored.roles, 'base64').toString('utf8'));
    docker(['exec', '-i', clone, 'pg_restore', '--exit-on-error', '-U', 'wc_restore_check', '-d', database], Buffer.from(restored.dump, 'base64'));
    const data: Fingerprint[] = [];
    for (const expected of restored.fingerprints) {
      const [schema, table] = expected.table.split('.'); gate(schema && table);
      const row = JSON.parse(psql(`SELECT row_to_json(f) FROM (${fingerprintSql(schema, table)}) f`)) as { count: string; digest: string };
      data.push({ table: expected.table, ...row });
    }
    same(restored.fingerprints, data);
    writeFileSync(resolve(folder, 'verified.json'), JSON.stringify({ version: 1, verifiedAt: new Date().toISOString(), dumpSha256: restored.dumpSha256,
      restoreChecked: true, tablesVerified: data.length, encryption: 'AES-256-GCM + Windows DPAPI CurrentUser', sql006: checksum(readFileSync(sqlPath)) }), { flag: 'wx', mode: 0o600 });
    console.log(`COMPANIES_BACKUP_RESTORE_OK tables=${data.length} encryptedFolder=${folder}`);
    return { folder, data: restored.fingerprints.filter(row => row.table.startsWith('app_private.')) };
  } finally { if (started) docker(['stop', clone]); }
}
async function checkTarget(client: Client): Promise<void> {
  const context = JSON.parse(docker(['context', 'inspect']).toString()) as Array<{ Endpoints?: { docker?: { Host?: string } } }>;
  gate(context.length === 1 && /^(npipe:\/\/\/|unix:\/\/\/)/.test(context[0]?.Endpoints?.docker?.Host ?? ''));
  const inspected = JSON.parse(docker(['inspect', source]).toString()) as Parameters<typeof validateContainer>[0][];
  gate(inspected.length === 1); validateContainer(inspected[0]!, 'postgres');
  await verifyAdmin(client);
  gate(await checkReceipt(client, sqlBundle(root).checksum));
  const receipt = await client.query<{ checksum: string }>('SELECT checksum FROM wc_ops.recovery_receipt');
  gate(receipt.rowCount === 1 && receipt.rows[0]!.checksum === checksum(readFileSync(resolve(root, 'prisma/sql/005_password_recovery.sql'))));
  const platform = await client.query(`SELECT rolcanlogin,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolinherit,rolreplication,
    EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS member FROM pg_roles r WHERE rolname='wc_platform'`);
  gate(platform.rowCount === 1 && !platform.rows[0].rolsuper && !platform.rows[0].rolbypassrls && !platform.rows[0].rolcreaterole &&
    !platform.rows[0].rolcreatedb && !platform.rows[0].rolinherit && !platform.rows[0].rolreplication && !platform.rows[0].member);
}
async function verifyRuntime(profile: Record<string, string>): Promise<void> {
  const runtime = new Client({ connectionString: profile.COMPANIES_PLATFORM_DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    step = 'verify_runtime_connect';
    await runtime.connect();
    step = 'verify_runtime_identity';
    const role = await runtime.query("SELECT current_user='wc_platform' AND session_user='wc_platform' AS safe"); gate(role.rows[0].safe);
    step = 'verify_runtime_context';
    const denied = await runtime.query(`SELECT app_api.platform_companies($1,$2,NULL,NULL) AS result`, [randomUUID(), randomUUID()]);
    gate(denied.rows[0].result.code === 'UNAUTHENTICATED');
    step = 'verify_runtime_privileges';
    // Resolve relation OIDs via catalogs. Runtime intentionally has no USAGE on
    // app_private, so a textual regclass lookup there would itself be forbidden.
    const priv = await runtime.query(`SELECT c.relname,has_table_privilege(current_user,c.oid,'SELECT') AS direct
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='app_private' AND c.relname IN ('company','app_user')`);
    gate(priv.rowCount === 2 && priv.rows.every((row: { direct: boolean }) => !row.direct));
  } finally { await runtime.end().catch(() => undefined); }
}
export async function companiesLocal(mode: 'preflight' | 'apply' | 'verify'): Promise<void> {
  const tracked = execFileSync('git', ['ls-files', '--', '.env.auth-admin', '.env.auth-dev', '.env.recovery-dev', '.env.companies-dev', '.env.companies-staged'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); gate(!tracked.trim());
  const ignored = execFileSync('git', ['check-ignore', '--', '.env.companies-dev', '.env.companies-staged'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); gate(ignored.trim().split(/\r?\n/).length === 2);
  const profiles = loadProfiles(root); const { config: recovery } = recoveryConfig(root);
  const client = new Client({ connectionString: profiles.admin.AUTH_DEV_ADMIN_URL, connectionTimeoutMillis: 5000 });
  try {
    await client.connect(); await checkTarget(client);
    if (mode === 'preflight') {
      const existing = await client.query("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='wc_platform_owner') AS applied");
      console.log(`COMPANIES_PREFLIGHT_OK localDEV=true receipts000_005=true companiesOwnerExists=${existing.rows[0].applied} overlayExists=${existsSync(profilePath)}`); return;
    }
    if (mode === 'verify') {
      const profile = readProfile(); const config = validateEnvironment({ ...recovery, CORS_ORIGINS: recovery.CORS_ORIGINS.join(','), ...profile });
      const receipt = await client.query<{ checksum: string }>('SELECT checksum FROM wc_ops.companies_receipt');
      gate(receipt.rowCount === 1 && receipt.rows[0]!.checksum === checksum(readFileSync(sqlPath)));
      await verifyRuntime(profile);
      const { ConfigService } = await import('@nestjs/config');
      const { CompaniesRuntime } = await import('../src/modules/companies/runtime.js');
      const runtime = new CompaniesRuntime(new ConfigService(config));
      try {
        const port = await runtime.ready(); const invalid = { userId: randomUUID(), sessionId: randomUUID() };
        const deny = async (work: Promise<unknown>) => {
          let denied = false;
          try { await work; } catch (error) { denied = !!error && typeof error === 'object' && 'code' in error && error.code === 'UNAUTHENTICATED'; }
          gate(denied);
        };
        await deny(port.list(invalid)); await deny(port.branches(invalid, randomUUID(), false));
      } finally { await runtime.onModuleDestroy(); }
      console.log('COMPANIES_DEV_VERIFY_OK roles,receipt,config,no-context-denial,Prisma-platform-tenant'); return;
    }
    gate(!existsSync(profilePath) && !existsSync(stagedPath));
    await client.query('SELECT pg_advisory_lock(174013,1)');
    const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname='wc_platform_owner' UNION ALL SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='wc_ops' AND c.relname='companies_receipt'");
    gate(existing.rowCount === 0);
    const noLogin = await client.query("SELECT NOT rolcanlogin AS safe FROM pg_roles WHERE rolname='wc_platform'"); gate(noLogin.rows[0].safe);
    const backup = await backupAndRestore(client);
    const password = randomBytes(32).toString('base64url');
    const platformUrl = new URL(profiles.runtime.AUTH_TENANT_DATABASE_URL!); platformUrl.username = 'wc_platform'; platformUrl.password = password;
    const text = `COMPANIES_ENABLED=true\nCOMPANIES_PLATFORM_DATABASE_URL=${platformUrl.href}\n`;
    const profile = platformProfile(text); validateEnvironment({ ...recovery, CORS_ORIGINS: recovery.CORS_ORIGINS.join(','), ...profile });
    step = 'stage_private_overlay'; writeFileSync(stagedPath, '', { flag: 'wx', mode: 0o600 });
    // Do not widen ACLs; assign only current Windows user and SYSTEM before storing runtime secrets.
    const sid = powershell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'); gate(/^S-1-[0-9-]+$/.test(sid));
    execFileSync('icacls.exe', [stagedPath, '/inheritance:r', '/grant:r', `*${sid}:F`, '*S-1-5-18:F'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    writeFileSync(stagedPath, text, { flag: 'r+' });
    step = 'apply_sql006'; await client.query('BEGIN');
    try {
      await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'");
      gate(await checkReceipt(client, sqlBundle(root).checksum));
      const sql = readFileSync(sqlPath, 'utf8'); await client.query(unwrapSql(sql)); await client.query('RESET ROLE');
      const formatted = await client.query<{ sql: string }>("SELECT format('ALTER ROLE wc_platform LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT PASSWORD %L',$1::text) AS sql", [password]);
      await client.query(formatted.rows[0]!.sql);
      await client.query('CREATE TABLE wc_ops.companies_receipt(checksum text NOT NULL); REVOKE ALL ON wc_ops.companies_receipt FROM PUBLIC');
      await client.query('INSERT INTO wc_ops.companies_receipt(checksum) VALUES($1)', [checksum(sql)]);
      same(backup.data, await fingerprints(client));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    step = 'activate_overlay'; gate(!existsSync(profilePath)); renameSync(stagedPath, profilePath);
    await verifyRuntime(profile); same(backup.data, await fingerprints(client));
    console.log('COMPANIES_DEV_APPLY_OK onlySQL006=true appDataUnchanged=true overlayEnabled=true');
  } finally { await client.end().catch(() => undefined); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const flag = process.argv[2];
  const mode = flag === '--preflight' ? 'preflight' : flag === '--apply-approved-dev' ? 'apply' : flag === '--verify' ? 'verify' : undefined;
  if (!mode || process.argv.length !== 3) { console.error('Uso: companies-local.ts --preflight | --apply-approved-dev | --verify'); process.exitCode = 1; }
  else await companiesLocal(mode).catch(() => { console.error(`COMPANIES_LOCAL_FAILED step=${step}; sin detalles privados. Revisar antes de reintentar; no se descartan artefactos parciales.`); process.exitCode = 1; });
}
