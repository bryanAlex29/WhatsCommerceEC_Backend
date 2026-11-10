import { environmentFiles } from './environment-files.js';

describe('selección de perfiles sin leer valores privados', () => {
  it('tests no cargan configuración operativa', () => {
    expect(environmentFiles('test', true)).toEqual([]);
    expect(environmentFiles('test', false)).toEqual([]);
  });
  it('DEV autenticado no hereda el archivo bootstrap administrativo', () => {
    const files = environmentFiles('development', true, false, false);
    expect(files).toHaveLength(1);
    expect(files[0]?.endsWith('.env.auth-dev')).toBe(true);
    expect(files.some(file => file.endsWith('.env.auth-admin') || file.endsWith('/.env'))).toBe(false);
  });
  it('overlay de recuperación separado y nunca administrativo', () => {
    const files = environmentFiles('development', true, true, false);
    expect(files.map(file => file.split(/[\\/]/).pop())).toEqual(['.env.recovery-dev', '.env.auth-dev']);
    expect(environmentFiles('production', true, true)).toHaveLength(1);
  });
  it('overlay OAuth precede SMTP sin adoptar administrativo ni bootstrap', () => {
    const files = environmentFiles('development', true, true, true);
    expect(files.map(file=>file.split(/[\\/]/).pop())).toEqual(['.env.gmail-api-dev','.env.recovery-dev','.env.auth-dev']);
    expect(()=>environmentFiles('development',true,false,true)).toThrow('RECOVERY_ENABLED');
    expect(environmentFiles('test',true,true,true)).toEqual([]);
  });
  it('sin perfil conserva bootstrap y producción no adopta perfil DEV', () => {
    expect(environmentFiles('development', false)[0]?.endsWith('.env')).toBe(true);
    expect(environmentFiles('production', true)[0]?.endsWith('.env')).toBe(true);
  });
});
