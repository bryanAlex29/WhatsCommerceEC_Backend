/** Approved DEV only. Never prints profiles, row data, SQL errors or credentials. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { gate, loadProfiles, unwrapSql } from './auth-local-core.js';
import { backupAndRestore } from './companies-local.js';
import { preflight, profileFiles, validateSource } from './recovery-dev-preflight.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const migration = readFileSync(resolve(root, 'prisma/sql/008_recovery_steps.sql'), 'utf8');
const checksum = createHash('sha256').update(migration).digest('hex');
const absent = `SELECT to_regclass('wc_ops.recovery_steps_receipt') IS NULL
 AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='app_private.password_recovery'::regclass AND attname IN ('verified_at','reset_token_hash') AND NOT attisdropped)
 AND to_regprocedure('app_api.recovery_verify(text,text,text)') IS NULL
 AND to_regprocedure('app_api.recovery_complete(text,text,text)') IS NULL AS safe`;
const structural = `SELECT
 (SELECT count(*)=2 FROM pg_attribute WHERE attrelid='app_private.password_recovery'::regclass AND attname IN ('verified_at','reset_token_hash') AND NOT attisdropped)
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app_private' AND c.relkind='r' AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity))
 AND (SELECT count(*)=2 AND bool_and(p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'] AND pg_get_userbyid(p.proowner)='wc_recovery_owner') FROM pg_proc p WHERE p.oid IN ('app_api.recovery_verify(text,text,text)'::regprocedure,'app_api.recovery_complete(text,text,text)'::regprocedure))
 AND NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid IN ('app_api.recovery_verify(text,text,text)'::regprocedure,'app_api.recovery_complete(text,text,text)'::regprocedure) AND a.grantee=0 AND a.privilege_type='EXECUTE')
 AND has_function_privilege('wc_identity','app_api.recovery_verify(text,text,text)','EXECUTE')
 AND has_function_privilege('wc_identity','app_api.recovery_complete(text,text,text)','EXECUTE')
 AND NOT EXISTS(SELECT 1 FROM pg_roles r CROSS JOIN pg_attribute a CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) permission
 WHERE r.rolname IN ('wc_identity','wc_tenant','wc_platform','wc_delivery') AND a.attrelid='app_private.password_recovery'::regclass AND a.attname IN ('verified_at','reset_token_hash') AND has_column_privilege(r.rolname,a.attrelid,a.attnum,permission)) AS safe`;
interface Table { schema: string; table: string; columns: string[] }
const planSql = `SELECT coalesce(json_agg(t ORDER BY t.schema,t.table),'[]')::text AS plan FROM (
 SELECT n.nspname schema,c.relname "table",array_agg(a.attname ORDER BY a.attnum) columns FROM pg_class c
 JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
 WHERE n.nspname IN ('app_private','wc_ops') AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped GROUP BY n.nspname,c.relname) t`;
export function projectionSql(t: Table): string {
  gate([t.schema,t.table,...t.columns].every(s => /^[a-z_]+$/.test(s)) && t.columns.length > 0);
  return `SELECT count(*)::text||':'||encode(sha256(convert_to(coalesce(string_agg(row_to_json(t)::text,E'\n' ORDER BY row_to_json(t)::text COLLATE "C"),''),'UTF8')),'hex') AS digest FROM (SELECT ${t.columns.map(c=>`"${c}"`).join(',')} FROM "${t.schema}"."${t.table}") t`;
}
const rolesSql = `SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r) ORDER BY rolname)::text,''),'UTF8')),'hex') AS digest FROM pg_authid r WHERE rolname LIKE 'wc_%'`;
export function rehearsal(psql: (sql: string) => string): void {
  gate(psql(absent) === 't');
  const plan = JSON.parse(psql(planSql)) as Table[];
  gate(plan.length > 0);
  const snapshot = () => plan.map(t => psql(projectionSql(t)));
  const before = snapshot(); const roles = psql(rolesSql);
  psql(migration);
  gate(JSON.stringify(before) === JSON.stringify(snapshot()) && roles === psql(rolesSql));
  gate(psql(structural) === 't');
}
export async function operate(source: string, mode: 'preflight' | 'apply' | 'verify'): Promise<void> {
  validateSource(source);
  const profiles = loadProfiles(source);
  const client = new Client({connectionString:profiles.admin.AUTH_DEV_ADMIN_URL,connectionTimeoutMillis:5000});
  try {
    await client.connect(); await preflight(client);
    if (mode === 'verify') {
      const result = await client.query('SELECT checksum FROM wc_ops.recovery_steps_receipt');
      gate(result.rowCount === 1 && result.rows[0].checksum === checksum && (await client.query(structural)).rows[0].safe);
      console.log('RECOVERY_STEPS_DEV_VERIFY_OK receipt=true RLS=true minimalPrivileges=true SQL007absent=true'); return;
    }
    gate((await client.query(absent)).rows[0].safe);
    console.log('RECOVERY_STEPS_PREFLIGHT_OK receipts000_006=true SQL007absent=true SQL008absent=true');
    if (mode === 'preflight') return;
    gate((await client.query('SELECT pg_try_advisory_lock(174013,1) AS safe')).rows[0].safe);
    const backup = await backupAndRestore(client,{profileRoot:source,profileFiles,afterRestore:rehearsal});
    writeFileSync(resolve(backup.folder,'sql008-rehearsal.json'),JSON.stringify({version:1,checksum,restoreVerified:true,cloneNetwork:'none',dataUnchanged:true,at:new Date().toISOString()}),{flag:'wx',mode:0o600});
    await preflight(client);
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
      gate((await client.query(absent)).rows[0].safe);
      const plan = JSON.parse((await client.query(planSql)).rows[0].plan) as Table[];
      // Block concurrent mutations only during the short migration/comparison transaction.
      for (const t of plan) { projectionSql(t); await client.query(`LOCK TABLE "${t.schema}"."${t.table}" IN SHARE ROW EXCLUSIVE MODE`); }
      const snapshot = async () => { const result:string[]=[]; for(const t of plan) result.push((await client.query(projectionSql(t))).rows[0].digest); return result; };
      const before = await snapshot(); const roles = (await client.query(rolesSql)).rows[0].digest;
      await client.query(unwrapSql(migration)); await client.query('RESET ROLE');
      gate(JSON.stringify(before) === JSON.stringify(await snapshot()) && roles === (await client.query(rolesSql)).rows[0].digest);
      gate((await client.query(structural)).rows[0].safe);
      await client.query('CREATE TABLE wc_ops.recovery_steps_receipt(checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp()); REVOKE ALL ON wc_ops.recovery_steps_receipt FROM PUBLIC');
      await client.query('INSERT INTO wc_ops.recovery_steps_receipt(checksum) VALUES($1)',[checksum]);
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK').catch(()=>undefined); throw error; }
    console.log('RECOVERY_STEPS_DEV_APPLY_OK onlySQL008=true priorColumnsUnchanged=true rolesCredentialsUnchanged=true receiptAtomic=true');
  } finally { await client.end().catch(()=>undefined); }
}
if(process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [flag,source,...extra]=process.argv.slice(2);
  const mode=flag==='--preflight'?'preflight':flag==='--apply-approved-dev'?'apply':flag==='--verify'?'verify':undefined;
  if(!source || extra.length || !mode) {console.error('Uso: recovery-steps-local.ts --preflight | --apply-approved-dev | --verify <checkout-principal>');process.exitCode=1;}
  else await operate(resolve(source),mode).catch(()=>{console.error('RECOVERY_STEPS_DEV_FAILED; sin detalles privados. Revisar recibo y artefactos antes de reintentar; no restaurar DEV automáticamente.');process.exitCode=1;});
}
