import { renderReviewableSchema } from './render-schema-sql.js';

const ddlFixture = 'CREATE SCHEMA "app_private";\nCREATE TABLE "app_private"."company" (id UUID);\n';

describe('preparación offline del DDL (sin ejecutar SQL)', () => {
  it('encapsula el diff bajo el owner sin recrear el esquema', () => {
    const result = renderReviewableSchema(ddlFixture);
    expect(result).toContain('BEGIN;\nSET LOCAL ROLE wc_data_owner;');
    expect(result).toContain('CREATE TABLE "app_private"."company"');
    expect(result).not.toContain('CREATE SCHEMA "app_private";');
    expect(result.endsWith('COMMIT;\n')).toBe(true);
  });
  it('elimina también la declaración condicional emitida por Prisma', () => {
    expect(renderReviewableSchema(ddlFixture.replace('CREATE SCHEMA', 'CREATE SCHEMA IF NOT EXISTS')))
      .not.toContain('CREATE SCHEMA IF NOT EXISTS');
  });
  it('es determinista para revisar drift sin una base de datos', () => {
    expect(renderReviewableSchema(ddlFixture)).toBe(renderReviewableSchema(ddlFixture));
  });
  it.each(['DROP TABLE app_private.company;', 'DROP SCHEMA app_private;', 'TRUNCATE app_private.company;'])(
    'rechaza una operación destructiva inesperada: %s', (statement) => {
    expect(() => renderReviewableSchema(`${ddlFixture}\n${statement}`)).toThrow(/destructiva/);
  });
  it('rechaza una salida que no corresponde a la empresa privada', () => {
    expect(() => renderReviewableSchema('CREATE TABLE public.other (id UUID);')).toThrow(/modelo privado/);
  });
});
