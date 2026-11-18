import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Contrato de archivos, no un parser PostgreSQL ni una prueba de aislamiento. */
export const persistenceTables = {
  Company: 'company',
  User: 'app_user',
  Membership: 'membership',
  Branch: 'branch',
  PlatformAdmin: 'platform_admin',
  Invitation: 'invitation',
  Session: 'app_session',
  RefreshTokenHistory: 'refresh_token_history',
  InvitationOutbox: 'invitation_outbox',
  InvitationEmission: 'invitation_emission',
} as const;

export const persistenceSqlFiles = [
  '000_roles.sql', '001_schema.sql', '002_constraints.sql', '003_rls.sql',
] as const;

export interface PersistenceArtifacts {
  schema: string;
  sql: Record<(typeof persistenceSqlFiles)[number], string>;
}

/** Solo lee los archivos públicos de esta entrega; no carga .env ni abre conexiones. */
export function loadPersistenceArtifacts(
  prismaDirectory = fileURLToPath(new URL('../prisma/', import.meta.url)),
): PersistenceArtifacts {
  try {
    return {
      schema: readFileSync(join(prismaDirectory, 'schema.prisma'), 'utf8'),
      sql: {
        '000_roles.sql': readFileSync(join(prismaDirectory, 'sql/000_roles.sql'), 'utf8'),
        '001_schema.sql': readFileSync(join(prismaDirectory, 'sql/001_schema.sql'), 'utf8'),
        '002_constraints.sql': readFileSync(join(prismaDirectory, 'sql/002_constraints.sql'), 'utf8'),
        '003_rls.sql': readFileSync(join(prismaDirectory, 'sql/003_rls.sql'), 'utf8'),
      },
    };
  } catch {
    throw new Error('No se pudieron leer los artefactos públicos de persistencia. Revise prisma/ y prisma/sql/.');
  }
}

function withoutComments(sql: string): string {
  // Es una comprobación léxica de los archivos controlados, no un analizador SQL.
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\r\n]*/g, '');
}

export function inspectPersistenceArtifacts(artifacts: PersistenceArtifacts): string[] {
  const issues: string[] = [];
  const models = new Map(
    [...artifacts.schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)]
      .map((match) => [match[1] ?? '', match[2] ?? '']),
  );
  if (models.size !== Object.keys(persistenceTables).length) {
    issues.push('El esquema debe contener exactamente las diez entidades de esta entrega.');
  }
  const ddl = withoutComments(artifacts.sql['001_schema.sql']);
  const constraints = withoutComments(artifacts.sql['002_constraints.sql']);
  const roles = withoutComments(artifacts.sql['000_roles.sql']);
  const security = withoutComments(artifacts.sql['003_rls.sql']);

  for (const [model, table] of Object.entries(persistenceTables)) {
    const body = models.get(model) ?? '';
    if (!body.includes(`@@map("${table}")`) || !body.includes('@@schema("app_private")')) {
      issues.push(`${model}: falta el mapeo explícito al esquema privado aprobado.`);
    }
    if (!ddl.includes(`CREATE TABLE "app_private"."${table}"`)) {
      issues.push(`${model}: falta la tabla correspondiente en el DDL revisable.`);
    }
    const reference = `(?:"app_private"|app_private)\\.(?:"${table}"|${table})`;
    for (const operation of ['OWNER\\s+TO\\s+wc_data_owner', 'ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY', 'FORCE\\s+ROW\\s+LEVEL\\s+SECURITY']) {
      if (!new RegExp(`ALTER\\s+TABLE\\s+${reference}\\s+${operation}\\s*;`, 'i').test(security)) {
        issues.push(`${model}: falta ownership o configuración RLS explícita por tabla.`);
      }
    }
    const policy = security.match(new RegExp(`CREATE\\s+POLICY\\s+"?deny_runtime_all"?\\s+ON\\s+${reference}\\s+([^;]*);`, 'i'))?.[1] ?? '';
    if (!/AS\s+RESTRICTIVE/i.test(policy) || !/USING\s*\(\s*false\s*\)/i.test(policy)
      || !/WITH\s+CHECK\s*\(\s*false\s*\)/i.test(policy)
      || ['wc_identity', 'wc_tenant', 'wc_platform', 'wc_delivery'].some((role) => !policy.includes(role))
      || /\bPUBLIC\b/i.test(policy)) {
      issues.push(`${model}: falta la política restrictiva de denegación específica de runtimes.`);
    }
  }

  for (const role of ['wc_data_owner', 'wc_identity', 'wc_tenant', 'wc_platform', 'wc_delivery']) {
    const statement = roles.match(new RegExp(`CREATE\\s+ROLE\\s+"?${role}"?\\b([^;]*);`, 'i'))?.[1] ?? '';
    for (const flag of ['NOLOGIN', 'NOSUPERUSER', 'NOCREATEDB', 'NOCREATEROLE', 'NOREPLICATION', 'NOBYPASSRLS', 'NOINHERIT']) {
      if (!new RegExp(`\\b${flag}\\b`, 'i').test(statement)) {
        issues.push(`${role}: falta ${flag} en el artefacto de aprovisionamiento no ejecutado.`);
      }
    }
  }
  if (/\b(?:PASSWORD|BYPASSRLS|SUPERUSER|CREATEDB|CREATEROLE|REPLICATION|LOGIN)\b/i.test(roles)) {
    issues.push('Los roles preparados no deben incluir secretos, login habilitado ni privilegios elevados.');
  }
  for (const sql of [roles, ddl, constraints, security]) {
    if (/\bDROP\s+(?:TABLE|SCHEMA|DATABASE|ROLE)\b|(?:^|;)\s*TRUNCATE\b|\bALTER\s+SYSTEM\b|\bCOPY\b[\s\S]*?\bPROGRAM\b/i.test(sql)) {
      issues.push('La entrega no admite borrados destructivos o ejecución externa en SQL.');
    }
  }
  if (/\bGRANT\s+[^;]*\b(?:ALL|SELECT|INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(security)) {
    issues.push('La base cerrada por defecto no concede acceso directo a tablas al runtime.');
  }
  if (/\bGRANT\s+"?wc_data_owner"?\s+TO\b/i.test(`${roles}\n${security}`)) {
    issues.push('No conceder el rol propietario al runtime en esta entrega.');
  }
  if (/\bUSING\s*\(\s*true\s*\)|\bWITH\s+CHECK\s*\(\s*true\s*\)/i.test(security)) {
    issues.push('La base RLS de esta entrega no incluye políticas de acceso general.');
  }
  if (!/ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(security)
    || !/FORCE\s+ROW\s+LEVEL\s+SECURITY/i.test(security)
    || !/USING\s*\(\s*false\s*\)/i.test(security)
    || !/WITH\s+CHECK\s*\(\s*false\s*\)/i.test(security)) {
    issues.push('Falta la configuración RLS cerrada por defecto, ENABLE/FORCE y condiciones de denegación.');
  }
  if (!/\bCHECK\s*\(/i.test(constraints) || !/DEFERRABLE\s+INITIALLY\s+DEFERRED/i.test(constraints)) {
    issues.push('Faltan CHECK y la relación diferible de la generación actual de refresh.');
  }
  return issues;
}
