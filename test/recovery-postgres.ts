/** PostgreSQL real desechable, sin puertos/volúmenes ni acceso a perfiles existentes. */
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { hashPassword } from '../src/modules/auth/crypto.js';
import { RecoveryCrypto } from '../src/modules/auth/recovery.js';

const name = `wc-recovery-test-${randomUUID().slice(0,8)}`;
const uid = randomUUID(); const rid = randomUUID(); const sid = randomUUID();
const email = 'synthetic-recovery@example.test';
const crypto = new RecoveryCrypto(randomBytes(32), randomBytes(32));
const oldHash = await hashPassword('SyntheticOriginal!'); const newHash = await hashPassword('SyntheticReplacement!');
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
const run = (sql: string) => execFileSync('docker', ['exec','-i',name,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres'], { input: sql, encoding: 'utf8', stdio: ['pipe','pipe','pipe'], timeout: 30000 }).trim();
const execAsync = promisify(execFile);
async function concurrentReset(code: string) {
  const sql = `BEGIN; SET LOCAL ROLE wc_identity; SET LOCAL wc.operation='recovery_reset'; SET LOCAL wc.user_id=''; SET LOCAL wc.session_id=''; SET LOCAL wc.company_id=''; DO $$ BEGIN PERFORM set_config('wc.tx_marker',txid_current()::text,true); END $$; SELECT app_api.recovery_reset(${quote(email)},${quote(crypto.mac(email,code))},${quote(newHash)}); COMMIT;`;
  const result = await execAsync('docker',['exec',name,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-c',sql], { timeout:30000 });
  return JSON.parse(result.stdout.trim()) as {code:string};
}
function scoped(role: string, op: string, sql: string, user = '', session = '') {
  return run(`BEGIN; SET LOCAL ROLE ${role}; SET LOCAL wc.operation=${quote(op)}; SET LOCAL wc.user_id=${quote(user)}; SET LOCAL wc.session_id=${quote(session)}; SET LOCAL wc.company_id=''; DO $$ BEGIN PERFORM set_config('wc.tx_marker',txid_current()::text,true); END $$; ${sql}; COMMIT;`);
}
const request = (id: string, code: string) => {
  const sealed = crypto.seal(id,email,code);
  return JSON.parse(scoped('wc_identity','recovery_request',`SELECT app_api.recovery_request(${quote(email)},${quote(id)},${quote(crypto.mac(email,code))},${quote(sealed.payload)},${quote(sealed.nonce)},${quote(sealed.tag)})`)) as { code: string };
};
const reset = (code: string) => JSON.parse(scoped('wc_identity','recovery_reset',`SELECT app_api.recovery_reset(${quote(email)},${quote(crypto.mac(email,code))},${quote(newHash)})`)) as { code: string };
let started = false; let count = 0;
const check = (condition: unknown) => { assert.ok(condition); count++; };
try {
  execFileSync('docker',['run','--rm','-d','--network','none','--name',name,'-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:17-alpine'], { stdio: ['ignore','pipe','pipe'], timeout: 120000 }); started = true;
  let ready = false;
  for (let attempt=0; attempt<60; attempt++) {
    try { ready = run('SELECT 1') === '1'; if (ready) break; } catch { /* Solo contenedor desechable, sin datos externos. */ }
    await setTimeout(250);
  }
  assert.ok(ready);
  for (const file of ['000_roles.sql','001_schema.sql','002_constraints.sql','003_rls.sql','004_auth_context.sql','005_password_recovery.sql','006_companies.sql']) run(readFileSync(new URL(`../prisma/sql/${file}`,import.meta.url),'utf8'));
  run(`INSERT INTO app_private.app_user(id,email_normalized,password_hash) VALUES(${quote(uid)},${quote(email)},${quote(oldHash)})`);
  const session = JSON.parse(scoped('wc_identity','create_session',`SELECT app_api.identity_create_session_checked(${quote(uid)},${quote(sid)},${quote(randomUUID())},${quote('a'.repeat(64))},${quote(oldHash)})`,uid,sid)) as { code: string };
  check(session.code === 'OK');
  const secondSid=randomUUID(); const otherUid=randomUUID(); const otherSid=randomUUID();
  scoped('wc_identity','create_session',`SELECT app_api.identity_create_session_checked(${quote(uid)},${quote(secondSid)},${quote(randomUUID())},${quote('c'.repeat(64))},${quote(oldHash)})`,uid,secondSid);
  run(`INSERT INTO app_private.app_user(id,email_normalized,password_hash) VALUES(${quote(otherUid)},'other-synthetic@example.test',${quote(oldHash)})`);
  scoped('wc_identity','create_session',`SELECT app_api.identity_create_session_checked(${quote(otherUid)},${quote(otherSid)},${quote(randomUUID())},${quote('d'.repeat(64))},${quote(oldHash)})`,otherUid,otherSid);
  check(request(rid,'00001234').code === 'OK');
  check(run(`SELECT encode(code_mac,'hex') FROM app_private.password_recovery WHERE id=${quote(rid)}`) === crypto.mac(email,'00001234'));
  check(reset('99999999').code === 'INVALID_RECOVERY_CODE');
  check(run(`SELECT verification_attempts FROM app_private.password_recovery WHERE id=${quote(rid)}`) === '1');
  for (let i=0;i<4;i++) reset('99999999');
  check(reset('00001234').code === 'INVALID_RECOVERY_CODE');
  check(run(`SELECT password_hash FROM app_private.app_user WHERE id=${quote(uid)}`) === oldHash);
  const second = randomUUID(); request(second,'00005678');
  check(reset('00001234').code === 'INVALID_RECOVERY_CODE');
  const lease = randomUUID();
  const claimed = JSON.parse(scoped('wc_delivery','recovery_claim',`SELECT app_api.recovery_claim(${quote(second)},${quote(lease)})`));
  check(crypto.open(second,claimed).code === '00005678');
  check(scoped('wc_delivery','recovery_claim',`SELECT app_api.recovery_claim(${quote(second)},${quote(randomUUID())})`) === '');
  check(reset('00005678').code === 'OK');
  check(run(`SELECT password_hash FROM app_private.app_user WHERE id=${quote(uid)}`) === newHash);
  check(run(`SELECT revocation_reason FROM app_private.app_session WHERE id=${quote(sid)}`) === 'PASSWORD_RECOVERY');
  check(run(`SELECT count(*) FROM app_private.app_session WHERE user_id=${quote(uid)} AND revoked_at IS NOT NULL`) === '2');
  check(run(`SELECT revoked_at IS NULL FROM app_private.app_session WHERE id=${quote(otherSid)}`) === 't');
  check(run(`SELECT password_hash FROM app_private.app_user WHERE id=${quote(otherUid)}`) === oldHash);
  check(reset('00005678').code === 'INVALID_RECOVERY_CODE');
  scoped('wc_delivery','recovery_finish',`SELECT app_api.recovery_finish(${quote(second)},${quote(lease)},true)`);
  check(run(`SELECT state FROM app_private.password_recovery WHERE id=${quote(second)}`) === 'CANCELLED');
  const staleSid = randomUUID();
  const stale = JSON.parse(scoped('wc_identity','create_session',`SELECT app_api.identity_create_session_checked(${quote(uid)},${quote(staleSid)},${quote(randomUUID())},${quote('b'.repeat(64))},${quote(oldHash)})`,uid,staleSid));
  check(stale.code === 'INVALID_CREDENTIALS');
  check(run(`SELECT count(*) FROM app_private.app_session WHERE id=${quote(staleSid)}`) === '0');
  // SQL sin contexto y permisos directos no están habilitados para runtime.
  for (const role of ['wc_identity','wc_tenant','wc_platform','wc_delivery']) {
    const permissions = run(`SELECT has_table_privilege(${quote(role)},'app_private.password_recovery','SELECT') OR has_table_privilege(${quote(role)},'app_private.app_user','UPDATE')`);
    check(permissions === 'f');
  }
  check(run("SELECT has_function_privilege('wc_identity','app_api.identity_create_session(uuid,uuid,uuid,text)','EXECUTE')") === 'f');
  let denied = false;
  try { run(`SET ROLE wc_identity; SELECT app_api.recovery_reset(${quote(email)},${quote(crypto.mac(email,'00005678'))},${quote(newHash)})`); } catch { denied=true; }
  check(denied);
  const third = randomUUID(); request(third,'87654321');
  run(`UPDATE app_private.password_recovery SET issued_at=issued_at-interval '16 minutes',expires_at=expires_at-interval '16 minutes' WHERE id=${quote(third)}`);
  check(reset('87654321').code === 'INVALID_RECOVERY_CODE');
  scoped('wc_delivery','recovery_claim',`SELECT app_api.recovery_claim(${quote(third)},${quote(randomUUID())})`);
  check(run(`SELECT encrypted_payload IS NULL AND state='EXPIRED' FROM app_private.password_recovery WHERE id=${quote(third)}`) === 't');
  const fourth=randomUUID();request(fourth,'11112222');
  const concurrent=await Promise.all([concurrentReset('11112222'),concurrentReset('11112222')]);
  check(concurrent.filter(result=>result.code==='OK').length===1);
  check(concurrent.filter(result=>result.code==='INVALID_RECOVERY_CODE').length===1);
  const fifth=randomUUID();request(fifth,'33334444');
  await Promise.all(Array.from({length:6},()=>concurrentReset('99999999')));
  check(run(`SELECT verification_attempts FROM app_private.password_recovery WHERE id=${quote(fifth)}`)==='5');
  check(reset('33334444').code==='INVALID_RECOVERY_CODE');
  const sixth=randomUUID();request(sixth,'55556666');
  const seventh=randomUUID();request(seventh,'77778888');
  check(reset('55556666').code==='INVALID_RECOVERY_CODE');
  check(run(`SELECT encrypted_payload IS NULL AND state='CANCELLED' FROM app_private.password_recovery WHERE id=${quote(sixth)}`)==='t');
  const finalLease=randomUUID();
  check(scoped('wc_delivery','recovery_claim',`SELECT app_api.recovery_claim(${quote(sixth)},${quote(randomUUID())})`)==='');
  scoped('wc_delivery','recovery_claim',`SELECT app_api.recovery_claim(${quote(seventh)},${quote(finalLease)})`);
  scoped('wc_delivery','recovery_finish',`SELECT app_api.recovery_finish(${quote(seventh)},${quote(randomUUID())},true)`);
  check(run(`SELECT state FROM app_private.password_recovery WHERE id=${quote(seventh)}`)==='PROCESSING');
  scoped('wc_delivery','recovery_finish',`SELECT app_api.recovery_finish(${quote(seventh)},${quote(finalLease)},true)`);
  check(run(`SELECT encrypted_payload IS NULL AND state='SMTP_ACCEPTED' FROM app_private.password_recovery WHERE id=${quote(seventh)}`)==='t');
  check(reset('77778888').code==='OK');
  console.log(`RECOVERY_POSTGRES_OK ${count} comprobaciones, PostgreSQL17 desechable; sin SMTP ni datos existentes.`);
} catch { console.error('RECOVERY_POSTGRES_FAILED (sin SQL ni datos privados en salida)'); process.exitCode=1; }
finally { if (started) execFileSync('docker',['stop',name], { stdio: 'ignore', timeout: 30000 }); }
