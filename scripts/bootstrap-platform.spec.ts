import { jest } from '@jest/globals';
import type { Client } from 'pg';
import { adminUser, database } from './auth-local-core.js';
import { BootstrapError, bootstrapFailureMessage, bootstrapPlatform, inputDisplay } from './bootstrap-platform.js';

describe('bootstrap con cliente SIMULADO, sin cuenta real', () => {
  const checksum = '0'.repeat(64);
  function fixture(exists: boolean) {
    const statements: string[] = [];
    const query = jest.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes('current_database()')) return { rows: [{ db: database, usr: adminUser, super: true, port: 5432, version: 170000 }], rowCount: 1 };
      if (sql.includes("nspname='wc_ops'")) return { rows: [{ owner: adminUser }], rowCount: 1 };
      if (sql.includes('FROM wc_ops.receipt')) return { rows: [{ checksum, owner: adminUser }], rowCount: 1 };
      if (sql.includes('SELECT 1 FROM app_private.platform_admin')) return { rows: exists ? [{}] : [], rowCount: exists ? 1 : 0 };
      return { rows: [], rowCount: 0 };
    });
    return { statements, client: { query } as unknown as Client };
  }
  it('serializa, crea solo identidad/plataforma y confirma; no crea empresa/pertenencia', async () => {
    const { statements, client } = fixture(false);
    await bootstrapPlatform(client, 'fixture@example.test', 'SyntheticPasswordForTest!', checksum);
    expect(statements.includes('COMMIT')).toBe(true);
    expect(statements.some(sql => sql.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(statements.some(sql => sql.startsWith('INSERT INTO app_private.app_user'))).toBe(true);
    expect(statements.some(sql => sql.startsWith('INSERT INTO app_private.platform_admin'))).toBe(true);
    expect(statements.some(sql => sql.includes('INSERT INTO app_private.company') || sql.includes('INSERT INTO app_private.membership'))).toBe(false);
  });
  it('rechaza un administrador/correo existente sin promover ni sobrescribir', async () => {
    const { statements, client } = fixture(true);
    await expect(bootstrapPlatform(client, 'fixture@example.test', 'SyntheticPasswordForTest!', checksum)).rejects.toThrow('ADMIN_EXISTS');
    expect(statements.includes('ROLLBACK')).toBe(true);
    expect(statements.some(sql => sql.startsWith('INSERT'))).toBe(false);
    expect(statements.includes('COMMIT')).toBe(false);
  });
  it('muestra correo y solo asteriscos para contraseña, contando puntos de código', () => {
    expect(inputDisplay('fixture@example.test', false)).toBe('fixture@example.test');
    const value = 'A!contraseña😀';
    expect(inputDisplay(value, true)).toBe('*'.repeat([...value].length));
    expect(inputDisplay(value, true).includes(value)).toBe(false);
    expect(inputDisplay('', true)).toBe('');
    expect(inputDisplay('Abc1234567890!x', true)).toBe('*'.repeat(15));
  });
  it('distingue fallos de validación sin incluir credenciales ni errores crudos', async () => {
    const { client, statements } = fixture(false);
    await expect(bootstrapPlatform(client, 'invalid', 'SyntheticPasswordForTest!', checksum)).rejects.toThrow('EMAIL_INVALID');
    await expect(bootstrapPlatform(client, 'fixture@example.test', 'short', checksum)).rejects.toThrow('PASSWORD_POLICY');
    expect(statements.length).toBe(0);
    expect(bootstrapFailureMessage(new BootstrapError('PASSWORD_MISMATCH'))).toContain('no coinciden');
    expect(bootstrapFailureMessage(new BootstrapError('PASSWORD_POLICY'))).toContain('admite números');
    expect(bootstrapFailureMessage(new Error('private-driver-detail'))).not.toContain('private-driver-detail');
  });
});
