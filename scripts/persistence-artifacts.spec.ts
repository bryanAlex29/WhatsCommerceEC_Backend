import {
  inspectPersistenceArtifacts, loadPersistenceArtifacts, persistenceSqlFiles, persistenceTables,
  type PersistenceArtifacts,
} from './persistence-artifacts.js';

// Fixtures léxicos deliberadamente mínimos; no son SQL aplicado ni Prisma validado.
function fixture(): PersistenceArtifacts {
  const schema = Object.entries(persistenceTables).map(([model, table]) =>
    `model ${model} {\n  @@map("${table}")\n  @@schema("app_private")\n}`).join('\n');
  const roleNames = ['wc_data_owner', 'wc_identity', 'wc_tenant', 'wc_platform', 'wc_delivery'];
  return {
    schema,
    sql: {
      '000_roles.sql': roleNames.map((role) => `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;`).join('\n'),
      '001_schema.sql': Object.values(persistenceTables).map((table) => `CREATE TABLE "app_private"."${table}" (id uuid);`).join('\n'),
      '002_constraints.sql': 'CHECK (generation > 0); DEFERRABLE INITIALLY DEFERRED;',
      '003_rls.sql': Object.values(persistenceTables).map((table) => `
        ALTER TABLE app_private.${table} OWNER TO wc_data_owner;
        ALTER TABLE app_private.${table} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE app_private.${table} FORCE ROW LEVEL SECURITY;
        CREATE POLICY deny_runtime_all ON app_private.${table}
          AS RESTRICTIVE FOR ALL TO wc_identity, wc_tenant, wc_platform, wc_delivery
          USING (false) WITH CHECK (false);`).join('\n'),
    },
  };
}

describe('contrato estático de persistencia (sin DB)', () => {
  it('fija diez modelos y cuatro archivos revisables', () => {
    expect(Object.keys(persistenceTables)).toHaveLength(10);
    expect(persistenceSqlFiles).toHaveLength(4);
  });
  it('acepta el fixture de tokens esperados sin afirmar validez SQL', () => {
    expect(inspectPersistenceArtifacts(fixture())).toEqual([]);
  });
  it('comprueba los archivos reales preparados, sin ejecutarlos', () => {
    expect(inspectPersistenceArtifacts(loadPersistenceArtifacts())).toEqual([]);
  });
  it('rechaza entidades adicionales no aprobadas', () => {
    const input = fixture();
    input.schema += '\nmodel Extra {\n  id String\n}';
    expect(inspectPersistenceArtifacts(input)).not.toEqual([]);
  });
  it('detecta un modelo sin aislamiento de namespace', () => {
    const input = fixture();
    input.schema = input.schema.replace('@@schema("app_private")', '@@schema("public")');
    expect(inspectPersistenceArtifacts(input)).toContain('Company: falta el mapeo explícito al esquema privado aprobado.');
  });
  it('detecta una tabla omitida en el DDL', () => {
    const input = fixture();
    input.sql['001_schema.sql'] = input.sql['001_schema.sql'].replace('CREATE TABLE "app_private"."company"', 'CREATE TABLE "other"."company"');
    expect(inspectPersistenceArtifacts(input)).toContain('Company: falta la tabla correspondiente en el DDL revisable.');
  });
  it.each(['LOGIN', 'SUPERUSER', 'BYPASSRLS'])('detecta privilegio no preparado: %s', (flag) => {
    const input = fixture();
    input.sql['000_roles.sql'] += `\nALTER ROLE wc_tenant ${flag};`;
    expect(inspectPersistenceArtifacts(input)).toContain('Los roles preparados no deben incluir secretos, login habilitado ni privilegios elevados.');
  });
  it('detecta una contraseña en el archivo público', () => {
    const input = fixture();
    input.sql['000_roles.sql'] += '\nPASSWORD NULL;';
    expect(inspectPersistenceArtifacts(input)).not.toEqual([]);
  });
  it('detecta grant directo en la etapa cerrada por defecto', () => {
    const input = fixture();
    input.sql['003_rls.sql'] += '\nGRANT SELECT ON app_private.company TO wc_tenant;';
    expect(inspectPersistenceArtifacts(input)).not.toEqual([]);
  });
  it('detecta políticas abiertas en esta base inicial', () => {
    const input = fixture();
    input.sql['003_rls.sql'] += '\nUSING (true);';
    expect(inspectPersistenceArtifacts(input)).not.toEqual([]);
  });
  it('detecta membresía al propietario', () => {
    const input = fixture();
    input.sql['000_roles.sql'] += '\nGRANT wc_data_owner TO wc_tenant;';
    expect(inspectPersistenceArtifacts(input)).not.toEqual([]);
  });
  it('detecta falta de FORCE RLS', () => {
    const input = fixture();
    input.sql['003_rls.sql'] = input.sql['003_rls.sql'].replace('ALTER TABLE app_private.company FORCE ROW LEVEL SECURITY;', '');
    expect(inspectPersistenceArtifacts(input)).not.toEqual([]);
  });
  it('no extiende la política restrictiva a todos los futuros propietarios internos', () => {
    const input = fixture();
    input.sql['003_rls.sql'] = input.sql['003_rls.sql'].replace('TO wc_identity, wc_tenant, wc_platform, wc_delivery', 'TO PUBLIC');
    expect(inspectPersistenceArtifacts(input)).not.toEqual([]);
  });
  it('detecta falta de diferibilidad', () => {
    const input = fixture();
    input.sql['002_constraints.sql'] = 'CHECK (generation > 0);';
    expect(inspectPersistenceArtifacts(input)).not.toEqual([]);
  });
  it('detecta borrado de tablas', () => {
    const input = fixture();
    input.sql['001_schema.sql'] += '\nDROP TABLE app_private.company;';
    expect(inspectPersistenceArtifacts(input)).not.toEqual([]);
  });
  it('no toma comentarios explicativos por sentencias ejecutables', () => {
    const input = fixture();
    input.sql['000_roles.sql'] += '\n-- LOGIN y PASSWORD quedan fuera de esta entrega\n/* SUPERUSER no permitido */';
    expect(inspectPersistenceArtifacts(input)).toEqual([]);
  });
});
