import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateProfiles, loadProfiles, sqlBundle, unwrapSql, validateProfiles } from './auth-local-core.js';

describe('herramientas auth DEV sin Docker/SQL ejecutado', () => {
  it('genera perfiles aislados y seis secretos independientes sin mostrarlos', () => {
    const profiles = generateProfiles();
    expect(validateProfiles(profiles) === profiles).toBe(true);
    expect(profiles.runtime.AUTH_IDENTITY_DATABASE_URL?.includes('@127.0.0.1:55432/')).toBe(true);
    expect(profiles.runtime.REDIS_URL).toBe('redis://127.0.0.1:16379');
    const bad = generateProfiles();
    bad.runtime.AUTH_CURSOR_KEY = bad.runtime.AUTH_JWT_KEY!;
    expect(() => validateProfiles(bad)).toThrow('AUTH_DEV_SAFETY_CHECK');
  });
  it('preserva perfiles existentes byte por byte y rechaza un par parcial', () => {
    const directory = mkdtempSync(fileURLToPath(new URL('../node_modules/.auth-local-tests-', import.meta.url)));
    try {
      loadProfiles(directory, true);
      const admin = readFileSync(join(directory, '.env.auth-admin'));
      const runtime = readFileSync(join(directory, '.env.auth-dev'));
      loadProfiles(directory, true);
      expect(readFileSync(join(directory, '.env.auth-admin')).equals(admin)).toBe(true);
      expect(readFileSync(join(directory, '.env.auth-dev')).equals(runtime)).toBe(true);
      writeFileSync(join(directory, '.env.auth-dev'), 'INVALID=true');
      expect(() => loadProfiles(directory)).toThrow();
    } finally { rmSync(directory, { recursive: true }); } // Solo fixture creado por este test.
  });
  it('desenvuelve transacciones sin contar BEGIN/COMMIT en funciones o comentarios', () => {
    const sql = '-- BEGIN;\nBEGIN;\nCREATE FUNCTION demo() RETURNS void AS $$ BEGIN PERFORM 1; END; $$ LANGUAGE plpgsql;\nCOMMIT;';
    const body = unwrapSql(sql);
    expect(body.includes('CREATE FUNCTION')).toBe(true);
    expect(body.includes('$$ BEGIN PERFORM 1; END; $$')).toBe(true);
    expect(() => unwrapSql('BEGIN; SELECT 1; COMMIT; BEGIN; COMMIT;')).toThrow();
  });
  it('prepara los cinco archivos revisados bajo una transacción externa', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const bundle = sqlBundle(root);
    expect(bundle.bodies).toHaveLength(5);
    expect(bundle.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});
