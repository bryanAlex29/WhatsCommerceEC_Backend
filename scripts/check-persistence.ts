import { inspectPersistenceArtifacts, loadPersistenceArtifacts } from './persistence-artifacts.js';

try {
  const issues = inspectPersistenceArtifacts(loadPersistenceArtifacts());
  for (const issue of issues) console.error(issue);
  if (issues.length > 0) process.exitCode = 1;
  else {
    console.log('OK: contrato estático de diez modelos y cuatro artefactos SQL.');
    console.log('Sin conexión ni SQL ejecutado. No acredita sintaxis PostgreSQL, RLS efectivo ni operaciones de negocio.');
  }
} catch {
  console.error('No se pudo revisar la entrega de persistencia. Revise los archivos públicos de prisma/ y prisma/sql/.');
  process.exitCode = 1;
}
