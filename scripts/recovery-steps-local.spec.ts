import { projectionSql } from './recovery-steps-local.js';
import { profileFiles, validateSource } from './recovery-dev-preflight.js';
import { fileURLToPath } from 'node:url';
describe('comparación SQL008 sin conectar DEV',()=>{
  it('incluye respaldo de Empresas y rechaza origen implícito del propio worktree',()=>{
    expect(profileFiles).toContain('.env.companies-dev');
    expect(()=>validateSource(fileURLToPath(new URL('../',import.meta.url)))).toThrow();
  });
  it('proyecta solo columnas previas, no las añadidas',()=>{
    const sql=projectionSql({schema:'app_private',table:'password_recovery',columns:['id','code_mac']});
    expect(sql).toContain('SELECT "id","code_mac" FROM');
    expect(sql).not.toContain('reset_token_hash');
  });
  it('rechaza identificadores inyectados y proyecciones vacías',()=>{
    expect(()=>projectionSql({schema:'app_private',table:'x;drop',columns:['id']})).toThrow();
    expect(()=>projectionSql({schema:'app_private',table:'x',columns:[]})).toThrow();
  });
});
