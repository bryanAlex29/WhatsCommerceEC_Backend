import { execFileSync } from 'node:child_process';
import { loadLocalEnvironment, validateLocalConfig } from './local-config.js';
import { localComposeBaseArgs } from './infra-compose-core.js';
import { fileURLToPath } from 'node:url';

try {
  const directory = fileURLToPath(new URL('../', import.meta.url));
  const env = loadLocalEnvironment(fileURLToPath(new URL('../.env', import.meta.url)));
  validateLocalConfig(env);
  const options = { cwd: directory, env, encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'], timeout: 180000 };
  // No operar accidentalmente sobre Docker remoto desde una herramienta local.
  // DOCKER_CONTEXT tiene precedencia sobre DOCKER_HOST, igual que en el CLI.
  const inspectContext = () => execFileSync('docker', [
    'context', 'inspect', ...(env.DOCKER_CONTEXT ? [env.DOCKER_CONTEXT] : []), '--format', '{{.Endpoints.docker.Host}}',
  ], { ...options, timeout: 10000 }).trim();
  const endpoint = env.DOCKER_CONTEXT ? inspectContext() : env.DOCKER_HOST || inspectContext();
  if (!endpoint.startsWith('npipe://') && !endpoint.startsWith('unix://')) throw new Error();
  const command = process.argv[2];
  const composeArgs = localComposeBaseArgs(directory);
  if (command === 'up') {
    // --wait requiere Compose v2 moderno; no fallback que oculte un fallo real.
    const help = execFileSync('docker', [...composeArgs, 'up', '--help'], options);
    if (!help.includes('--wait')) throw new Error();
    execFileSync('docker', [...composeArgs, 'up', '-d', '--wait', '--wait-timeout', '120'], options);
    console.log('Infraestructura DEV local iniciada y saludable según Compose. Ejecute check:infra.');
  } else if (command === 'status') {
    console.log(execFileSync('docker', [...composeArgs, 'ps'], options).trim());
  } else throw new Error();
} catch {
  console.error('infra: fallo sanitizado. Revise configuración DEV, Docker Desktop/Engine local y Compose v2 con --wait. Consulte README.');
  process.exitCode = 1;
}
