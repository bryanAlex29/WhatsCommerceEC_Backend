import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../../../../prisma/sql/004_auth_context.sql', import.meta.url), 'utf8');
describe('004 controles ESTATICOS; no parsea ni ejecuta SQL ni acredita RLS', () => {
  it('owners especializados NOLOGIN, sin elevar y sin membresias runtime', () => {
    for (const owner of ['wc_identity_owner', 'wc_tenant_owner']) {
      expect(sql).toContain(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;`);
      expect(sql).toContain(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;`);
    }
    expect(sql).not.toMatch(/GRANT\s+wc_\w+_owner\s+TO/i);
    expect(sql).not.toMatch(/\bALTER ROLE\b|\bLOGIN PASSWORD\b|\bBYPASSRLS\s*;/i);
    expect(sql).not.toContain('TO PUBLIC USING');
  });
  it('runtime recibe funciones individuales, no tablas ni SELECT/DML general', () => {
    const grants = sql.match(/GRANT[^;]+;/g) ?? [];
    for (const grant of grants) {
      if (/TO wc_identity;|TO wc_tenant;/.test(grant)) expect(grant).toContain('EXECUTE ON FUNCTION');
    }
    expect(sql).not.toMatch(/GRANT.*ALL FUNCTIONS/i);
    expect(sql).not.toMatch(/EXECUTE\s+format\s*\(|EXECUTE\s+['"]/i);
  });
  it('todas las funciones fijan search_path seguro y no hay SQL dinamico', () => {
    const functions = sql.match(/CREATE FUNCTION[\s\S]*?AS \$\$/g) ?? [];
    expect(functions).toHaveLength(12);
    for (const fn of functions) expect(fn).toContain('SET search_path = pg_catalog, pg_temp');
    expect(sql).toContain("pg_catalog.current_setting('wc.tx_marker', true) = pg_catalog.txid_current()::text");
  });
  it('tenant conserva orden Company -> Session -> Membership y estado despues de pertenencia', () => {
    const tenant = sql.slice(sql.indexOf('CREATE FUNCTION app_api.tenant_company'));
    const company = tenant.indexOf('FROM app_private.company WHERE id = cid FOR SHARE');
    const session = tenant.indexOf('FROM app_private.app_session WHERE id = sid FOR SHARE');
    const membership = tenant.indexOf('FROM app_private.membership WHERE user_id = uid AND company_id = cid FOR SHARE');
    expect(company).toBeGreaterThan(0); expect(session).toBeGreaterThan(company); expect(membership).toBeGreaterThan(session);
    expect(tenant.indexOf("IF c.status = 'SUSPENDED'")).toBeGreaterThan(membership);
    const basic = tenant.slice(tenant.indexOf("IF m.role = 'SELLER'"), tenant.indexOf("ELSIF m.role = 'COMPANY_ADMIN'"));
    expect(basic).not.toMatch(/legalName|ruc|contactEmail|taxAddress/);
  });
  it('reutilizacion devuelve resultado sin raise y conserva historial; pagina LIMIT20 mas EXISTS', () => {
    const reused = sql.slice(sql.indexOf('IF h.generation <>'), sql.indexOf('next_generation := s.'));
    expect(reused).toContain("revocation_reason = 'REFRESH_REUSE'");
    expect(reused).toContain("RETURN pg_catalog.jsonb_build_object('code','SESSION_REVOKED')");
    expect(reused).not.toMatch(/^\s*RAISE/m);
    expect(sql).not.toMatch(/DELETE FROM|TRUNCATE TABLE|LIMIT 21/i);
    expect(sql).toContain('ORDER BY m.created_at ASC,m.id ASC LIMIT 20');
    expect(sql).toContain("'hasMore',EXISTS");
  });
});
