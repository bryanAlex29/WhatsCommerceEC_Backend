import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { checkReceipt, gate, sqlBundle, unwrapSql, verifyAdmin, validateDatabaseUrl, loadProfiles } from './auth-local-core.js';
import { recoveryConfig } from './recovery-config.js';
import { consoleInput } from './bootstrap-platform.js';

async function main() {
  if (process.argv.length !== 2 || !process.stdin.isTTY || !process.stdout.isTTY) throw new Error();
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { config } = recoveryConfig(root);
  const profiles = loadProfiles(root);
  const sql = readFileSync(new URL('../prisma/sql/005_password_recovery.sql', import.meta.url), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  const delivery = validateDatabaseUrl(config.RECOVERY_DELIVERY_DATABASE_URL, 'wc_delivery');
  console.log('Aplicará SOLO SQL005 en DEV aislado; conservará cuentas y datos. Detén primero API y worker. No envía correo.');
  gate(await consoleInput('Escribe APLICAR RECUPERACION DEV para confirmar: ', false) === 'APLICAR RECUPERACION DEV');
  const client = new Client({ connectionString: profiles.admin.AUTH_DEV_ADMIN_URL, connectionTimeoutMillis: 5000 });
  try {
    await client.connect(); await verifyAdmin(client);
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock(174013,1)');
      gate(await checkReceipt(client, sqlBundle(root).checksum));
      await client.query('CREATE TABLE IF NOT EXISTS wc_ops.recovery_receipt(checksum text NOT NULL); REVOKE ALL ON wc_ops.recovery_receipt FROM PUBLIC;');
      const receipt = await client.query<{ checksum: string }>('SELECT checksum FROM wc_ops.recovery_receipt');
      if (receipt.rowCount) gate(receipt.rowCount === 1 && receipt.rows[0]?.checksum === checksum);
      else {
        const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname='wc_recovery_owner' UNION ALL SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app_private' AND c.relname='password_recovery'");
        gate(existing.rowCount === 0);
        await client.query(unwrapSql(sql));
        await client.query('RESET ROLE');
        await client.query('INSERT INTO wc_ops.recovery_receipt(checksum) VALUES ($1)', [checksum]);
      }
      const memberships = await client.query("SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='wc_delivery')");
      gate(memberships.rowCount === 0);
      const formatted = await client.query<{ sql: string }>("SELECT format('ALTER ROLE wc_delivery LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT PASSWORD %L',$1::text) sql", [delivery.password]);
      await client.query(formatted.rows[0]!.sql);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  } finally { await client.end().catch(() => undefined); }
  console.log('RECOVERY_DEV_SQL_OK. No prueba SMTP ni entrega.');
}
await main().catch(() => { console.error('RECOVERY_APPLY_FAILED. Sin detalles privados; revisa recibos y precondiciones.'); process.exitCode = 1; });
