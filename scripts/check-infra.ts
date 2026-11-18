import { checkInfrastructure } from './check-infra-core.js';
import { loadLocalEnvironment, validateLocalConfig } from './local-config.js';
import { fileURLToPath } from 'node:url';

// Límite final del CLI: aun si un driver no puede cerrar, el proceso aislado termina.
const watchdog = setTimeout(() => {
  console.error('check:infra agotó el límite global; conexiones del proceso serán cerradas.');
  process.exit(1);
}, 25000);
try {
  const env = loadLocalEnvironment(fileURLToPath(new URL('../.env', import.meta.url)));
  validateLocalConfig(env);
  // Importación dinámica dentro del límite sanitizado: incluye fallo de cliente no generado.
  const { postgresProbe, redisProbe } = await import('./infra-probes.js');
  const ok = await checkInfrastructure(env, { postgres: postgresProbe, redis: redisProbe }, console.log);
  process.exitCode = ok ? 0 : 1;
} catch {
  console.error('check:infra falló: revise .env, dependencias y prisma:generate. Detalles omitidos.');
  process.exitCode = 1;
} finally {
  // El watchdog queda armado en fallo por cierre bloqueado; no mantiene vivo el proceso normal.
  watchdog.unref();
}
