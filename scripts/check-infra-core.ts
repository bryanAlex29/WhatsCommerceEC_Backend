import { validateLocalConfig, type Environment, type LocalConfig } from './local-config.js';

export interface Probe {
  check(): Promise<void>;
  close(): Promise<void>;
}
export type ProbeFactory = (config: LocalConfig) => Probe;

export async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Tiempo agotado.')), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function checkInfrastructure(
  env: Environment,
  factories: { postgres: ProbeFactory; redis: ProbeFactory },
  report: (message: string) => void,
  timeoutMs = 5000,
): Promise<boolean> {
  let config: LocalConfig;
  try {
    config = validateLocalConfig(env);
  } catch {
    report('Configuración rechazada: solo DEV local explícito, sin placeholders; revise .env y variables de shell.');
    return false;
  }
  let success = true;
  for (const name of ['postgres', 'redis'] as const) {
    let probe: Probe | undefined;
    let passed = true;
    try {
      probe = factories[name](config);
      await bounded(probe.check(), timeoutMs);
    } catch {
      passed = false;
      report(`${name}: fallo de conexión/consulta o timeout. Revise infra:status y credenciales locales; detalles omitidos.`);
    } finally {
      if (probe) {
        try {
          await bounded(probe.close(), timeoutMs);
        } catch {
          passed = false;
          report(`${name}: fallo de cierre o timeout; detalles omitidos.`);
        }
      }
    }
    if (passed) report(`${name}: OK (${name === 'postgres' ? 'Prisma SELECT 1' : 'PING/PONG'}). Conexión cerrada.`);
    success = success && passed;
  }
  return success;
}
