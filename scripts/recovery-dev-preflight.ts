/** Read-only shared DEV checks for recovery. Does not execute SQL007. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from 'pg';
import { adminUser, checkReceipt, gate, project, sqlBundle, sqlFiles, verifyAdmin } from './auth-local-core.js';
import { localDockerEnvironment, validateContainer } from './auth-local.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
export const profileFiles = ['.env.auth-admin', '.env.auth-dev', '.env.recovery-dev', '.env.gmail-api-dev', '.env.companies-dev'] as const;
const functions = ['invitation_prepare', '_invitation_clean', 'invitation_emit', 'invitation_accept',
  'invitation_pending', 'invitation_claim', 'invitation_can_send', 'invitation_finish', 'invitation_emitted'];
const absentSql = `SELECT NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('wc_invitation_owner','wc_invitation_delivery_owner'))
 AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app_api' AND p.proname IN (${functions.map(name => `'${name}'`).join(',')}))
 AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polname LIKE 'invitation%')
 AND to_regclass('wc_ops.invitations_receipt') IS NULL AS safe`;
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export function validateSource(source: string): void {
  gate(resolve(source) !== resolve(root) && !lstatSync(source).isSymbolicLink());
  gate(git(source, ['rev-parse', '--show-toplevel']).replaceAll('\\', '/').toLowerCase() === resolve(source).replaceAll('\\', '/').toLowerCase());
  gate(/^https:\/\/github\.com\/bryanAlex29\/WhatsCommerceEC_Backend(?:\.git)?$/.test(git(source, ['remote', 'get-url', 'origin'])));
  gate(!git(source, ['ls-files', '--', ...profileFiles]));
  for (const file of profileFiles) {
    gate(git(source, ['check-ignore', '--', file]) === file);
    if (existsSync(resolve(source, file))) gate(lstatSync(resolve(source, file)).isFile() && !lstatSync(resolve(source, file)).isSymbolicLink());
  }
  for (const file of [...sqlFiles, '005_password_recovery.sql', '006_companies.sql']) {
    gate(readFileSync(resolve(root, 'prisma/sql', file)).equals(readFileSync(resolve(source, 'prisma/sql', file))));
  }
}
function docker(args: string[]): string {
  return execFileSync('docker', args, { cwd: root, env: localDockerEnvironment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
}
export async function preflight(client: Client): Promise<void> {
  const context = JSON.parse(docker(['context', 'inspect'])) as Array<{ Endpoints?: { docker?: { Host?: string } } }>;
  gate(context.length === 1 && /^(npipe:\/\/\/|unix:\/\/\/)/.test(context[0]?.Endpoints?.docker?.Host ?? ''));
  for (const service of ['postgres', 'redis'] as const) {
    const inspected = JSON.parse(docker(['inspect', `${project}-${service}-1`])) as Parameters<typeof validateContainer>[0][];
    gate(inspected.length === 1); validateContainer(inspected[0]!, service);
  }
  await verifyAdmin(client);
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    gate(await checkReceipt(client, sqlBundle(root).checksum));
    for (const [table, file] of [['recovery_receipt', '005_password_recovery.sql'], ['companies_receipt', '006_companies.sql']]) {
      const receipt = await client.query<{ checksum: string; owner: string }>(`SELECT checksum,pg_get_userbyid(c.relowner) owner FROM wc_ops.${table} r JOIN pg_class c ON c.oid='wc_ops.${table}'::regclass`);
      gate(receipt.rowCount === 1 && receipt.rows[0]!.checksum === sha(readFileSync(resolve(root, 'prisma/sql', file!))) && receipt.rows[0]!.owner === adminUser);
    }
    const roles = await client.query(`SELECT rolname,rolcanlogin,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolinherit,rolreplication,
      EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) member FROM pg_roles r WHERE rolname IN ('wc_identity','wc_tenant','wc_platform','wc_delivery')`);
    gate(roles.rowCount === 4 && roles.rows.every(r => !r.rolsuper && !r.rolbypassrls && !r.rolcreaterole && !r.rolcreatedb && !r.rolinherit && !r.rolreplication && !r.member && r.rolcanlogin));
    gate((await client.query(absentSql)).rows[0].safe);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
}
