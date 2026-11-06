import { environmentFiles } from './environment-files.js';

describe('selección de perfiles sin leer valores privados', () => {
  it('tests no cargan configuración operativa', () => {
    expect(environmentFiles('test', true)).toEqual([]);
    expect(environmentFiles('test', false)).toEqual([]);
  });
  it('DEV autenticado no hereda el archivo bootstrap administrativo', () => {
    const files = environmentFiles('development', true);
    expect(files).toHaveLength(1);
    expect(files[0]?.endsWith('.env.auth-dev')).toBe(true);
    expect(files.some(file => file.endsWith('.env.auth-admin') || file.endsWith('/.env'))).toBe(false);
  });
  it('sin perfil conserva bootstrap y producción no adopta perfil DEV', () => {
    expect(environmentFiles('development', false)[0]?.endsWith('.env')).toBe(true);
    expect(environmentFiles('production', true)[0]?.endsWith('.env')).toBe(true);
  });
});
